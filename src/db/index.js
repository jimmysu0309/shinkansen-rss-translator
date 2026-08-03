// db/index.js — 開 SQLite、套 schema、綁定 DAO。
//
// createDb(path) 回傳 { db, settings, feeds, entries, usage } —— 每個 DAO 綁在該 db 上。
// 測試傳 ':memory:' 即得隔離的資料庫,免清理。
//
// better-sqlite3 是同步 API(無 await),對這種低併發、單程序的 feed 伺服器最單純。

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

/**
 * @param {string} [path=':memory:'] SQLite 檔路徑;測試用 ':memory:'
 * @returns {{db, settings, feeds, entries, usage}}
 */
export function createDb(path = ':memory:') {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  migrate(db);

  return {
    db,
    settings: makeSettingsDao(db),
    feeds: makeFeedsDao(db),
    entries: makeEntriesDao(db),
    usage: makeUsageDao(db),
    logs: makeLogsDao(db),
  };
}

// SCHEMA_SQL 的 CREATE TABLE IF NOT EXISTS 不會改既有表 —— 新欄位要在這裡補 ALTER。
function migrate(db) {
  const entryCols = new Set(db.pragma('table_info(entries)').map((c) => c.name));
  if (!entryCols.has('author')) {
    db.exec('ALTER TABLE entries ADD COLUMN author TEXT');
  }
  // 分類功能已移除(分類交給 Miniflux 匯入時處理)—— 既有 DB 把欄位連值一起刪
  const feedCols = new Set(db.pragma('table_info(feeds)').map((c) => c.name));
  if (feedCols.has('category')) {
    db.exec('ALTER TABLE feeds DROP COLUMN category');
  }
}

// ─── settings:JSON kv ───────────────────────────────────────
function makeSettingsDao(db) {
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setStmt = db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const delStmt = db.prepare('DELETE FROM settings WHERE key = ?');
  const allStmt = db.prepare('SELECT key, value FROM settings');

  return {
    /** 取值;不存在回 fallback */
    get(key, fallback = undefined) {
      const row = getStmt.get(key);
      return row ? JSON.parse(row.value) : fallback;
    },
    set(key, value) {
      setStmt.run(key, JSON.stringify(value));
    },
    remove(key) {
      delStmt.run(key);
    },
    all() {
      const out = {};
      for (const { key, value } of allStmt.all()) out[key] = JSON.parse(value);
      return out;
    },
  };
}

