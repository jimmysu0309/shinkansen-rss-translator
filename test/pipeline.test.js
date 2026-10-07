// 管線測試:fetch 解析、單篇翻譯、編排器。
//
// 訊號層次:
//   ✓ parseFeedXml:RSS / Atom 正規化(guid/title/content:encoded/日期)
//   ✓ processFeed 編排(注入 fake fetch/translate,offline):去重、只翻 pending、記帳、逐篇容錯、304
//   ✓ translateEntry 整合(需 key):真翻一篇含圖 HTML → 中文 + 圖片保留 + 段數相符
//   ✗ 不驗:真實網路抓取(部署驗)
import { describe, it, expect, beforeEach } from 'vitest';
import { parseFeedXml, fetchFeed } from '../src/pipeline/fetch-feed.js';
import {
  processFeed, processAllFeeds, pruneLogs, getLastRun, MAX_FULL_TEXT_ATTEMPTS,
  MAX_TRANSLATE_ATTEMPTS, TRANSLATE_RETRY_BACKOFF_MS, MAX_ERROR_RETRIES_PER_RUN, isTranslateRetryDue,
  MAX_TRANSLATIONS_PER_ARTICLE, RETRANSLATE_WINDOW_MS, getTokenBudgetStatus,
} from '../src/pipeline/run.js';
import { translateEntry } from '../src/pipeline/translate-entry.js';
import { createDb } from '../src/db/index.js';
import { USER_AGENT } from '../src/version.js';

