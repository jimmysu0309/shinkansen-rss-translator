// 管線測試:fetch 解析、單篇翻譯、編排器。
//
// 訊號層次:
//   ✓ parseFeedXml:RSS / Atom 正規化(guid/title/content:encoded/日期)
//   ✓ processFeed 編排(注入 fake fetch/translate,offline):去重、只翻 pending、記帳、逐篇容錯、304
//   ✓ translateEntry 整合(需 key):真翻一篇含圖 HTML → 中文 + 圖片保留 + 段數相符
//   ✗ 不驗:真實網路抓取(部署驗)
import { describe, it, expect, beforeEach } from 'vitest';
import { parseFeedXml, fetchFeed } from '../src/pipeline/fetch-feed.js';
import { processFeed, processAllFeeds, pruneLogs, getLastRun } from '../src/pipeline/run.js';
import { translateEntry } from '../src/pipeline/translate-entry.js';
import { createDb } from '../src/db/index.js';

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

  it('fetch_article 抓全文失敗 → 退回原摘要,仍翻譯', async () => {
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
  });

  it('沒 guid 的 item 跳過(無法去重)', async () => {
    const items = [{ guid: null, title: 'X', contentHtml: '<p>z</p>', published_at: 1 }];
    const r = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: fakeTranslate,
    });
    expect(r.added).toBe(0);
    expect(ctx.entries.listByFeed(feed.id)).toHaveLength(0);
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
