// SQLite DAO 測試(離線,用 :memory: 隔離)。
//
// 訊號層次:
//   ✓ settings kv round-trip(含 JSON 物件值)
//   ✓ feeds CRUD + 部分更新白名單 + fetch meta
//   ✓ entries 依 (feed_id, guid) 去重 —— 防重複翻譯的核心
//   ✓ entries 狀態流轉(pending → done / error)
//   ✓ usage 記錄與統計加總
//   ✗ 不驗:真實檔案持久化(WAL/併發);那在部署階段驗
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createDb } from '../src/db/index.js';
import { SCHEMA_SQL } from '../src/db/schema.js';

let ctx;
beforeEach(() => { ctx = createDb(':memory:'); });

describe('settings DAO', () => {
  it('set/get round-trip,支援物件值', () => {
    ctx.settings.set('model', 'gemini-3.1-flash-lite');
    ctx.settings.set('forbidden', [{ forbidden: '視頻', replacement: '影片' }]);
    expect(ctx.settings.get('model')).toBe('gemini-3.1-flash-lite');
    expect(ctx.settings.get('forbidden')).toEqual([{ forbidden: '視頻', replacement: '影片' }]);
  });
  it('不存在回 fallback;remove 生效', () => {
    expect(ctx.settings.get('nope', 'def')).toBe('def');
    ctx.settings.set('k', 1);
    ctx.settings.remove('k');
    expect(ctx.settings.get('k', null)).toBe(null);
  });
  it('set 同鍵是覆寫(upsert)', () => {
    ctx.settings.set('k', 'a');
    ctx.settings.set('k', 'b');
    expect(ctx.settings.get('k')).toBe('b');
    expect(ctx.settings.all()).toEqual({ k: 'b' });
  });
});

describe('feeds DAO', () => {
  it('create 帶預設值;getByUrl 找得到', () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/feed', title: 'Ex' }, 1000);
    expect(f.id).toBeGreaterThan(0);
    expect(f.enabled).toBe(1);
    expect(f.engine).toBe('gemini');
    expect(f.fetch_article).toBe(0);
    expect(f.created_at).toBe(1000);
    expect(ctx.feeds.getByUrl('https://ex.com/feed').id).toBe(f.id);
  });

  it('source_url 唯一,重複 create 丟錯', () => {
    ctx.feeds.create({ source_url: 'https://dup.com/feed' });
    expect(() => ctx.feeds.create({ source_url: 'https://dup.com/feed' })).toThrow();
  });

  it('update 只改白名單欄位,布林正規化', () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/feed' });
    const u = ctx.feeds.update(f.id, { fetch_article: true, model: 'gemini-3-flash-preview', enabled: false });
    expect(u.fetch_article).toBe(1);
    expect(u.model).toBe('gemini-3-flash-preview');
    expect(u.enabled).toBe(0);
  });

  it('list enabledOnly 過濾停用 feed', () => {
    const a = ctx.feeds.create({ source_url: 'https://a.com/feed' });
    ctx.feeds.create({ source_url: 'https://b.com/feed' });
    ctx.feeds.update(a.id, { enabled: false });
    expect(ctx.feeds.list().length).toBe(2);
    expect(ctx.feeds.list({ enabledOnly: true }).length).toBe(1);
  });

  it('update source_url 可改網址,且連帶清 etag/last_modified(避免對新網址送舊快取)', () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/feed' });
    ctx.feeds.setFetchMeta(f.id, { etag: 'W/"abc"', lastModified: 'Mon, 01 Jan 2026' });
    const u = ctx.feeds.update(f.id, { source_url: 'https://new.com/feed' });
    expect(u.source_url).toBe('https://new.com/feed');
    expect(u.etag).toBeNull();
    expect(u.last_modified).toBeNull();
  });

  it('update source_url 值未變 → etag 保留', () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/feed' });
    ctx.feeds.setFetchMeta(f.id, { etag: 'W/"abc"' });
    const u = ctx.feeds.update(f.id, { source_url: 'https://ex.com/feed', title: 'T' });
    expect(u.etag).toBe('W/"abc"');
    expect(u.title).toBe('T');
  });

  it('setFetchMeta 更新 etag / 錯誤', () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/feed' });
    const u = ctx.feeds.setFetchMeta(f.id, { etag: 'W/"abc"', checkedAt: 5000 });
    expect(u.etag).toBe('W/"abc"');
    expect(u.last_checked_at).toBe(5000);
  });

  it('listErrorsByFeed 只回失敗文章,附錯誤訊息', () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/feed' });
    const { entry: a } = ctx.entries.upsertNew({ feed_id: f.id, guid: 'g1', title: 'A', url: 'https://ex.com/1' });
    ctx.entries.upsertNew({ feed_id: f.id, guid: 'g2', title: 'B' });
    ctx.entries.markError(a.id, 'boom');
    const errs = ctx.entries.listErrorsByFeed(f.id);
    expect(errs).toHaveLength(1);
    expect(errs[0].title).toBe('A');
    expect(errs[0].translation_error).toBe('boom');
  });

  it('dismissError:error → done、清 translation_error;非 error 狀態不動', () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/feed' });
    const { entry: a } = ctx.entries.upsertNew({ feed_id: f.id, guid: 'g1' });
    const { entry: b } = ctx.entries.upsertNew({ feed_id: f.id, guid: 'g2' });
    ctx.entries.markError(a.id, 'boom');
    expect(ctx.entries.dismissError(a.id)).toBe(true);
    const after = ctx.entries.listErrorsByFeed(f.id);
    expect(after).toHaveLength(0);
    expect(ctx.entries.dismissError(b.id)).toBe(false); // pending 不可清
    expect(ctx.entries.dismissError(99999)).toBe(false);
  });

  it('remove 刪除 feed 並連帶刪 entries(CASCADE)', () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/feed' });
    ctx.entries.upsertNew({ feed_id: f.id, guid: 'g1' });
    expect(ctx.feeds.remove(f.id)).toBe(true);
    expect(ctx.entries.listByFeed(f.id)).toEqual([]);
  });
});