// ─── parseFeedXml(離線)───
describe('parseFeedXml', () => {
  it('RSS 2.0 含 content:encoded 全文 → 正規化', async () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel><title>Test Feed</title>
          <item>
            <title>Hello Article</title>
            <link>https://ex.com/1</link>
            <guid>guid-1</guid>
            <pubDate>Wed, 02 Jul 2025 10:00:00 GMT</pubDate>
            <content:encoded><![CDATA[<p>Full <b>content</b> here.</p>]]></content:encoded>
          </item>
        </channel>
      </rss>`;
    const { title, items } = await parseFeedXml(xml);
    expect(title).toBe('Test Feed');
    expect(items).toHaveLength(1);
    expect(items[0].guid).toBe('guid-1');
    expect(items[0].title).toBe('Hello Article');
    expect(items[0].url).toBe('https://ex.com/1');
    expect(items[0].contentHtml).toContain('<b>content</b>');
    expect(items[0].published_at).toBe(Date.parse('Wed, 02 Jul 2025 10:00:00 GMT'));
  });

  it('作者正規化:RSS dc:creator / Atom author,缺作者回 null', async () => {
    const rss = `<?xml version="1.0"?>
      <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel><title>R</title>
          <item><title>有作者</title><guid>r1</guid><dc:creator>袁莉</dc:creator></item>
          <item><title>沒作者</title><guid>r2</guid></item>
        </channel>
      </rss>`;
    const r = await parseFeedXml(rss);
    expect(r.items[0].author).toBe('袁莉');
    expect(r.items[1].author).toBe(null);

    const atom = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
        <entry><title>x</title><id>a1</id><author><name>Emma Roth</name></author></entry>
      </feed>`;
    const a = await parseFeedXml(atom);
    expect(a.items[0].author).toBe('Emma Roth');
  });

  it('封面圖:Atom media:content(無 type,靠副檔名)/ RSS enclosure / media:thumbnail 都撈得到', async () => {
    const atom = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><title>A</title>
        <entry><title>t</title><id>a1</id>
          <media:content url="https://cdn.theatlantic.com/media/img/mt/2026/08/x/original.jpg"/>
        </entry>
        <entry><title>t2</title><id>a2</id>
          <media:thumbnail url="https://cdn/thumb.png"/>
        </entry>
      </feed>`;
    const a = await parseFeedXml(atom);
    expect(a.items[0].image_url).toBe('https://cdn.theatlantic.com/media/img/mt/2026/08/x/original.jpg');
    expect(a.items[1].image_url).toBe('https://cdn/thumb.png');

    const rss = `<?xml version="1.0"?>
      <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
        <channel><title>R</title>
          <item><title>有 enclosure</title><guid>r1</guid>
            <enclosure url="https://cdn/cover.jpg" type="image/jpeg" length="1234"/>
          </item>
          <item><title>enclosure 是音檔</title><guid>r2</guid>
            <enclosure url="https://cdn/ep.mp3" type="audio/mpeg" length="99"/>
          </item>
          <item><title>media:content 宣告 medium</title><guid>r3</guid>
            <media:content url="https://cdn/no-ext" medium="image"/>
          </item>
          <item><title>什麼都沒有</title><guid>r4</guid></item>
        </channel>
      </rss>`;
    const r = await parseFeedXml(rss);
    expect(r.items[0].image_url).toBe('https://cdn/cover.jpg');
    expect(r.items[1].image_url).toBe(null);   // podcast 附檔不是封面
    expect(r.items[2].image_url).toBe('https://cdn/no-ext');
    expect(r.items[3].image_url).toBe(null);
  });
});

// ─── processFeed 編排(離線,注入 fake)───
describe('processFeed 編排', () => {
  let ctx, feed;
  const fixedNow = () => 1000;

  // fake 翻譯:標題內文加「譯:」前綴,回固定 usage
  const fakeTranslate = async ({ title, contentHtml }) => ({
    titleTranslated: title ? `譯:${title}` : title,
    contentTranslated: contentHtml ? contentHtml.replace(/>([^<]+)</g, '>譯$1<') : contentHtml,
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0 },
    hadMismatch: false,
  });

  const makeFetch = (items, extra = {}) => async () => ({
    notModified: false, title: 'F', items, etag: 'W/"v1"', lastModified: null, ...extra,
  });

  beforeEach(() => {
    ctx = createDb(':memory:');
    feed = ctx.feeds.create({ source_url: 'https://ex.com/feed' });
  });

  it('首次抓取:建立 entries + 翻譯 + 記 usage + 存 etag', async () => {
    const items = [
      { guid: 'g1', title: 'A', url: 'https://ex.com/a', contentHtml: '<p>Body A</p>', published_at: 1 },
      { guid: 'g2', title: 'B', url: 'https://ex.com/b', contentHtml: '<p>Body B</p>', published_at: 2 },
    ];
    const r = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: fakeTranslate,
    });
    expect(r).toMatchObject({ fetched: 2, added: 2, translated: 2, failed: 0, notModified: false });

    const entries = ctx.entries.listByFeed(feed.id);
    expect(entries).toHaveLength(2);
    expect(entries.every(e => e.translation_status === 'done')).toBe(true);
    const gA = ctx.entries.getByGuid(feed.id, 'g1');
    expect(gA.title_translated).toBe('譯:A');
    expect(gA.content_translated).toContain('譯Body A');

    expect(ctx.usage.getStats().calls).toBe(2);
    expect(ctx.usage.getStats().input_tokens).toBe(200);
    expect(ctx.feeds.get(feed.id).etag).toBe('W/"v1"');
  });

  it('第二次抓取相同 items:去重,不重複建立也不重譯', async () => {
    const items = [{ guid: 'g1', title: 'A', contentHtml: '<p>Body</p>', published_at: 1 }];
    await processFeed(ctx, feed, { apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: fakeTranslate });
    const r2 = await processFeed(ctx, feed, { apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: fakeTranslate });
    expect(r2.added).toBe(0);
    expect(r2.translated).toBe(0); // 沒有新的 pending
    expect(ctx.entries.listByFeed(feed.id)).toHaveLength(1);
    expect(ctx.usage.getStats().calls).toBe(1); // 只翻過一次
  });

  it('304 Not Modified:不新增 entries', async () => {
    const r = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, translateEntry: fakeTranslate,
      fetchFeed: async () => ({ notModified: true, items: [], etag: 'W/"v1"', lastModified: null }),
    });
    expect(r.notModified).toBe(true);
    expect(r.added).toBe(0);
    expect(ctx.entries.listByFeed(feed.id)).toHaveLength(0);
  });

  it('304 但有 pending backlog → 仍翻譯(不能因來源沒更新就卡住)', async () => {
    // 預先放一筆 pending(模擬之前失敗重設的文章)
    ctx.entries.upsertNew({ feed_id: feed.id, guid: 'old', title: 'Old', content_html: '<p>x</p>' }, fixedNow());
    const r = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, translateEntry: fakeTranslate,
      fetchFeed: async () => ({ notModified: true, items: [], etag: 'W/"v1"', lastModified: null }),
    });
    expect(r.notModified).toBe(true);
    expect(r.added).toBe(0);
    expect(r.translated).toBe(1); // backlog 被翻掉
    expect(ctx.entries.getByGuid(feed.id, 'old').translation_status).toBe('done');
  });

  it('單篇翻譯失敗 → 標記 error,不影響其他篇', async () => {
    const items = [
      { guid: 'g1', title: 'ok', contentHtml: '<p>x</p>', published_at: 1 },
      { guid: 'g2', title: 'boom', contentHtml: '<p>y</p>', published_at: 2 },
    ];
    const flakyTranslate = async (entry) => {
      if (entry.title === 'boom') throw new Error('API 爆了');
      return fakeTranslate(entry);
    };
    const r = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: flakyTranslate,
    });
    expect(r.translated).toBe(1);
    expect(r.failed).toBe(1);
    expect(ctx.entries.getByGuid(feed.id, 'g1').translation_status).toBe('done');
    const bad = ctx.entries.getByGuid(feed.id, 'g2');
    expect(bad.translation_status).toBe('error');
    expect(bad.translation_error).toContain('API 爆了');
  });

  it('翻譯失敗但錯誤帶 usage(引擎丟錯前已付費的 token)→ 仍記帳;沒帶則不記', async () => {
    const items = [
      { guid: 'g1', title: 'burn', contentHtml: '<p>x</p>', published_at: 1 },
      { guid: 'g2', title: 'plain', contentHtml: '<p>y</p>', published_at: 2 },
    ];
    const translate = async (entry) => {
      if (entry.title === 'burn') {
        const err = new Error('模型空回應');
        err.usage = { inputTokens: 1234, outputTokens: 5, cachedTokens: 0 }; // 引擎慣例:已付費 usage 掛在 err
        throw err;
      }
      throw new Error('網路斷線'); // 沒掛 usage:fetch 根本沒成功,不該記
    };
    const r = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: translate,
    });
    expect(r.failed).toBe(2);
    const st = ctx.usage.getStats();
    expect(st.calls).toBe(1);
    expect(st.input_tokens).toBe(1234);
    expect(st.output_tokens).toBe(5);
    // 兩篇都標 error,記帳不影響錯誤處理
    expect(ctx.entries.getByGuid(feed.id, 'g1').translation_status).toBe('error');
    expect(ctx.entries.getByGuid(feed.id, 'g2').translation_status).toBe('error');
  });

  it('fetch_article:翻譯前抓全文覆蓋摘要,並存回 content_html', async () => {
    const f2 = ctx.feeds.create({ source_url: 'https://ex.com/ft', fetch_article: true });
    const items = [{ guid: 'g1', title: 'A', url: 'https://ex.com/a', contentHtml: '<p>只有摘要</p>', published_at: 1 }];
    let sawContent = null;
    const captureTranslate = async ({ contentHtml }) => {
      sawContent = contentHtml;
      return { titleTranslated: '譯', contentTranslated: contentHtml, usage: { inputTokens: 1, outputTokens: 1 }, hadMismatch: false };
    };
    await processFeed(ctx, f2, {
      apiKey: 'x', now: fixedNow, translateEntry: captureTranslate,
      fetchFeed: makeFetch(items),
      fetchFullText: async (url) => `<p>完整全文 from ${url}</p>`,
    });
    expect(sawContent).toContain('完整全文'); // 翻譯拿到的是全文,不是摘要
    expect(ctx.entries.getByGuid(f2.id, 'g1').content_html).toContain('完整全文'); // 存回 DB
  });

  it('fetch_article 抓全文失敗 → 退回原摘要,仍翻譯,並記錄待補抓', async () => {
    const f3 = ctx.feeds.create({ source_url: 'https://ex.com/ft2', fetch_article: true });
    const items = [{ guid: 'g1', title: 'A', url: 'https://ex.com/a', contentHtml: '<p>摘要</p>', published_at: 1 }];
    let sawContent = null;
    const cap = async ({ contentHtml }) => { sawContent = contentHtml; return fakeTranslate({ title: 'A', contentHtml }); };
    const r = await processFeed(ctx, f3, {
      apiKey: 'x', now: fixedNow, translateEntry: cap,
      fetchFeed: makeFetch(items),
      fetchFullText: async () => null, // 抓不到
    });
    expect(sawContent).toContain('摘要'); // 退回摘要
    expect(r.translated).toBe(1);
    expect(ctx.entries.getByGuid(f3.id, 'g1').full_text_retries).toBe(1); // 待補抓
  });

  it('全文抓取逾時 → 下輪刷新補抓成功,覆蓋原文並重譯', async () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/ft3', fetch_article: true });
    const items = [{ guid: 'g1', title: 'A', url: 'https://ex.com/a', contentHtml: '<p>摘要</p>', published_at: 1 }];
    const translated = [];
    const cap = async ({ contentHtml }) => { translated.push(contentHtml); return fakeTranslate({ title: 'A', contentHtml }); };

    // 第一輪:逾時 → 用摘要翻,記 full_text_retries=1
    await processFeed(ctx, f, {
      apiKey: 'x', now: fixedNow, translateEntry: cap, fetchFeed: makeFetch(items),
      fetchFullText: async () => { throw new Error('The operation was aborted due to timeout'); },
    });
    const after1 = ctx.entries.getByGuid(f.id, 'g1');
    expect(after1.content_html).toContain('摘要');
    expect(after1.full_text_retries).toBe(1);
    expect(after1.translation_status).toBe('done'); // 讀者先看得到東西

    // 第二輪:站台恢復 → 補抓成功 → 內文換全文、計數歸零、重譯一次
    let fullTextCalls = 0;
    const r2 = await processFeed(ctx, f, {
      apiKey: 'x', now: fixedNow, translateEntry: cap, fetchFeed: makeFetch(items),
      fetchFullText: async () => { fullTextCalls++; return '<p>完整全文</p>'; },
    });
    const after2 = ctx.entries.getByGuid(f.id, 'g1');
    expect(fullTextCalls).toBe(1);                       // 補抓一次就好,翻譯階段不重抓
    expect(after2.content_html).toContain('完整全文');
    expect(after2.full_text_retries).toBe(0);
    expect(after2.translation_status).toBe('done');
    expect(r2.translated).toBe(1);
    expect(translated[translated.length - 1]).toContain('完整全文'); // 這次翻的是全文
  });

  it('補抓連續失敗到上限就放棄,不再每輪重抓', async () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/ft4', fetch_article: true });
    const items = [{ guid: 'g1', title: 'A', url: 'https://ex.com/a', contentHtml: '<p>摘要</p>', published_at: 1 }];
    let calls = 0;
    const run = () => processFeed(ctx, f, {
      apiKey: 'x', now: fixedNow, translateEntry: fakeTranslate, fetchFeed: makeFetch(items),
      fetchFullText: async () => { calls++; throw new Error('timeout'); },
    });
    await run(); // 第一次(翻譯階段)
    await run(); // 補抓 1
    await run(); // 補抓 2 → 累計 3 次,放棄
    expect(calls).toBe(MAX_FULL_TEXT_ATTEMPTS);
    expect(ctx.entries.getByGuid(f.id, 'g1').full_text_retries).toBe(MAX_FULL_TEXT_ATTEMPTS);
    await run(); // 之後不再補抓
    expect(calls).toBe(MAX_FULL_TEXT_ATTEMPTS);
  });

  it('沒勾抓全文的 feed 不會補抓', async () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/ft5', fetch_article: false });
    const items = [{ guid: 'g1', title: 'A', url: 'https://ex.com/a', contentHtml: '<p>摘要</p>', published_at: 1 }];
    await processFeed(ctx, f, { apiKey: 'x', now: fixedNow, translateEntry: fakeTranslate, fetchFeed: makeFetch(items) });
    // 手動塞一個「曾失敗」狀態(模擬先前勾過全文後又取消)
    ctx.entries.bumpFullTextFailure(ctx.entries.getByGuid(f.id, 'g1').id);
    let calls = 0;
    await processFeed(ctx, f, {
      apiKey: 'x', now: fixedNow, translateEntry: fakeTranslate, fetchFeed: makeFetch(items),
      fetchFullText: async () => { calls++; return '<p>全文</p>'; },
    });
    expect(calls).toBe(0);
  });

  it('沒 guid 的 item 跳過(無法去重)', async () => {
    const items = [{ guid: null, title: 'X', contentHtml: '<p>z</p>', published_at: 1 }];
    const r = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: fakeTranslate,
    });
    expect(r.added).toBe(0);
    expect(ctx.entries.listByFeed(feed.id)).toHaveLength(0);
  });

  // ── 花費保險絲 ──
  // 驗:不管重翻是哪種 bug 造成的(這裡用「刪掉 entry 讓它重插」與「guid 每次都變」兩種模擬),
  //     同一篇 24h 內的成功翻譯次數都有上限;每日 token 預算超過就停、文章留 pending、視窗過了自動續翻。
  // 不驗:預算數字設多少才合理(那是營運判斷);也不驗供應商端實際計費是否等於 usage 表加總。
  describe('花費保險絲', () => {
    let t, calls;
    const translate = async (e) => { calls++; return fakeTranslate(e); };
    const run = (items, extra = {}) => processFeed(ctx, feed, { apiKey: 'x', now: () => t, fetchFeed: makeFetch(items), translateEntry: translate, ...extra });
    beforeEach(() => { t = 10 * RETRANSLATE_WINDOW_MS; calls = 0; });

    it('重翻保險絲:同一篇被反覆刪除重插(未知 bug 的通用形狀)→ 最多翻 MAX 次,之後拒翻並記 error', async () => {
      const items = [{ guid: 'loop', title: 'Long read', url: 'https://ex.com/long', contentHtml: '<p>x</p>', published_at: 1 }];
      for (let i = 0; i < 10; i++) {
        await run(items);
        ctx.entries.deleteByFeed(feed.id); // 模擬某種 bug 把它弄掉 → 下輪被當新文章
        t += 15 * 60_000;
      }
      expect(calls).toBe(MAX_TRANSLATIONS_PER_ARTICLE); // 不是 10
      expect(ctx.logs.query().some((l) => l.level === 'error' && /重翻保險絲/.test(l.message))).toBe(true);
    });

    it('重翻保險絲:guid 每次抓取都變、url 不變 → 靠 url 一樣擋得住', async () => {
      for (let i = 0; i < 8; i++) {
        await run([{ guid: `unstable-${i}`, title: 'Same', url: 'https://ex.com/same', contentHtml: '<p>x</p>', published_at: 1 }]);
        t += 15 * 60_000;
      }
      expect(calls).toBe(MAX_TRANSLATIONS_PER_ARTICLE);
    });

    it('重翻保險絲:不誤傷正常流程 —— 不同文章各翻各的;被擋下的文章手動「重翻」立即解除', async () => {
      await run([1, 2, 3, 4, 5].map((i) => ({ guid: `a${i}`, url: `https://ex.com/${i}`, title: `A${i}`, contentHtml: '<p>x</p>', published_at: i })));
      expect(calls).toBe(5);

      const one = [{ guid: 'loop', url: 'https://ex.com/loop', title: 'L', contentHtml: '<p>x</p>', published_at: 9 }];
      for (let i = 0; i < MAX_TRANSLATIONS_PER_ARTICLE + 1; i++) { await run(one); if (i < MAX_TRANSLATIONS_PER_ARTICLE) ctx.entries.deleteByFeed(feed.id); }
      const blocked = ctx.entries.getByGuid(feed.id, 'loop');
      expect(blocked.translation_status).toBe('error');
      expect(blocked.translation_error).toMatch(/重翻保險絲/);

      calls = 0;
      expect(ctx.entries.resetErrorsToPending(feed.id)).toBe(1); // 使用者按「重翻」= 明確覆寫
      await run(one);
      expect(calls).toBe(1);
      expect(ctx.entries.getByGuid(feed.id, 'loop').translation_status).toBe('done');
    });

    it('每日 token 預算:用完就停、剩下的留 pending(不是 error);視窗過了自動續翻', async () => {
      ctx.settings.set('dailyTokenBudget', 250); // fakeTranslate 每篇 120 token → 第 3 篇前就超過
      const items = [1, 2, 3, 4, 5].map((i) => ({ guid: `b${i}`, title: `B${i}`, contentHtml: '<p>x</p>', published_at: i }));
      const r = await run(items);
      expect(r).toMatchObject({ translated: 3, failed: 0, budgetSkipped: 2 }); // 120×2=240 <250 → 第 3 篇照翻,360 ≥250 → 停
      expect(ctx.entries.pendingByFeed(feed.id)).toHaveLength(2);
      expect(getTokenBudgetStatus(ctx, t)).toMatchObject({ budget: 250, used: 360, exceeded: true });
      expect(ctx.logs.query().some((l) => l.level === 'error' && /已達每日 token 預算/.test(l.message))).toBe(true);

      t += 15 * 60_000;
      expect((await run(items)).translated).toBe(0); // 還在視窗內:繼續停

      t += RETRANSLATE_WINDOW_MS;
      expect((await run(items)).translated).toBe(2); // 視窗滑過 → 自動補完
      expect(ctx.entries.pendingByFeed(feed.id)).toHaveLength(0);
    });

    it('每日 token 預算:0 = 不限制(預設);免費引擎(Google / OpenCC)不受預算限制', async () => {
      const items = [1, 2, 3].map((i) => ({ guid: `c${i}`, title: `C${i}`, contentHtml: '<p>x</p>', published_at: i }));
      expect((await run(items)).translated).toBe(3); // 沒設預算
      expect(getTokenBudgetStatus(ctx, t).exceeded).toBe(false);

      ctx.settings.set('dailyTokenBudget', 1); // 已經超過
      const g = ctx.feeds.create({ source_url: 'https://g.com/feed', engine: 'google' });
      const r = await processFeed(ctx, g, { apiKey: 'x', now: () => t, fetchFeed: makeFetch(items), translateEntry: translate });
      expect(r).toMatchObject({ translated: 3, budgetSkipped: 0 });
    });
  });

  // ── 翻譯失敗自動重試 ──
  // 驗:編排層的退避 / 次數上限 / 每輪篇數上限 / 成功後歸零。
  // 不驗:真實 Google 429 或 Gemini 額度錯誤的形狀(這裡一律用丟錯的 fake;任何錯誤都同等對待),
  //       也不驗退避時間表對「真實限流持續多久」是否夠長(那要看 production log)。
  describe('翻譯失敗自動重試', () => {
    const items = [{ guid: 'g1', title: 'A', contentHtml: '<p>x</p>', published_at: 1 }];
    const notModified = async () => ({ notModified: true, items: [], etag: null, lastModified: null });
    let t, calls, failing;
    const translate = async (e) => { calls++; if (failing) throw new Error('Google Translate HTTP 429'); return fakeTranslate(e); };
    const run = (fetchFeed = notModified) => processFeed(ctx, feed, { apiKey: 'x', now: () => t, fetchFeed, translateEntry: translate });
    beforeEach(() => { t = 1_000_000; calls = 0; failing = true; });

    it('暫時性失敗:退避時間沒到不重試;到了自動重試,成功後歸零失敗次數', async () => {
      await run(makeFetch(items));
      let e = ctx.entries.getByGuid(feed.id, 'g1');
      expect(e).toMatchObject({ translation_status: 'error', translation_retries: 1, translation_failed_at: 1_000_000 });

      t += TRANSLATE_RETRY_BACKOFF_MS[0] - 1; // 差 1ms:手動連按刷新不該狂打被限流的端點
      await run();
      expect(calls).toBe(1);

      t += 1; failing = false;
      const r = await run();
      expect(r.translated).toBe(1);
      e = ctx.entries.getByGuid(feed.id, 'g1');
      expect(e).toMatchObject({ translation_status: 'done', translation_retries: 0, translation_failed_at: null, translation_error: null });
    });

    it('一直失敗:間隔逐次拉長,總共只試 MAX_TRANSLATE_ATTEMPTS 次就停(不無限燒)', async () => {
      await run(makeFetch(items));
      for (let i = 0; i < 20; i++) { t += 24 * 3600_000; await run(); } // 每次都等超過最長退避
      expect(calls).toBe(MAX_TRANSLATE_ATTEMPTS);
      const e = ctx.entries.getByGuid(feed.id, 'g1');
      expect(e.translation_status).toBe('error'); // 留在 error 等人工,不是默默消失
      expect(e.translation_retries).toBe(MAX_TRANSLATE_ATTEMPTS);
      expect(ctx.logs.query().some((l) => /已達上限不再自動重試/.test(l.message))).toBe(true);
    });

    it('退避時間表:第 n 次失敗後等 BACKOFF[n-1];舊版留下的 error(無失敗時間)立即可試', () => {
      const at = 5_000_000;
      TRANSLATE_RETRY_BACKOFF_MS.forEach((ms, i) => {
        const e = { translation_retries: i + 1, translation_failed_at: at };
        expect(isTranslateRetryDue(e, at + ms - 1)).toBe(false);
        expect(isTranslateRetryDue(e, at + ms)).toBe(true);
      });
      expect(isTranslateRetryDue({ translation_retries: 0, translation_failed_at: null }, 0)).toBe(true);
    });

    it('積壓的失敗文章每輪最多重試 MAX_ERROR_RETRIES_PER_RUN 篇(不對免費端點爆量),最久沒試的優先', async () => {
      const n = MAX_ERROR_RETRIES_PER_RUN + 2;
      for (let i = 1; i <= n; i++) {
        const { entry } = ctx.entries.upsertNew({ feed_id: feed.id, guid: `e${i}`, title: `E${i}`, content_html: '<p>x</p>' }, t);
        ctx.entries.markError(entry.id, 'old 429', t + i); // e1 最早失敗
      }
      t += 24 * 3600_000; failing = false;
      const r = await run();
      expect(r.translated).toBe(MAX_ERROR_RETRIES_PER_RUN);
      expect(ctx.entries.getByGuid(feed.id, 'e1').translation_status).toBe('done');
      expect(ctx.entries.getByGuid(feed.id, `e${n}`).translation_status).toBe('error'); // 下一輪再輪到
    });

    it('手動「重翻」歸零失敗次數:已達上限的文章重新拿到完整自動重試額度', async () => {
      await run(makeFetch(items));
      for (let i = 0; i < 10; i++) { t += 24 * 3600_000; await run(); }
      expect(ctx.entries.resetErrorsToPending(feed.id)).toBe(1);
      expect(ctx.entries.getByGuid(feed.id, 'g1')).toMatchObject({ translation_retries: 0, translation_failed_at: null });
    });
  });

  it('entry 上限:來源重新列出的舊日期文章不被清掉,連續刷新不重翻(防 token 迴圈)', async () => {
    // 重現 2026-09 Atlantic best-of 事故:庫已滿 N 篇較新文章,來源又列出一篇 published_at 很舊的長文。
    // 驗:第一輪翻 1 次後留在庫內;第二輪同一份來源 → 不重插、不重翻。
    // 不驗:真實 feed 的 guid 穩定性(guid 每次變動是另一類重翻問題,這條抓不到)。
    for (let i = 1; i <= 3; i++) {
      const { entry } = ctx.entries.upsertNew({ feed_id: feed.id, guid: `recent${i}`, published_at: 5000 + i }, fixedNow());
      ctx.entries.markDone(entry.id, {});
    }
    const items = [{ guid: 'classic', title: 'C', contentHtml: '<p>x</p>', published_at: 1 }];
    let calls = 0;
    const countingTranslate = async (...a) => { calls++; return fakeTranslate(...a); };
    const deps = {
      apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: countingTranslate,
      maxEntriesPerFeed: 3,
    };
    const r1 = await processFeed(ctx, feed, deps);
    expect(r1.translated).toBe(1);
    expect(ctx.entries.listByFeed(feed.id).map((e) => e.guid)).toContain('classic');
    const r2 = await processFeed(ctx, feed, deps);
    expect(r2.added).toBe(0);
    expect(calls).toBe(1);
  });

  it('entry 上限:處理結尾清掉超額舊文章,只留最新 N 篇', async () => {
    // 先塞 4 篇舊文章(已翻),再抓進 1 篇新的;上限 3 → 清掉最舊 2 篇
    for (let i = 1; i <= 4; i++) {
      const { entry } = ctx.entries.upsertNew({ feed_id: feed.id, guid: `old${i}`, published_at: i * 1000 }, fixedNow());
      ctx.entries.markDone(entry.id, {});
    }
    const items = [{ guid: 'new1', title: 'N', contentHtml: '<p>x</p>', published_at: 9000 }];
    const r = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: fakeTranslate,
      maxEntriesPerFeed: 3,
    });
    expect(r.pruned).toBe(2);
    expect(ctx.entries.listByFeed(feed.id).map((e) => e.guid).sort()).toEqual(['new1', 'old3', 'old4']);
    expect(ctx.logs.query().some((l) => /清理舊文章/.test(l.message))).toBe(true);
  });

  it('entry 上限:來源 XML 列出的篇數超過上限 → 不刪(防「刪了又重抓重翻」迴圈)', async () => {
    // 上限 2,但來源一次給 4 篇 → 保留數取 max(2, 4),全數保留
    const items = [1, 2, 3, 4].map((i) => ({ guid: `g${i}`, title: `t${i}`, contentHtml: '<p>x</p>', published_at: i * 1000 }));
    const r1 = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: fakeTranslate,
      maxEntriesPerFeed: 2,
    });
    expect(r1.pruned).toBe(0);
    expect(ctx.entries.listByFeed(feed.id)).toHaveLength(4);
    // 再處理一次:沒有任何文章被當成新的重翻
    const r2 = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: fakeTranslate,
      maxEntriesPerFeed: 2,
    });
    expect(r2.added).toBe(0);
    expect(r2.translated).toBe(0);
    expect(ctx.usage.getStats().calls).toBe(4); // 只有第一輪的 4 次翻譯
  });

  it('entry 上限:讀設定頁的 maxEntriesPerFeed(不靠注入)', async () => {
    ctx.settings.set('maxEntriesPerFeed', 3);
    for (let i = 1; i <= 5; i++) {
      const { entry } = ctx.entries.upsertNew({ feed_id: feed.id, guid: `old${i}`, published_at: i * 1000 }, fixedNow());
      ctx.entries.markDone(entry.id, {});
    }
    const r = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, fetchFeed: makeFetch([]), translateEntry: fakeTranslate,
    });
    expect(r.pruned).toBe(2);
    expect(ctx.entries.listByFeed(feed.id)).toHaveLength(3);
  });

  it('entry 上限:feed 自訂 max_entries 優先於全域;null 繼承全域;0 = 該 feed 不限制', async () => {
    // 驗上限來源優先序(feed → 全域)。不驗 UI / API 怎麼把值寫進 feeds.max_entries(見 web / frontend 測試)
    ctx.settings.set('maxEntriesPerFeed', 2);
    for (let i = 1; i <= 5; i++) {
      const { entry } = ctx.entries.upsertNew({ feed_id: feed.id, guid: `old${i}`, published_at: i * 1000 }, fixedNow());
      ctx.entries.markDone(entry.id, {});
    }
    const run = (f) => processFeed(ctx, f, { apiKey: 'x', now: fixedNow, fetchFeed: makeFetch([]), translateEntry: fakeTranslate });

    expect((await run(ctx.feeds.update(feed.id, { max_entries: 4 }))).pruned).toBe(1);  // 自訂 4 > 全域 2
    expect((await run(ctx.feeds.update(feed.id, { max_entries: 0 }))).pruned).toBe(0);  // 0 = 不限制
    expect((await run(ctx.feeds.update(feed.id, { max_entries: null }))).pruned).toBe(2); // 繼承全域 2:4 → 2
    expect(ctx.entries.listByFeed(feed.id)).toHaveLength(2);
  });

  it('entry 上限:設 0 = 不限制,不清理', async () => {
    ctx.settings.set('maxEntriesPerFeed', 0);
    for (let i = 1; i <= 5; i++) {
      const { entry } = ctx.entries.upsertNew({ feed_id: feed.id, guid: `old${i}`, published_at: i * 1000 }, fixedNow());
      ctx.entries.markDone(entry.id, {});
    }
    const r = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, fetchFeed: makeFetch([]), translateEntry: fakeTranslate,
    });
    expect(r.pruned).toBe(0);
    expect(ctx.entries.listByFeed(feed.id)).toHaveLength(5);
  });

  it('entry 上限:304 未更新 → 不清(看不到來源清單,清了有重翻風險)', async () => {
    for (let i = 1; i <= 4; i++) {
      const { entry } = ctx.entries.upsertNew({ feed_id: feed.id, guid: `old${i}`, published_at: i * 1000 }, fixedNow());
      ctx.entries.markDone(entry.id, {});
    }
    const r = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, translateEntry: fakeTranslate, maxEntriesPerFeed: 2,
      fetchFeed: async () => ({ notModified: true, items: [], etag: 'W/"v1"', lastModified: null }),
    });
    expect(r.pruned).toBe(0);
    expect(ctx.entries.listByFeed(feed.id)).toHaveLength(4);
  });

  it('寫入 log:抓取 + 逐篇翻譯 + 失敗', async () => {
    const items = [
      { guid: 'g1', title: 'ok', contentHtml: '<p>x</p>', published_at: 1 },
      { guid: 'g2', title: 'boom', contentHtml: '<p>y</p>', published_at: 2 },
    ];
    const flaky = async (e) => { if (e.title === 'boom') throw new Error('炸'); return fakeTranslate(e); };
    await processFeed(ctx, feed, { apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: flaky });
    const logs = ctx.logs.query();
    expect(logs.some(l => l.category === 'fetch' && /抓取/.test(l.message))).toBe(true);
    expect(logs.some(l => l.category === 'translate' && l.level === 'info' && /已翻譯/.test(l.message))).toBe(true);
    expect(logs.some(l => l.category === 'translate' && l.level === 'error' && /翻譯失敗/.test(l.message))).toBe(true);
  });
});