// ─── feeds ──────────────────────────────────────────────────
function makeFeedsDao(db) {
  const insert = db.prepare(`
    INSERT INTO feeds (source_url, title, enabled, engine, model, service_tier,
                       fetch_article, target_language, system_prompt, created_at)
    VALUES (@source_url, @title, @enabled, @engine, @model, @service_tier,
            @fetch_article, @target_language, @system_prompt, @created_at)
  `);
  const byId = db.prepare('SELECT * FROM feeds WHERE id = ?');
  const byUrl = db.prepare('SELECT * FROM feeds WHERE source_url = ?');
  const listAll = db.prepare('SELECT * FROM feeds ORDER BY id');
  const listEnabled = db.prepare('SELECT * FROM feeds WHERE enabled = 1 ORDER BY id');
  const del = db.prepare('DELETE FROM feeds WHERE id = ?');
  const setFetchMeta = db.prepare(`
    UPDATE feeds SET etag = @etag, last_modified = @last_modified,
                     last_checked_at = @last_checked_at, last_error = @last_error
    WHERE id = @id
  `);

  const FIELDS = ['title', 'enabled', 'engine', 'model', 'service_tier',
    'fetch_article', 'target_language', 'system_prompt'];

  return {
    create(feed, now) {
      const at = now ?? Date.now();
      const row = {
        source_url: feed.source_url,
        title: feed.title ?? null,
        enabled: feed.enabled === undefined ? 1 : (feed.enabled ? 1 : 0),
        engine: feed.engine ?? 'gemini',
        model: feed.model ?? null,
        service_tier: feed.service_tier ?? null,
        fetch_article: feed.fetch_article ? 1 : 0,
        target_language: feed.target_language ?? null,
        system_prompt: feed.system_prompt ?? null,
        created_at: at,
      };
      const info = insert.run(row);
      return byId.get(info.lastInsertRowid);
    },
    get(id) { return byId.get(id); },
    getByUrl(url) { return byUrl.get(url); },
    list({ enabledOnly = false } = {}) {
      return (enabledOnly ? listEnabled : listAll).all();
    },
    /** 部分更新;只允許白名單欄位 */
    update(id, patch) {
      const cur = byId.get(id);
      if (!cur) return null;
      const sets = [];
      const params = { id };
      for (const f of FIELDS) {
        if (f in patch) {
          let v = patch[f];
          if (f === 'enabled' || f === 'fetch_article') v = v ? 1 : 0;
          sets.push(`${f} = @${f}`);
          params[f] = v ?? null;
        }
      }
      if (sets.length) db.prepare(`UPDATE feeds SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return byId.get(id);
    },
    setFetchMeta(id, { etag = null, lastModified = null, checkedAt = null, error = null }) {
      setFetchMeta.run({ id, etag, last_modified: lastModified, last_checked_at: checkedAt, last_error: error });
      return byId.get(id);
    },
    remove(id) { return del.run(id).changes > 0; },
  };
}

// ─── entries(依 feed_id+guid 去重)──────────────────────────
function makeEntriesDao(db) {
  // 去重核心:INSERT ... ON CONFLICT(feed_id, guid) DO NOTHING。
  // 回傳是否為「新插入」(changes>0),讓管線只翻新條目。
  const insertIgnore = db.prepare(`
    INSERT INTO entries (feed_id, guid, url, title, author, content_html, published_at,
                         translation_status, created_at)
    VALUES (@feed_id, @guid, @url, @title, @author, @content_html, @published_at, 'pending', @created_at)
    ON CONFLICT(feed_id, guid) DO NOTHING
  `);
  // 舊條目補作者:author 欄是後來才加的,來源 feed 還列著的舊文章重抓時補值即可,不必重翻
  const backfillAuthor = db.prepare(`
    UPDATE entries SET author = @author
    WHERE feed_id = @feed_id AND guid = @guid AND (author IS NULL OR author = '')
  `);
  const byId = db.prepare('SELECT * FROM entries WHERE id = ?');
  const byGuid = db.prepare('SELECT * FROM entries WHERE feed_id = ? AND guid = ?');
  const listByFeed = db.prepare('SELECT * FROM entries WHERE feed_id = ? ORDER BY published_at DESC, id DESC LIMIT ?');
  const pendingByFeed = db.prepare("SELECT * FROM entries WHERE feed_id = ? AND translation_status = 'pending' ORDER BY id");
  const countPending = db.prepare("SELECT COUNT(*) n FROM entries WHERE translation_status = 'pending'");
  const statusCounts = db.prepare(
    'SELECT feed_id, translation_status status, COUNT(*) n FROM entries GROUP BY feed_id, translation_status',
  );
  const markDone = db.prepare(`
    UPDATE entries SET title_translated = @title_translated, content_translated = @content_translated,
      translation_status = 'done', translation_error = NULL,
      tokens_in = @tokens_in, tokens_out = @tokens_out, translated_at = @translated_at
    WHERE id = @id
  `);
  const markError = db.prepare(`
    UPDATE entries SET translation_status = 'error', translation_error = @err WHERE id = @id
  `);
  const delByFeed = db.prepare('DELETE FROM entries WHERE feed_id = ?');
  // 保留最新 keep 篇(排序同 listByFeed),其餘刪除 —— 防 entries 無限成長
  const pruneOld = db.prepare(`
    DELETE FROM entries WHERE feed_id = @feed_id AND id NOT IN (
      SELECT id FROM entries WHERE feed_id = @feed_id
      ORDER BY published_at DESC, id DESC LIMIT @keep
    )
  `);

  return {
    /** 插入新條目;已存在則跳過。回傳 { inserted: bool, entry } */
    upsertNew(entry, now) {
      const at = now ?? Date.now();
      const info = insertIgnore.run({
        feed_id: entry.feed_id,
        guid: entry.guid,
        url: entry.url ?? null,
        title: entry.title ?? null,
        author: entry.author ?? null,
        content_html: entry.content_html ?? null,
        published_at: entry.published_at ?? null,
        created_at: at,
      });
      if (info.changes === 0 && entry.author) {
        backfillAuthor.run({ feed_id: entry.feed_id, guid: entry.guid, author: entry.author });
      }
      return { inserted: info.changes > 0, entry: byGuid.get(entry.feed_id, entry.guid) };
    },
    get(id) { return byId.get(id); },
    getByGuid(feedId, guid) { return byGuid.get(feedId, guid); },
    listByFeed(feedId, limit = 50) { return listByFeed.all(feedId, limit); },
    pendingByFeed(feedId) { return pendingByFeed.all(feedId); },
    countPending() { return countPending.get().n; },
    /** 各 feed 的狀態篇數:Map<feed_id, {pending, done, error}>(一次 GROUP BY,供列表附 counts) */
    statusCountsByFeed() {
      const out = new Map();
      for (const r of statusCounts.all()) {
        let c = out.get(r.feed_id);
        if (!c) { c = { pending: 0, done: 0, error: 0 }; out.set(r.feed_id, c); }
        c[r.status] = r.n;
      }
      return out;
    },
    markDone(id, { titleTranslated, contentTranslated, tokensIn = 0, tokensOut = 0, translatedAt }) {
      markDone.run({
        id,
        title_translated: titleTranslated ?? null,
        content_translated: contentTranslated ?? null,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        translated_at: translatedAt ?? Date.now(),
      });
      return byId.get(id);
    },
    markError(id, err) { markError.run({ id, err: String(err).slice(0, 500) }); return byId.get(id); },
    /** 更新原文 HTML(供 fetch_article 抓到全文後覆蓋摘要) */
    updateContent(id, html) {
      db.prepare('UPDATE entries SET content_html = ? WHERE id = ?').run(html, id);
      return byId.get(id);
    },
    /** 把某 feed 的 error 條目重設回 pending(供「重翻」);回傳重設筆數 */
    resetErrorsToPending(feedId) {
      return db.prepare(
        "UPDATE entries SET translation_status='pending', translation_error=NULL WHERE feed_id=? AND translation_status='error'",
      ).run(feedId).changes;
    },
    /** 把某 feed 的所有條目(含 done)重設回 pending(供「整 feed 重譯」);回傳重設筆數 */
    resetAllToPending(feedId) {
      return db.prepare(
        "UPDATE entries SET translation_status='pending', translation_error=NULL WHERE feed_id=?",
      ).run(feedId).changes;
    },
    deleteByFeed(feedId) { return delByFeed.run(feedId).changes; },
    /** 只保留該 feed 最新 keep 篇(published_at 新→舊,同 listByFeed 排序);回傳刪除筆數 */
    pruneByFeed(feedId, keep) {
      return pruneOld.run({ feed_id: feedId, keep }).changes;
    },
  };
}

// ─── usage(用量,單一資料源)─────────────────────────────────
function makeUsageDao(db) {
  const insert = db.prepare(`
    INSERT INTO usage (ts, feed_id, entry_id, model, input_tokens, output_tokens, cached_tokens)
    VALUES (@ts, @feed_id, @entry_id, @model, @input_tokens, @output_tokens, @cached_tokens)
  `);
  const statsRange = db.prepare(`
    SELECT COUNT(*) calls,
           COALESCE(SUM(input_tokens),0)  input_tokens,
           COALESCE(SUM(output_tokens),0) output_tokens,
           COALESCE(SUM(cached_tokens),0) cached_tokens
    FROM usage WHERE ts >= @from AND ts < @to
  `);
  const byModel = db.prepare(`
    SELECT model,
           COUNT(*) calls,
           COALESCE(SUM(input_tokens),0)  input_tokens,
           COALESCE(SUM(output_tokens),0) output_tokens,
           COALESCE(SUM(cached_tokens),0) cached_tokens
    FROM usage WHERE ts >= @from AND ts < @to GROUP BY model ORDER BY output_tokens DESC
  `);
  // 逐日彙總(用本地時區切日)
  const daily = db.prepare(`
    SELECT date(ts/1000, 'unixepoch', 'localtime') AS day,
           COUNT(*) calls,
           COALESCE(SUM(input_tokens),0)  input_tokens,
           COALESCE(SUM(output_tokens),0) output_tokens,
           COALESCE(SUM(cached_tokens),0) cached_tokens
    FROM usage WHERE ts >= @from AND ts < @to GROUP BY day ORDER BY day
  `);
  // CSV 用:原始列 join feed 標題 / entry 標題
  const rawRows = db.prepare(`
    SELECT u.ts, u.feed_id, u.model, u.input_tokens, u.output_tokens, u.cached_tokens,
           f.title AS feed_title, e.title AS entry_title, e.url AS entry_url
    FROM usage u
    LEFT JOIN feeds f   ON f.id = u.feed_id
    LEFT JOIN entries e ON e.id = u.entry_id
    WHERE u.ts >= @from AND u.ts < @to ORDER BY u.ts
  `);
  // 明細(新到舊),支援分頁,供用量頁「明細」表顯示時間 + 模型
  const recentRows = db.prepare(`
    SELECT u.ts, u.model, u.input_tokens, u.output_tokens, u.cached_tokens,
           f.title AS feed_title, e.title AS entry_title
    FROM usage u
    LEFT JOIN feeds f   ON f.id = u.feed_id
    LEFT JOIN entries e ON e.id = u.entry_id
    WHERE u.ts >= @from AND u.ts < @to ORDER BY u.ts DESC LIMIT @limit OFFSET @offset
  `);

  return {
    /** 記一筆用量。usage 形狀 = translateBatch 回傳的 { inputTokens, outputTokens, cachedTokens } */
    log({ ts, feedId = null, entryId = null, model = null, usage = {} }) {
      insert.run({
        ts: ts ?? Date.now(),
        feed_id: feedId,
        entry_id: entryId,
        model,
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
        cached_tokens: usage.cachedTokens ?? 0,
      });
    },
    getStats({ from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
      return statsRange.get({ from, to });
    },
    getByModel({ from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
      return byModel.all({ from, to });
    },
    getDaily({ from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
      return daily.all({ from, to });
    },
    getRaw({ from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
      return rawRows.all({ from, to });
    },
    /** 用量明細分頁(含時間 + 模型 + feed 標題),新到舊 */
    getRecords({ from = 0, to = Number.MAX_SAFE_INTEGER, limit = 50, offset = 0 } = {}) {
      return recentRows.all({ from, to, limit, offset });
    },
    /** 清空所有用量紀錄。回傳刪除筆數。 */
    clear() {
      return db.prepare('DELETE FROM usage').run().changes;
    },
  };
}

// ─── logs(翻譯 / 事件紀錄)─────────────────────────────────
function makeLogsDao(db) {
  const insert = db.prepare(`
    INSERT INTO logs (ts, level, category, message, feed_id, detail)
    VALUES (@ts, @level, @category, @message, @feed_id, @detail)
  `);
  const pruneStmt = db.prepare('DELETE FROM logs WHERE ts < ?');
  const countStmt = db.prepare('SELECT COUNT(*) n FROM logs');

  return {
    /** 寫一筆 log */
    append({ ts, level = 'info', category = 'system', message, feedId = null, detail = null }) {
      insert.run({
        ts: ts ?? Date.now(),
        level, category,
        message: String(message ?? ''),
        feed_id: feedId,
        detail: detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
      });
    },
    /** 查詢:可依 level / category 過濾,新到舊,支援分頁 */
    query({ from = 0, to = Number.MAX_SAFE_INTEGER, level = null, category = null, limit = 50, offset = 0 } = {}) {
      // 加 l. 前綴:JOIN feeds 後欄位可能撞名,一律鎖定 logs 表
      const where = ['l.ts >= @from', 'l.ts < @to'];
      const params = { from, to, limit, offset };
      if (level) { where.push('l.level = @level'); params.level = level; }
      if (category) { where.push('l.category = @category'); params.category = category; }
      return db.prepare(
        `SELECT l.*, f.title AS feed_title FROM logs l
         LEFT JOIN feeds f ON f.id = l.feed_id
         WHERE ${where.join(' AND ')} ORDER BY l.ts DESC LIMIT @limit OFFSET @offset`,
      ).all(params);
    },
    /** 符合過濾條件的總筆數(分頁用) */
    count({ from = 0, to = Number.MAX_SAFE_INTEGER, level = null, category = null } = {}) {
      const where = ['ts >= @from', 'ts < @to'];
      const params = { from, to };
      if (level) { where.push('level = @level'); params.level = level; }
      if (category) { where.push('category = @category'); params.category = category; }
      return db.prepare(`SELECT COUNT(*) n FROM logs WHERE ${where.join(' AND ')}`).get(params).n;
    },
    /** 刪除早於指定時間的 log(保留天數用);回傳刪除筆數 */
    pruneBefore(ts) {
      return pruneStmt.run(ts).changes;
    },
    /** 清空所有 log。回傳刪除筆數。 */
    clear() {
      return db.prepare('DELETE FROM logs').run().changes;
    },
  };
}