describe('entries DAO — 去重是核心', () => {
  let feedId;
  beforeEach(() => { feedId = ctx.feeds.create({ source_url: 'https://ex.com/feed' }).id; });

  it('相同 (feed_id, guid) 第二次 upsert 不重複插入', () => {
    const r1 = ctx.entries.upsertNew({ feed_id: feedId, guid: 'g1', title: 'A' });
    const r2 = ctx.entries.upsertNew({ feed_id: feedId, guid: 'g1', title: 'A(again)' });
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);          // 去重:沒插入
    expect(ctx.entries.listByFeed(feedId).length).toBe(1);
    expect(ctx.entries.getByGuid(feedId, 'g1').title).toBe('A'); // 保留原本,不覆寫
  });

  it('author 隨插入存放;重抓時只補缺、不覆寫既有值', () => {
    ctx.entries.upsertNew({ feed_id: feedId, guid: 'g1', title: 'A' });          // 舊條目沒作者
    expect(ctx.entries.getByGuid(feedId, 'g1').author).toBe(null);
    ctx.entries.upsertNew({ feed_id: feedId, guid: 'g1', author: 'Emma Roth' }); // 重抓 → 補值
    expect(ctx.entries.getByGuid(feedId, 'g1').author).toBe('Emma Roth');
    ctx.entries.upsertNew({ feed_id: feedId, guid: 'g1', author: '別人' });      // 已有 → 不覆寫
    expect(ctx.entries.getByGuid(feedId, 'g1').author).toBe('Emma Roth');
  });

  it('不同 feed 的相同 guid 各自獨立', () => {
    const feed2 = ctx.feeds.create({ source_url: 'https://ex2.com/feed' }).id;
    expect(ctx.entries.upsertNew({ feed_id: feedId, guid: 'same' }).inserted).toBe(true);
    expect(ctx.entries.upsertNew({ feed_id: feed2, guid: 'same' }).inserted).toBe(true);
  });

  it('狀態流轉:pending → done', () => {
    const { entry } = ctx.entries.upsertNew({ feed_id: feedId, guid: 'g1' });
    expect(entry.translation_status).toBe('pending');
    const done = ctx.entries.markDone(entry.id, {
      titleTranslated: '標題', contentTranslated: '<p>內文</p>',
      tokensIn: 100, tokensOut: 20, translatedAt: 9000,
    });
    expect(done.translation_status).toBe('done');
    expect(done.content_translated).toBe('<p>內文</p>');
    expect(done.tokens_out).toBe(20);
    expect(ctx.entries.pendingByFeed(feedId)).toEqual([]);
  });

  it('狀態流轉:pending → error', () => {
    const { entry } = ctx.entries.upsertNew({ feed_id: feedId, guid: 'g1' });
    const e = ctx.entries.markError(entry.id, new Error('boom'));
    expect(e.translation_status).toBe('error');
    expect(e.translation_error).toContain('boom');
  });

  it('countPending 跨 feed 計數', () => {
    ctx.entries.upsertNew({ feed_id: feedId, guid: 'g1' });
    ctx.entries.upsertNew({ feed_id: feedId, guid: 'g2' });
    expect(ctx.entries.countPending()).toBe(2);
  });

  it('updateContent 覆蓋原文 HTML', () => {
    const e = ctx.entries.upsertNew({ feed_id: feedId, guid: 'g1', content_html: '<p>舊</p>' }).entry;
    ctx.entries.updateContent(e.id, '<p>全文</p>');
    expect(ctx.entries.get(e.id).content_html).toBe('<p>全文</p>');
  });

  it('resetErrorsToPending 把 error 重設回 pending', () => {
    const a = ctx.entries.upsertNew({ feed_id: feedId, guid: 'g1' }).entry;
    const b = ctx.entries.upsertNew({ feed_id: feedId, guid: 'g2' }).entry;
    ctx.entries.markError(a.id, 'x');
    ctx.entries.markDone(b.id, {}); // done 不受影響
    const n = ctx.entries.resetErrorsToPending(feedId);
    expect(n).toBe(1);
    expect(ctx.entries.getByGuid(feedId, 'g1').translation_status).toBe('pending');
    expect(ctx.entries.getByGuid(feedId, 'g2').translation_status).toBe('done');
  });

  it('resetAllToPending 把 done + error 全部重設(整 feed 重譯)', () => {
    const a = ctx.entries.upsertNew({ feed_id: feedId, guid: 'g1' }).entry;
    const b = ctx.entries.upsertNew({ feed_id: feedId, guid: 'g2' }).entry;
    ctx.entries.markDone(a.id, {});
    ctx.entries.markError(b.id, 'x');
    const n = ctx.entries.resetAllToPending(feedId);
    expect(n).toBe(2);
    expect(ctx.entries.pendingByFeed(feedId)).toHaveLength(2);
  });

  it('pruneByFeed:只留最新 keep 篇(published_at 新→舊),別的 feed 不受影響', () => {
    const feed2 = ctx.feeds.create({ source_url: 'https://ex2.com/feed' }).id;
    for (let i = 1; i <= 5; i++) {
      ctx.entries.upsertNew({ feed_id: feedId, guid: `g${i}`, title: `t${i}`, published_at: i * 1000 });
    }
    ctx.entries.upsertNew({ feed_id: feed2, guid: 'other', published_at: 1 });
    const removed = ctx.entries.pruneByFeed(feedId, 3);
    expect(removed).toBe(2);
    // 留下的是 published_at 最新的 3 篇(g3, g4, g5)
    expect(ctx.entries.listByFeed(feedId).map((e) => e.guid).sort()).toEqual(['g3', 'g4', 'g5']);
    expect(ctx.entries.listByFeed(feed2)).toHaveLength(1); // 別的 feed 沒被掃到
  });

  it('pruneByFeed:沒 published_at 的視為最舊先刪;篇數 <= keep 不刪', () => {
    ctx.entries.upsertNew({ feed_id: feedId, guid: 'no-date', published_at: null });
    ctx.entries.upsertNew({ feed_id: feedId, guid: 'newer', published_at: 2000 });
    expect(ctx.entries.pruneByFeed(feedId, 1)).toBe(1);
    expect(ctx.entries.listByFeed(feedId)[0].guid).toBe('newer');
    expect(ctx.entries.pruneByFeed(feedId, 5)).toBe(0); // 未超額不刪
  });

  it('statusCountsByFeed:一次 GROUP BY 回各 feed 的狀態篇數', () => {
    const feed2 = ctx.feeds.create({ source_url: 'https://ex2.com/feed' }).id;
    const a = ctx.entries.upsertNew({ feed_id: feedId, guid: 'g1' }).entry;
    ctx.entries.upsertNew({ feed_id: feedId, guid: 'g2' });
    const c = ctx.entries.upsertNew({ feed_id: feed2, guid: 'g1' }).entry;
    ctx.entries.markDone(a.id, {});
    ctx.entries.markError(c.id, 'x');
    const m = ctx.entries.statusCountsByFeed();
    expect(m.get(feedId)).toEqual({ pending: 1, done: 1, error: 0 });
    expect(m.get(feed2)).toEqual({ pending: 0, done: 0, error: 1 });
  });
});

