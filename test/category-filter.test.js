// 逐 feed「依分類排除文章」(feeds.exclude_categories)
//
// 訊號層次:
//   ✓ 純函式:清單解析 / 正規化 / 完全比對(不分大小寫、不做子字串)
//   ✓ parseFeedXml:RSS <category> 與 Atom <category term> 都解成字串陣列
//   ✓ processFeed:命中的文章不入庫、不翻譯;未設定時行為不變;已入庫舊文章不追溯
//   ✓ DB 遷移 + DAO 白名單
//   ✗ 不驗:API / 表單形狀(web.test.js / frontend.test.js);來源站真實分類命名(部署時驗)
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { parseCategoryList, normalizeExcludeCategories, matchExcludedCategory } from '../src/pipeline/category-filter.js';
import { parseFeedXml } from '../src/pipeline/fetch-feed.js';
import { processFeed } from '../src/pipeline/run.js';
import { createDb } from '../src/db/index.js';

describe('category-filter 純函式', () => {
  it('parseCategoryList:逗號(半形/全形)與換行分隔、去空白、不分大小寫去重', () => {
    expect(parseCategoryList(' Installer, The Stepback ，Optimizer\ninstaller,, ')).toEqual(['Installer', 'The Stepback', 'Optimizer']);
    expect(parseCategoryList(['A', ' B ', ''])).toEqual(['A', 'B']);
    expect(parseCategoryList(null)).toEqual([]);
    expect(parseCategoryList('')).toEqual([]);
  });

  it('normalizeExcludeCategories:空 → null;否則「, 」接起', () => {
    expect(normalizeExcludeCategories('  ')).toBeNull();
    expect(normalizeExcludeCategories(null)).toBeNull();
    expect(normalizeExcludeCategories([])).toBeNull();
    expect(normalizeExcludeCategories('Installer,The Stepback')).toBe('Installer, The Stepback');
  });

  it('matchExcludedCategory:整個分類名完全相符(不分大小寫)才命中,不做子字串', () => {
    const ex = 'Installer, The Stepback';
    expect(matchExcludedCategory(['AI', 'Column', 'The Stepback'], ex)).toBe('The Stepback');
    expect(matchExcludedCategory(['installer'], ex)).toBe('installer');
    expect(matchExcludedCategory(['Stepback'], ex)).toBeNull();          // 子字串不算
    expect(matchExcludedCategory(['The Stepback Extra'], ex)).toBeNull();
    expect(matchExcludedCategory(['Installer'], null)).toBeNull();       // 未設定 → 永不命中
    expect(matchExcludedCategory(undefined, ex)).toBeNull();             // 文章沒分類
  });
});