// ─── fetchFeed(離線,注入 fetchImpl)───
describe('fetchFeed', () => {
  const RSS = '<rss version="2.0"><channel><title>T</title></channel></rss>';

  it('User-Agent 用 Mozilla/5.0 (compatible; …) 慣例格式(AWS WAF 對純自訂 UA 回 202 挑戰頁)', async () => {
    let saw;
    const fake = async (url, init) => {
      saw = init.headers;
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => RSS };
    };
    await fetchFeed('https://ex.com/f', { fetchImpl: fake });
    expect(saw['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^Mozilla\/5\.0 \(compatible; Shinkansen-Feed\/\d+\.\d+(\.\d+)?; /);
  });

  it('XML 解析失敗(截斷回應)→ 重抓一次成功', async () => {
    const TRUNCATED = RSS.slice(0, 30); // 模擬上游截斷:缺結尾標籤
    let calls = 0;
    const fake = async () => ({
      status: 200, ok: true, headers: { get: () => null },
      text: async () => (++calls === 1 ? TRUNCATED : RSS),
    });
    const r = await fetchFeed('https://ex.com/f', { fetchImpl: fake, parseRetryDelayMs: 0 });
    expect(calls).toBe(2);
    expect(r.title).toBe('T');
  });

  it('重抓仍解析失敗 → 拋錯;共打兩次', async () => {
    let calls = 0;
    const fake = async () => ({
      status: 200, ok: true, headers: { get: () => null },
      text: async () => { calls++; return RSS.slice(0, 30); },
    });
    await expect(fetchFeed('https://ex.com/f', { fetchImpl: fake, parseRetryDelayMs: 0 })).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it('HTTP 錯誤不重試(只打一次,避免掛掉來源拖慢整輪)', async () => {
    let calls = 0;
    const fake = async () => { calls++; return { status: 500, ok: false, headers: { get: () => null }, text: async () => '' }; };
    await expect(fetchFeed('https://ex.com/f', { fetchImpl: fake, parseRetryDelayMs: 0 })).rejects.toThrow('HTTP 500');
    expect(calls).toBe(1);
  });

  it('帶 conditional GET 標頭與 timeout signal', async () => {
    let saw;
    const fake = async (url, init) => {
      saw = init;
      return { status: 200, ok: true, text: async () => RSS, headers: { get: () => null } };
    };
    const r = await fetchFeed('https://ex.com/f', { fetchImpl: fake, etag: 'W/"e"', lastModified: 'Mon' });
    expect(saw.headers['if-none-match']).toBe('W/"e"');
    expect(saw.headers['if-modified-since']).toBe('Mon');
    expect(saw.signal).toBeInstanceOf(AbortSignal); // 掛掉的來源不能卡整條管線
    expect(r.notModified).toBe(false);
    expect(r.title).toBe('T');
  });

  it('304 → notModified,沿用舊 etag/lastModified', async () => {
    const fake = async () => ({ status: 304 });
    const r = await fetchFeed('https://ex.com/f', { fetchImpl: fake, etag: 'W/"e"' });
    expect(r).toMatchObject({ notModified: true, etag: 'W/"e"', items: [] });
  });
});

describe('processFeed 併發保護', () => {
  let ctx, feed;
  const items = [{ guid: 'g1', title: 'A', contentHtml: '<p>x</p>', published_at: 1 }];
  const makeFetch = async () => ({ notModified: false, title: 'F', items, etag: null, lastModified: null });
  const fakeTranslate = async ({ title, contentHtml }) => ({
    titleTranslated: `譯:${title}`, contentTranslated: contentHtml,
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, hadMismatch: false,
  });

  beforeEach(() => {
    ctx = createDb(':memory:');
    feed = ctx.feeds.create({ source_url: 'https://ex.com/lock' });
  });

  it('同一 feed 處理中再呼叫 → 拒絕(FEED_IN_FLIGHT),不重複翻譯', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = async (e) => { await gate; return fakeTranslate(e); };
    const deps = { apiKey: 'x', fetchFeed: makeFetch, translateEntry: slow };

    const first = processFeed(ctx, feed, deps); // 卡在翻譯中
    await new Promise((r) => setTimeout(r, 10));
    await expect(processFeed(ctx, feed, deps)).rejects.toMatchObject({ code: 'FEED_IN_FLIGHT' });

    release();
    await first;
    expect(ctx.usage.getStats().calls).toBe(1); // 只翻(記帳)一次
  });

  it('processAllFeeds 跳過處理中的 feed(回 skipped),鎖釋放後可再處理', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = async (e) => { await gate; return fakeTranslate(e); };

    const first = processFeed(ctx, feed, { apiKey: 'x', fetchFeed: makeFetch, translateEntry: slow });
    await new Promise((r) => setTimeout(r, 10));
    const results = await processAllFeeds(ctx, { apiKey: 'x', fetchFeed: makeFetch, translateEntry: fakeTranslate });
    expect(results).toContainEqual({ feedId: feed.id, skipped: true });

    release();
    await first;
    const again = await processAllFeeds(ctx, { apiKey: 'x', fetchFeed: makeFetch, translateEntry: fakeTranslate });
    expect(again[0].skipped).toBeUndefined(); // 鎖已釋放,正常處理
    expect(again[0].feedId).toBe(feed.id);
  });

  it('翻譯回報 hadMismatch → 寫 warn log 供追查漏譯', async () => {
    const mismatch = async (e) => ({ ...(await fakeTranslate(e)), hadMismatch: true });
    await processFeed(ctx, feed, { apiKey: 'x', fetchFeed: makeFetch, translateEntry: mismatch });
    expect(ctx.logs.query().some((l) => l.level === 'warn' && /段數曾不符/.test(l.message))).toBe(true);
  });
});

describe('pruneLogs', () => {
  it('依保留天數清舊 log;<=0 不清', () => {
    const ctx2 = createDb(':memory:');
    const now = 100 * 86400_000; // 第 100 天
    ctx2.logs.append({ ts: now - 10 * 86400_000, level: 'info', message: '10 天前' });
    ctx2.logs.append({ ts: now - 1 * 86400_000, level: 'info', message: '1 天前' });
    const removed = pruneLogs(ctx2, 7, now); // 保留 7 天
    expect(removed).toBe(1);
    expect(ctx2.logs.query()).toHaveLength(1);
    expect(pruneLogs(ctx2, 0, now)).toBe(0); // 0 = 不清
  });
});

// ─── translateEntry × OpenCC(離線整合:真走 segmenter + 真轉換,不打網路)───
describe('translateEntry × OpenCC 簡轉繁(離線)', () => {
  it('簡中含圖 HTML → 繁體 + 台灣詞,結構/圖片/連結保留;code/alt 也轉(對齊 proxy 整份直轉)', async () => {
    const contentHtml = '<p>这款软件通过网络优化了视频质量。</p>'
      + '<figure><img src="https://ex.com/photo.jpg" alt="软件截图"></figure>'
      + '<p>指令示例:<code>调研全球软件市场</code></p>'
      + '<p>更多信息见<a href="https://ex.com">我们的网站</a>。</p>';
    const r = await translateEntry({ title: '软件更新发布', contentHtml }, { engine: 'opencc' });

    expect(r.titleTranslated).toBe('軟體更新發布');
    expect(r.contentTranslated).toContain('軟體');
    expect(r.contentTranslated).toContain('網路');
    expect(r.contentTranslated).toContain('影片');
    // 整份直轉:code 內文與 alt 屬性一樣要繁化(textnode 切段會漏掉這兩處)
    expect(r.contentTranslated).toContain('<code>調研全球軟體市場</code>');
    expect(r.contentTranslated).toContain('alt="軟體截圖"');
    // tag/屬性名/網址不受影響
    expect(r.contentTranslated).toContain('<img src="https://ex.com/photo.jpg"');
    expect(r.contentTranslated).toContain('href="https://ex.com"');
    expect(r.hadMismatch).toBe(false);
    expect(r.usage.inputTokens).toBe(0);
    expect(r.usage.outputTokens).toBe(0);
  });
});

// ─── translateEntry 整合(需 GEMINI_API_KEY)───
const apiKey = process.env.GEMINI_API_KEY;
const liveIt = apiKey ? it : it.skip;

describe('translateEntry 整合(需 GEMINI_API_KEY)', () => {
  liveIt('翻譯含圖文章 → 中文譯文 + 圖片與連結保留', async () => {
    const contentHtml = '<p>The new iPhone has a great camera.</p>'
      + '<figure><img src="https://ex.com/photo.jpg" alt="phone"></figure>'
      + '<p>Read more on <a href="https://ex.com">our site</a>.</p>';
    const r = await translateEntry({ title: 'Apple releases new iPhone', contentHtml }, { apiKey });

    expect(r.titleTranslated).toMatch(/[一-鿿]/);
    expect(r.contentTranslated).toMatch(/[一-鿿]/);
    // 結構保留:圖片與連結原樣存在
    expect(r.contentTranslated).toContain('<img src="https://ex.com/photo.jpg"');
    expect(r.contentTranslated).toContain('href="https://ex.com"');
    expect(r.hadMismatch).toBe(false);
  }, 45_000);
});

// ─── 標題回填 / last_run(離線)───
describe('processFeed:標題回填與 last_run', () => {
  const fixedNow = () => 1000;
  const fakeTranslate = async ({ title, contentHtml }) => ({
    titleTranslated: title, contentTranslated: contentHtml,
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, hadMismatch: false,
  });
  const makeFetch = (items, extra = {}) => async () => ({
    notModified: false, title: '來源標題', items, etag: null, lastModified: null, ...extra,
  });
  let ctx;
  beforeEach(() => { ctx = createDb(':memory:'); });

  it('feed 沒填標題 → 首次抓取回填來源標題;已有標題不覆蓋', async () => {
    const noTitle = ctx.feeds.create({ source_url: 'https://ex.com/a' });
    const hasTitle = ctx.feeds.create({ source_url: 'https://ex.com/b', title: '我取的名字' });
    const deps = { apiKey: 'x', now: fixedNow, fetchFeed: makeFetch([]), translateEntry: fakeTranslate };
    await processFeed(ctx, noTitle, deps);
    await processFeed(ctx, hasTitle, deps);
    expect(ctx.feeds.get(noTitle.id).title).toBe('來源標題');
    expect(ctx.feeds.get(hasTitle.id).title).toBe('我取的名字');
  });

  it('getLastRun:成功記結果、失敗記錯誤;沒跑過為 null', async () => {
    const feed = ctx.feeds.create({ source_url: 'https://ex.com/f' });
    expect(getLastRun(ctx, feed.id)).toBeNull();
    const items = [{ guid: 'g1', title: 'A', contentHtml: '<p>x</p>', published_at: 1 }];
    await processFeed(ctx, feed, { apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: fakeTranslate });
    expect(getLastRun(ctx, feed.id)).toMatchObject({ finishedAt: 1000, added: 1, translated: 1, failed: 0 });

    await expect(processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, translateEntry: fakeTranslate,
      fetchFeed: async () => { throw new Error('炸了'); },
    })).rejects.toThrow('炸了');
    expect(getLastRun(ctx, feed.id)).toMatchObject({ error: '炸了' });
  });
});