describe('usage DAO', () => {
  it('log 後統計加總正確', () => {
    ctx.usage.log({ ts: 1000, model: 'gemini-3.1-flash-lite', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 5 } });
    ctx.usage.log({ ts: 2000, model: 'gemini-3.1-flash-lite', usage: { inputTokens: 200, outputTokens: 30 } });
    const s = ctx.usage.getStats();
    expect(s.calls).toBe(2);
    expect(s.input_tokens).toBe(300);
    expect(s.output_tokens).toBe(50);
    expect(s.cached_tokens).toBe(5);
  });

  it('getStats 時間範圍過濾(半開區間 [from, to))', () => {
    ctx.usage.log({ ts: 1000, usage: { inputTokens: 10, outputTokens: 1 } });
    ctx.usage.log({ ts: 5000, usage: { inputTokens: 20, outputTokens: 2 } });
    const s = ctx.usage.getStats({ from: 900, to: 2000 });
    expect(s.calls).toBe(1);
    expect(s.input_tokens).toBe(10);
  });

  it('getByModel 分組', () => {
    ctx.usage.log({ ts: 1, model: 'lite', usage: { inputTokens: 10, outputTokens: 5 } });
    ctx.usage.log({ ts: 2, model: 'flash', usage: { inputTokens: 20, outputTokens: 40 } });
    const rows = ctx.usage.getByModel();
    expect(rows[0].model).toBe('flash'); // 依 output_tokens 排序
    expect(rows.find(r => r.model === 'lite').input_tokens).toBe(10);
  });

  it('getDaily 依日彙總', () => {
    const day1 = Date.parse('2025-07-01T08:00:00');
    const day2 = Date.parse('2025-07-02T08:00:00');
    ctx.usage.log({ ts: day1, model: 'lite', usage: { inputTokens: 10, outputTokens: 5 } });
    ctx.usage.log({ ts: day1 + 3600_000, model: 'lite', usage: { inputTokens: 20, outputTokens: 5 } });
    ctx.usage.log({ ts: day2, model: 'lite', usage: { inputTokens: 100, outputTokens: 5 } });
    const rows = ctx.usage.getDaily();
    expect(rows.length).toBe(2);
    expect(rows[0].day).toBe('2025-07-01');
    expect(rows[0].calls).toBe(2);
    expect(rows[0].input_tokens).toBe(30);
    expect(rows[1].day).toBe('2025-07-02');
  });

  it('getRaw join feed / entry 標題(供 CSV)', () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/feed', title: '來源A' });
    const { entry } = ctx.entries.upsertNew({ feed_id: f.id, guid: 'g1', title: '文章A' });
    ctx.usage.log({ ts: 1000, feedId: f.id, entryId: entry.id, model: 'lite', usage: { inputTokens: 10, outputTokens: 5 } });
    const rows = ctx.usage.getRaw();
    expect(rows).toHaveLength(1);
    expect(rows[0].feed_title).toBe('來源A');
    expect(rows[0].entry_title).toBe('文章A');
  });

  it('getRecords 回最近 N 筆(新到舊,含時間 + 模型)', () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/feed', title: 'F' });
    ctx.usage.log({ ts: 1000, feedId: f.id, model: 'lite', usage: { inputTokens: 10, outputTokens: 5 } });
    ctx.usage.log({ ts: 3000, feedId: f.id, model: 'flash', usage: { inputTokens: 20, outputTokens: 8 } });
    const recs = ctx.usage.getRecords({ limit: 10 });
    expect(recs).toHaveLength(2);
    expect(recs[0].ts).toBe(3000); // 新到舊
    expect(recs[0].model).toBe('flash');
    expect(recs[0].feed_title).toBe('F');
    // 分頁:limit 1 offset 1 → 第二筆(較舊)
    const page2 = ctx.usage.getRecords({ limit: 1, offset: 1 });
    expect(page2).toHaveLength(1);
    expect(page2[0].ts).toBe(1000);
  });
});