describe('parseFeedXml:分類', () => {
  it('Atom <category term> → 字串陣列(The Verge 形狀)', async () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>V</title>
      <entry><title>T</title><id>https://ex.com/?p=1</id><link rel="alternate" href="https://ex.com/1"/>
        <category scheme="https://ex.com" term="AI"/><category scheme="https://ex.com" term="The Stepback"/>
        <content type="html">&lt;p&gt;x&lt;/p&gt;</content></entry></feed>`;
    const { items } = await parseFeedXml(xml);
    expect(items[0].categories).toEqual(['AI', 'The Stepback']);
  });

  it('RSS <category>(含帶 domain 屬性的)→ 字串陣列;沒分類 → 空陣列', async () => {
    const xml = `<rss version="2.0"><channel><title>x</title>
      <item><title>a</title><guid>1</guid><category>Foo</category><category domain="d">Bar</category></item>
      <item><title>b</title><guid>2</guid></item></channel></rss>`;
    const { items } = await parseFeedXml(xml);
    expect(items[0].categories).toEqual(['Foo', 'Bar']);
    expect(items[1].categories).toEqual([]);
  });
});

describe('processFeed:依分類排除', () => {
  const fixedNow = () => 1000;
  let calls;
  const fakeTranslate = async ({ title, contentHtml }) => {
    calls.push(title);
    return { titleTranslated: `譯:${title}`, contentTranslated: contentHtml, usage: { inputTokens: 1, outputTokens: 1 }, hadMismatch: false };
  };
  const items = [
    { guid: 'g1', title: 'Normal', url: 'https://ex.com/1', contentHtml: '<p>a</p>', published_at: 1, categories: ['Tech'] },
    { guid: 'g2', title: 'Newsletter', url: 'https://ex.com/2', contentHtml: '<p>b</p>', published_at: 2, categories: ['Column', 'The Stepback'] },
    { guid: 'g3', title: 'NoCats', url: 'https://ex.com/3', contentHtml: '<p>c</p>', published_at: 3 },
  ];
  const fetchFeed = async () => ({ notModified: false, title: 'F', items, etag: null, lastModified: null });

  it('命中的文章不入庫、不翻譯;其他照常', async () => {
    calls = [];
    const ctx = createDb(':memory:');
    const feed = ctx.feeds.create({ source_url: 'https://ex.com/feed', exclude_categories: 'Installer, The Stepback' });
    const r = await processFeed(ctx, feed, { apiKey: 'x', now: fixedNow, fetchFeed, translateEntry: fakeTranslate });
    expect(r).toMatchObject({ fetched: 3, added: 2, translated: 2 });
    expect(ctx.entries.listByFeed(feed.id).map((e) => e.guid).sort()).toEqual(['g1', 'g3']);
    expect(calls).not.toContain('Newsletter');
  });

  it('未設定 → 行為不變(全部入庫)', async () => {
    calls = [];
    const ctx = createDb(':memory:');
    const feed = ctx.feeds.create({ source_url: 'https://ex.com/feed' });
    const r = await processFeed(ctx, feed, { apiKey: 'x', now: fixedNow, fetchFeed, translateEntry: fakeTranslate });
    expect(r.added).toBe(3);
  });

  it('已入庫的舊文章不追溯(不刪)', async () => {
    calls = [];
    const ctx = createDb(':memory:');
    let feed = ctx.feeds.create({ source_url: 'https://ex.com/feed' });
    await processFeed(ctx, feed, { apiKey: 'x', now: fixedNow, fetchFeed, translateEntry: fakeTranslate });
    feed = ctx.feeds.update(feed.id, { exclude_categories: 'The Stepback' });
    await processFeed(ctx, feed, { apiKey: 'x', now: fixedNow, fetchFeed, translateEntry: fakeTranslate });
    expect(ctx.entries.listByFeed(feed.id)).toHaveLength(3);
  });
});

describe('DB:exclude_categories 遷移', () => {
  it('舊 DB 補欄位(null = 不排除);DAO 可寫可清', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-migrate-exc-'));
    const tmp = join(dir, 'old.sqlite');
    const raw = new Database(tmp);
    raw.exec(`CREATE TABLE feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_url TEXT NOT NULL UNIQUE, title TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, engine TEXT NOT NULL DEFAULT 'gemini',
      model TEXT, service_tier TEXT, fetch_article INTEGER NOT NULL DEFAULT 0,
      target_language TEXT, system_prompt TEXT, max_entries INTEGER, etag TEXT, last_modified TEXT,
      last_checked_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL)`);
    raw.prepare('INSERT INTO feeds (source_url, created_at) VALUES (?, 0)').run('https://old.com/feed');
    raw.close();

    const m = createDb(tmp);
    const old = m.feeds.getByUrl('https://old.com/feed');
    expect(old.exclude_categories).toBeNull();
    expect(m.feeds.update(old.id, { exclude_categories: 'A, B' }).exclude_categories).toBe('A, B');
    expect(m.feeds.update(old.id, { exclude_categories: null }).exclude_categories).toBeNull();
    expect(m.feeds.create({ source_url: 'https://new.com/feed', exclude_categories: 'X' }).exclude_categories).toBe('X');
    m.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
