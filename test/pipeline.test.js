// 管線測試:fetch 解析、單篇翻譯、編排器。
//
// 訊號層次:
//   ✓ parseFeedXml:RSS / Atom 正規化(guid/title/content:encoded/日期)
//   ✓ processFeed 編排(注入 fake fetch/translate,offline):去重、只翻 pending、記帳、逐篇容錯、304
//   ✓ translateEntry 整合(需 key):真翻一篇含圖 HTML → 中文 + 圖片保留 + 段數相符
//   ✗ 不驗:真實網路抓取(部署驗)
import { describe, it, expect, beforeEach } from 'vitest';
import { parseFeedXml } from '../src/pipeline/fetch-feed.js';
import { processFeed, pruneLogs } from '../src/pipeline/run.js';
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

  it('沒 guid 的 item 跳過(無法去重)', async () => {
    const items = [{ guid: null, title: 'X', contentHtml: '<p>z</p>', published_at: 1 }];
    const r = await processFeed(ctx, feed, {
      apiKey: 'x', now: fixedNow, fetchFeed: makeFetch(items), translateEntry: fakeTranslate,
    });
    expect(r.added).toBe(0);
    expect(ctx.entries.listByFeed(feed.id)).toHaveLength(0);
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