describe('logs DAO', () => {
  it('append / query(新到舊)', () => {
    ctx.logs.append({ ts: 1000, level: 'info', category: 'fetch', message: '抓取 A' });
    ctx.logs.append({ ts: 2000, level: 'error', category: 'translate', message: '翻譯失敗 B' });
    const all = ctx.logs.query();
    expect(all).toHaveLength(2);
    expect(all[0].message).toBe('翻譯失敗 B'); // 新到舊
  });

  it('遷移:舊 DB 的 feeds.category 欄位被刪除(分類功能移除)', () => {
    // 模擬 v1.3 以前的 DB:自建含 category 欄的 feeds 表,再走 createDb 的 migrate
    const tmp = join(mkdtempSync(join(tmpdir(), 'sf-migrate-')), 'old.sqlite');
    const raw = new Database(tmp);
    raw.exec(`CREATE TABLE feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_url TEXT NOT NULL UNIQUE, title TEXT,
      category TEXT, enabled INTEGER NOT NULL DEFAULT 1, engine TEXT NOT NULL DEFAULT 'gemini',
      model TEXT, service_tier TEXT, fetch_article INTEGER NOT NULL DEFAULT 0,
      target_language TEXT, system_prompt TEXT, etag TEXT, last_modified TEXT,
      last_checked_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL)`);
    raw.prepare("INSERT INTO feeds (source_url, title, category, created_at) VALUES (?, ?, ?, 0)")
      .run('https://old.com/feed', '舊feed', '科技');
    raw.close();

    const migrated = createDb(tmp);
    const cols = migrated.db.pragma('table_info(feeds)').map((c) => c.name);
    expect(cols).not.toContain('category');
    expect(migrated.feeds.getByUrl('https://old.com/feed').title).toBe('舊feed'); // 其他資料保留
    migrated.db.close();
    rmSync(tmp, { force: true });
  });

  it('依 level / category 過濾', () => {
    ctx.logs.append({ ts: 1, level: 'info', category: 'fetch', message: 'a' });
    ctx.logs.append({ ts: 2, level: 'error', category: 'fetch', message: 'b' });
    ctx.logs.append({ ts: 3, level: 'error', category: 'translate', message: 'c' });
    expect(ctx.logs.query({ level: 'error' })).toHaveLength(2);
    expect(ctx.logs.query({ category: 'fetch' })).toHaveLength(2);
    expect(ctx.logs.query({ level: 'error', category: 'fetch' })).toHaveLength(1);
    // count 與 query 過濾一致;offset 分頁
    expect(ctx.logs.count({ level: 'error' })).toBe(2);
    expect(ctx.logs.query({ level: 'error', limit: 1, offset: 1 })).toHaveLength(1);
  });

  it('關鍵字 q 過濾:訊息 / 細節 / feed 標題都搜得到,count 同步', () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/feed', title: 'Daring Fireball' });
    ctx.logs.append({ ts: 1, level: 'error', category: 'fetch', message: '抓取失敗:DF', feedId: f.id, detail: 'Unclosed root tag' });
    ctx.logs.append({ ts: 2, level: 'info', category: 'translate', message: '已翻譯:某文章' });
    expect(ctx.logs.query({ q: '抓取失敗' })).toHaveLength(1);       // 訊息
    expect(ctx.logs.query({ q: 'Unclosed' })).toHaveLength(1);       // 細節
    expect(ctx.logs.query({ q: 'Fireball' })).toHaveLength(1);       // feed 標題
    expect(ctx.logs.query({ q: '找不到的字' })).toHaveLength(0);
    expect(ctx.logs.count({ q: 'Fireball' })).toBe(1);
    expect(ctx.logs.query({ q: 'Fireball', level: 'info' })).toHaveLength(0); // 與其他條件可疊加
  });

  it('detail 物件會序列化;join feed 標題', () => {
    const f = ctx.feeds.create({ source_url: 'https://ex.com/feed', title: '來源A' });
    ctx.logs.append({ ts: 1, level: 'info', category: 'translate', message: 'x', feedId: f.id, detail: { tokens: 100 } });
    const row = ctx.logs.query()[0];
    expect(row.detail).toContain('tokens');
    expect(row.feed_title).toBe('來源A');
  });

  it('pruneBefore 刪除舊 log', () => {
    ctx.logs.append({ ts: 1000, level: 'info', message: '舊' });
    ctx.logs.append({ ts: 5000, level: 'info', message: '新' });
    const removed = ctx.logs.pruneBefore(3000);
    expect(removed).toBe(1);
    expect(ctx.logs.query()).toHaveLength(1);
    expect(ctx.logs.query()[0].message).toBe('新');
  });

  it('clear 清空所有 log', () => {
    ctx.logs.append({ ts: 1, level: 'info', message: 'a' });
    ctx.logs.append({ ts: 2, level: 'info', message: 'b' });
    expect(ctx.logs.clear()).toBe(2);
    expect(ctx.logs.query()).toHaveLength(0);
  });
});

