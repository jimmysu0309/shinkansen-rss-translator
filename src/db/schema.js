// schema.js — Shinkansen-Feed 的 SQLite 資料模型。
//
// 四張表:
//   settings — 全域設定的 key/value(值存 JSON 字串)。API key 建議走環境變數,不進 DB。
//   feeds    — 訂閱來源;逐 feed 可覆寫引擎/模型/是否抓全文/目標語言/system prompt。
//   entries  — 每篇文章;依 (feed_id, guid) 唯一 → 天然去重。存原文與譯文。
//   usage    — 每次翻譯呼叫的 token 用量(從 translateBatch 回傳值寫入,單一資料源)。
//
// 設計註記:
//   - 時間一律存 epoch 毫秒(INTEGER),避免時區歧義。
//   - 布林用 INTEGER 0/1。
//   - translation_status: 'pending' | 'done' | 'error'。

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL           -- JSON 字串
);

CREATE TABLE IF NOT EXISTS feeds (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url         TEXT NOT NULL UNIQUE,
  title              TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  engine             TEXT NOT NULL DEFAULT 'gemini',   -- gemini | openai | google | opencc
  model              TEXT,                             -- null = 用全域預設
  service_tier       TEXT,
  fetch_article      INTEGER NOT NULL DEFAULT 0,       -- 是否用 readability 抓全文
  target_language    TEXT,                             -- null = 用全域預設
  system_prompt      TEXT,                             -- 逐 feed 覆寫;null = 用全域
  max_entries        INTEGER,                          -- 逐 feed 文章上限;null = 用全域 maxEntriesPerFeed,0 = 不限制
  -- 抓取狀態(conditional GET)
  etag               TEXT,
  last_modified      TEXT,
  last_checked_at    INTEGER,
  last_error         TEXT,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id                INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid                   TEXT NOT NULL,
  url                    TEXT,
  title                  TEXT,
  author                 TEXT,     -- 原文作者名(不翻譯;輸出 feed 帶給 Miniflux → Readwise)
  title_translated       TEXT,
  image_url              TEXT,     -- 上游 media:content / enclosure 的封面圖(內文外的那張;輸出時前置成 hero)
  content_html           TEXT,     -- 原文(可能經 readability 抽全文)
  content_translated     TEXT,     -- 譯文 HTML(保留結構與圖片)
  published_at           INTEGER,
  translation_status     TEXT NOT NULL DEFAULT 'pending',
  translation_error      TEXT,
  full_text_retries      INTEGER NOT NULL DEFAULT 0,  -- 全文抓取累計失敗次數(0 = 沒失敗過 / 已補抓成功);>0 表示目前內文是摘要 fallback,下次刷新補抓
  translation_retries    INTEGER NOT NULL DEFAULT 0,  -- 翻譯累計失敗次數(成功 / 手動重翻歸零);自動重試的上限與退避依據
  translation_failed_at  INTEGER,                     -- 最近一次翻譯失敗時間(ms);null = 沒失敗過或升級前的舊 error(視為可立即重試)
  tokens_in              INTEGER NOT NULL DEFAULT 0,
  tokens_out             INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  translated_at          INTEGER,
  UNIQUE (feed_id, guid)
);

CREATE INDEX IF NOT EXISTS idx_entries_feed        ON entries(feed_id);
CREATE INDEX IF NOT EXISTS idx_entries_status      ON entries(feed_id, translation_status);
CREATE INDEX IF NOT EXISTS idx_entries_published   ON entries(feed_id, published_at DESC);

CREATE TABLE IF NOT EXISTS usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  feed_id       INTEGER,
  entry_id      INTEGER,
  model         TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_usage_ts   ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_feed ON usage(feed_id, ts);

-- 翻譯帳本(重翻保險絲):每次「成功翻譯」記一列,以 feed + guid / url 識別文章。
-- 刻意不掛 entries(id):entries 被清掉重插會換 id,而這張表要抓的正是「同一篇被反覆重翻」
-- (2026-09 Atlantic 事故:單篇 6 天被翻 85 次,每次單看都是成功,log 零 warn)。
CREATE TABLE IF NOT EXISTS translation_ledger (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id   INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid      TEXT NOT NULL,
  url       TEXT,
  ts        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_feed_guid ON translation_ledger(feed_id, guid, ts);
CREATE INDEX IF NOT EXISTS idx_ledger_feed_url  ON translation_ledger(feed_id, url, ts);
CREATE INDEX IF NOT EXISTS idx_ledger_ts        ON translation_ledger(ts);

CREATE TABLE IF NOT EXISTS logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  level     TEXT NOT NULL,            -- info | warn | error
  category  TEXT,                     -- fetch | translate | refresh | opml | system
  message   TEXT NOT NULL,
  feed_id   INTEGER,
  detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_ts    ON logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, ts);
CREATE INDEX IF NOT EXISTS idx_logs_cat   ON logs(category, ts);
`;