// ─── fetchFeed 回應大小上限(離線)───
describe('fetchFeed 大小上限', () => {
  const RSS = '<rss version="2.0"><channel><title>T</title></channel></rss>';

  it('content-length 宣告過大 → 拋錯不下載', async () => {
    let textCalled = false;
    const fake = async () => ({
      status: 200, ok: true,
      headers: { get: (h) => (h === 'content-length' ? String(20 * 1024 * 1024) : null) },
      text: async () => { textCalled = true; return RSS; },
    });
    await expect(fetchFeed('https://ex.com/f', { fetchImpl: fake })).rejects.toThrow('回應過大');
    expect(textCalled).toBe(false); // 光看標頭就擋下,沒讀 body
  });

  it('沒宣告 content-length 但實際內容過大 → 拋錯', async () => {
    const fake = async () => ({
      status: 200, ok: true, headers: { get: () => null },
      text: async () => 'x'.repeat(10 * 1024 * 1024 + 1),
    });
    await expect(fetchFeed('https://ex.com/f', { fetchImpl: fake })).rejects.toThrow('回應過大');
  });

  it('正常大小照常解析', async () => {
    const fake = async () => ({
      status: 200, ok: true,
      headers: { get: (h) => (h === 'content-length' ? String(RSS.length) : null) },
      text: async () => RSS,
    });
    const r = await fetchFeed('https://ex.com/f', { fetchImpl: fake });
    expect(r.title).toBe('T');
  });
});