describe('migration:舊 DB 補 author 欄', () => {
  it('開啟沒有 author 欄的既有 DB → createDb 自動 ALTER 補上,舊資料保留', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'skf-migrate-')), 'old.sqlite');
    // 模擬部署中的舊 DB:拿現行 schema 去掉 author 欄行(等同加欄前的版本)
    const oldSchema = SCHEMA_SQL.replace(/^\s*author\s+TEXT.*\n/m, '');
    expect(oldSchema).not.toContain('author'); // 護欄:確認真的拿掉了
    const old = new Database(dbPath);
    old.exec(oldSchema);
    old.exec(`
      INSERT INTO feeds (source_url, created_at) VALUES ('https://ex.com/feed', 1);
      INSERT INTO entries (feed_id, guid, title, created_at) VALUES (1, 'g1', '舊文章', 1);
    `);
    old.close();

    const migrated = createDb(dbPath);
    const e = migrated.entries.getByGuid(1, 'g1');
    expect(e.title).toBe('舊文章');
    expect(e.author).toBe(null); // 欄位存在且為空
    migrated.entries.upsertNew({ feed_id: 1, guid: 'g1', author: 'Emma Roth' });
    expect(migrated.entries.getByGuid(1, 'g1').author).toBe('Emma Roth');
    migrated.db.close();
  });
});

describe('usage.clear', () => {
  it('清空所有用量紀錄', () => {
    ctx.usage.log({ ts: 1, model: 'lite', usage: { inputTokens: 10, outputTokens: 5 } });
    ctx.usage.log({ ts: 2, model: 'lite', usage: { inputTokens: 20, outputTokens: 5 } });
    expect(ctx.usage.clear()).toBe(2);
    expect(ctx.usage.getStats().calls).toBe(0);
  });
});
