// server.js — Fastify app factory。REST API(設定 / feeds / 用量)+ RSS 輸出 + 靜態前端。
//
// buildServer(ctx, opts) 回傳 fastify 實例但不 listen —— 測試用 app.inject() 免開埠。
//
// 訊號層次:
//   ✓ API 行為:設定讀寫、feeds CRUD、手動刷新、用量統計、RSS 輸出
//   ✗ 不驗:前端 UI 互動(那靠瀏覽器 / 人工);真實 listen(server.js entry 負責)

import Fastify from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildFeedXml } from '../pipeline/rss-output.js';
import { processFeed, isFeedInFlight, getLastRun, DEFAULT_MAX_ENTRIES_PER_FEED } from '../pipeline/run.js';
import { fetchFeed as defaultFetchFeed } from '../pipeline/fetch-feed.js';
import {
  DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT, DEFAULT_FORBIDDEN_TERMS, ENGINES,
  DEFAULT_MAX_UNITS_PER_BATCH, DEFAULT_MAX_CHARS_PER_BATCH, DEFAULT_TEMPERATURE,
  isPromptUnchangedFromDefault,
} from '../engine.js';
import { costForUsage, MODEL_PRICING } from '../pricing.js';
import { feedsToOpml, parseOpml } from '../pipeline/opml.js';
import { APP_VERSION } from '../version.js';

export { APP_VERSION }; // 沿用舊匯出點(版本號單一資料源已移到 src/version.js)

// log 保留天數預設
export const DEFAULT_LOG_RETENTION_DAYS = 7;

// 更新頻率(排程 cron)—— 前端下拉選項,值為 cron 字串,空字串 = 關閉
export const DEFAULT_POLL_CRON = '*/15 * * * *';
export const POLL_CRON_OPTIONS = [
  { value: '*/5 * * * *', label: '每 5 分鐘' },
  { value: '*/15 * * * *', label: '每 15 分鐘' },
  { value: '*/30 * * * *', label: '每 30 分鐘' },
  { value: '0 * * * *', label: '每小時' },
  { value: '0 */2 * * *', label: '每 2 小時' },
  { value: '0 */6 * * *', label: '每 6 小時' },
  { value: '', label: '關閉自動更新' },
];

// 前端下拉可選的模型(便宜 → 貴排序;單價見 src/pricing.js)
export const SELECTABLE_MODELS = [
  { id: 'gemini-3.1-flash-lite', label: 'Lite（gemini-3.1-flash-lite）— 便宜' },
  { id: 'gemini-3.5-flash-lite', label: 'Flash Lite 3.5（gemini-3.5-flash-lite）— 便宜、新一代' },
  { id: 'gemini-3-flash-preview', label: 'Flash（gemini-3-flash-preview）— 品質' },
  { id: 'gemini-3.6-flash', label: 'Flash 3.6（gemini-3.6-flash）— 品質最佳' },
];

// 儲存於 settings 表、但不可透過 GET /api/settings 回傳的敏感鍵
const SECRET_KEYS = new Set(['apiKey']);

// PUT /api/settings 只收這些鍵(白名單):擋垃圾鍵污染 settings 表、匯入亂檔時只取認得的欄位
const SETTING_KEYS = new Set([
  'apiKey', 'engine', 'model', 'targetLanguage', 'systemPrompt', 'forbiddenTerms',
  'fixedGlossary', 'maxUnitsPerBatch', 'maxCharsPerBatch', 'temperature',
  'logRetentionDays', 'pollCron', 'modelPricingOverrides', 'maxEntriesPerFeed',
]);

// 白名單只擋「鍵」;值也要驗型別 —— 亂型別會一路傳進翻譯管線(NaN 批次上限)或前端模板(XSS)。
const NUMERIC_SETTINGS = new Set(['maxUnitsPerBatch', 'maxCharsPerBatch', 'temperature', 'logRetentionDays', 'maxEntriesPerFeed']);
const STRING_SETTINGS = new Set(['apiKey', 'engine', 'model', 'targetLanguage', 'systemPrompt', 'pollCron']);
const ARRAY_SETTINGS = new Set(['forbiddenTerms', 'fixedGlossary']);

// 回清洗後的值;不合型別回 undefined(呼叫端跳過該鍵,不存)
function sanitizeSettingValue(key, v) {
  if (NUMERIC_SETTINGS.has(key)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (STRING_SETTINGS.has(key)) return typeof v === 'string' ? v : undefined;
  if (ARRAY_SETTINGS.has(key)) return Array.isArray(v) ? v : undefined;
  if (key === 'modelPricingOverrides') {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    const out = {};
    for (const [model, o] of Object.entries(v)) {
      if (typeof o !== 'object' || o === null) continue;
      const entry = {};
      for (const f of ['inputPerMTok', 'outputPerMTok', 'cachedDiscount']) {
        const n = Number(o[f]);
        if (o[f] !== undefined && o[f] !== null && o[f] !== '' && Number.isFinite(n) && n >= 0) entry[f] = n;
      }
      if (Object.keys(entry).length) out[model] = entry;
    }
    return out;
  }
  return v;
}

// CSV 欄位跳脫:含逗號 / 引號 / 換行時用雙引號包起來。
// 開頭是 = + - @ 的值補單引號前綴,防 Excel 把 feed/文章標題當公式執行(CSV injection)。
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// feed 來源網址只收 http(s),擋 javascript:/file: 等垃圾輸入
function isHttpUrl(u) {
  try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; }
}

// 常數時間比較(先 sha256 等長化),避免逐字元比對的 timing 洩漏
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function buildServer(ctx, opts = {}) {
  // trustProxy:反向代理(https)後面時,selfUrl / OPML 網址才會用 x-forwarded-* 組出正確 scheme+host
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });

  // 預設 prompt 升級遷移(引擎升級後一次性):DB 存的 systemPrompt 若只是舊版預設的字面值
  // (使用者按過「儲存設定」但沒改內容),視為未客製 → 刪除,讓 vendor 新版預設 prompt 生效。
  // 判定用 vendor 的 isPromptUnchangedFromDefault(normalize 規則跟著上游演進,不自己維護)。
  {
    const saved = ctx.settings.get('systemPrompt');
    if (typeof saved === 'string' && isPromptUnchangedFromDefault(saved, DEFAULT_SYSTEM_PROMPT)) {
      ctx.settings.remove('systemPrompt');
      ctx.logs.append({ level: 'info', category: 'system', message: '偵測到未客製的舊版系統 prompt,已自動升級為新版預設' });
    }
  }

  // ─── 認證(HTTP Basic)───
  // opts.authPassword 有值才啟用;帳號不限、只驗密碼。
  // 豁免 /rss/:id:譯後 feed 要讓 Miniflux 等閱讀器免認證抓取。
  // 用 req.routeOptions.url(路由解析後的 pattern)判斷豁免,不比對原始 req.url ——
  // 原始路徑可被 /rss/../api/x 這類 dot-segment 混淆,route pattern 不會。
  //
  // 防暴力嘗試:同 IP 連續錯 AUTH_MAX_FAILS 次 → 鎖 AUTH_LOCK_MS,期間一律 429(對的密碼也擋)。
  // 訊號層次:測試驗「鎖定觸發」與「成功歸零」;鎖定到期自動解鎖靠時間流逝,不在測試內。
  const AUTH_MAX_FAILS = 10;
  const AUTH_LOCK_MS = opts.authLockMs ?? 15 * 60_000; // opts 供測試縮短鎖定時長
  const authFails = new Map(); // ip → { count, lockedUntil, at };at = 最後失敗時間,過期整筆清掉
  const authPassword = opts.authPassword || '';
  if (authPassword) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.routeOptions?.url === '/rss/:id') return;
      let rec = authFails.get(req.ip);
      // 過期清理:最後失敗超過鎖定時長(含已到期的鎖)→ 整筆刪,Map 不隨掃描流量無限成長
      if (rec && Date.now() - rec.at > AUTH_LOCK_MS) { authFails.delete(req.ip); rec = undefined; }
      if (rec?.lockedUntil > Date.now()) {
        return reply.code(429).send({ error: '嘗試次數過多,請 15 分鐘後再試' });
      }
      const header = req.headers.authorization || '';
      if (header.startsWith('Basic ')) {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const pass = decoded.slice(decoded.indexOf(':') + 1); // 冒號後全部是密碼(帳號忽略)
        if (safeEqual(pass, authPassword)) { authFails.delete(req.ip); return; }
        // 只有「有帶密碼但錯」才計失敗;瀏覽器初次載入的無憑證 401(登入框觸發流程)不算,
        // 否則一頁多請求還沒輸入密碼就被鎖
        const r = rec || { count: 0, lockedUntil: 0, at: 0 };
        r.count++;
        r.at = Date.now();
        if (r.count >= AUTH_MAX_FAILS) { r.lockedUntil = r.at + AUTH_LOCK_MS; r.count = 0; }
        authFails.set(req.ip, r);
        // 護欄:被大量偽造 IP 掃描時全表掃一次過期項,Map 大小有界
        if (authFails.size > 10_000) {
          for (const [ip, v] of authFails) if (Date.now() - v.at > AUTH_LOCK_MS) authFails.delete(ip);
        }
      }
      reply.code(401)
        .header('www-authenticate', 'Basic realm="Shinkansen-Feed", charset="UTF-8"')
        .send({ error: '需要登入' });
    });
  }
  // 有效金鑰:先看 settings(webui 填的),再看啟動 opts / 環境變數
  // 金鑰只從 web 設定(SQLite)取;不再讀 .env / 環境變數。opts.apiKey 供測試注入。
  const apiKey = () => ctx.settings.get('apiKey', '') || opts.apiKey || '';
  // processDeps:測試可注入 fake fetch/translate;正式為 undefined → 用真實實作
  const processDeps = opts.processDeps || {};

  // 建立 feed 時的引擎:未指定 → 用「全域預設引擎」設定。
  // feeds.engine 是 NOT NULL(具體值,不做執行期繼承)—— 全域設定只在「建立當下」套用,
  // 之後改全域不影響既有 feed。POST /api/feeds、OPML 匯入、備份匯入三條建立路徑共用。
  const engineOrDefault = (v) => v || ctx.settings.get('engine', 'gemini');

  // 刷新 / 重翻 / 重譯共用:預設背景執行回 202(整 feed 重譯可能跑數十分鐘,同步等會被
  // requestTimeout / 瀏覽器斷線);?wait=1 保留同步語意(測試與 curl 除錯用)。
  // 完成結果進 last_run(見 run.js),前端輪詢 /api/feeds 的 in_flight 讀取。
  const startFeedJob = (req, reply, feed, extra = {}) => {
    const job = processFeed(ctx, feed, { apiKey: apiKey(), ...processDeps });
    if (req.query.wait) return job.then((r) => ({ ...extra, ...r }));
    job.catch((err) => {
      if (err?.logged) return; // 管線已記過(抓取失敗)
      ctx.logs.append({
        level: 'error', category: 'refresh', feedId: feed.id,
        message: `背景處理失敗:${feed.title || feed.source_url}`, detail: String(err?.message || err),
      });
    });
    reply.code(202);
    return { started: true, ...extra };
  };

  // ─── RSS 輸出 ───
  app.get('/rss/:id', async (req, reply) => {
    const feed = ctx.feeds.get(Number(req.params.id));
    if (!feed) return reply.code(404).send({ error: 'feed 不存在' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const entries = ctx.entries.listByFeed(feed.id, limit);
    // req.host 含 port(Fastify 5 起 req.hostname 不含 port,非 80/443 埠會產出錯網址)
    const selfUrl = `${req.protocol}://${req.host}/rss/${feed.id}`;
    const xml = buildFeedXml({ feed, entries, selfUrl });
    reply.header('content-type', 'application/atom+xml; charset=utf-8').send(xml);
  });

  // ─── 預設值 / 環境狀態(前端預填用)───
  app.get('/api/defaults', async () => ({
    version: APP_VERSION,
    model: DEFAULT_MODEL,
    models: SELECTABLE_MODELS,
    engines: ENGINES,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    forbiddenTerms: DEFAULT_FORBIDDEN_TERMS,
    targetLanguage: 'zh-TW',
    maxUnitsPerBatch: DEFAULT_MAX_UNITS_PER_BATCH,
    maxCharsPerBatch: DEFAULT_MAX_CHARS_PER_BATCH,
    temperature: DEFAULT_TEMPERATURE,
    logRetentionDays: DEFAULT_LOG_RETENTION_DAYS,
    maxEntriesPerFeed: DEFAULT_MAX_ENTRIES_PER_FEED,
    logLevels: ['info', 'warn', 'error'],
    logCategories: ['fetch', 'translate', 'refresh', 'opml', 'system'],
    pollCron: DEFAULT_POLL_CRON,
    pollCronOptions: POLL_CRON_OPTIONS,
    modelPricing: MODEL_PRICING, // 內建計價表(前端 placeholder 用)
    hasApiKey: !!apiKey(), // 前端顯示金鑰是否已設(不回傳 key 本身)
  }));

  // 取設定但濾掉敏感鍵(apiKey 不外洩到前端)
  const publicSettings = () => {
    const all = ctx.settings.all();
    for (const k of SECRET_KEYS) delete all[k];
    return all;
  };

  // 套用一批設定(白名單守門 + 型別清洗)。PUT /api/settings 與備份匯入共用這一條路徑。
  const applySettings = (body) => {
    let applied = 0;
    for (const [k, v] of Object.entries(body)) {
      if (!SETTING_KEYS.has(k)) continue; // 白名單外的鍵忽略
      // apiKey 空字串代表「不變更」,不覆寫既有金鑰
      if (SECRET_KEYS.has(k) && (v === '' || v == null)) continue;
      const clean = sanitizeSettingValue(k, v);
      if (clean === undefined) continue; // 型別不合的值忽略(手寫備份 / API 直打防呆)
      ctx.settings.set(k, clean);
      applied++;
    }
    // 更新頻率有變 → 通知 entry 重新排程(即時生效,免重啟)
    if ('pollCron' in body && typeof opts.onPollCronChange === 'function') {
      opts.onPollCronChange(ctx.settings.get('pollCron', DEFAULT_POLL_CRON));
    }
    return applied;
  };

  // ─── 設定 API ───
  app.get('/api/settings', async () => publicSettings());
  app.put('/api/settings', async (req) => {
    applySettings(req.body || {});
    return publicSettings();
  });

  // ─── 完整備份(設定 + feeds)───
  // 只備份使用者設定欄位,不含抓取狀態(etag / last_* / id)與 apiKey。
  const FEED_BACKUP_FIELDS = ['source_url', 'title', 'enabled', 'engine', 'model',
    'service_tier', 'fetch_article', 'target_language', 'system_prompt'];

  app.get('/api/backup/export', async (req, reply) => {
    reply.header('content-disposition', 'attachment; filename="shinkansen-feed-backup.json"');
    reply.header('content-type', 'application/json; charset=utf-8');
    return {
      exportedAt: new Date().toISOString(),
      version: APP_VERSION,
      settings: publicSettings(),
      feeds: ctx.feeds.list().map((f) => Object.fromEntries(FEED_BACKUP_FIELDS.map((k) => [k, f[k] ?? null]))),
    };
  });

  // 匯入備份。接受三種形狀:完整備份 {settings, feeds}、舊版設定匯出 {settings}、裸設定物件。
  // feeds 以 source_url 為 key upsert:已存在 → 更新設定欄位,不存在 → 新增;文章不動。
  app.post('/api/backup/import', async (req, reply) => {
    const body = req.body || {};
    const settings = body.settings ?? (Array.isArray(body.feeds) ? {} : body);
    const feeds = Array.isArray(body.feeds) ? body.feeds : [];
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      return reply.code(400).send({ error: '備份格式不正確' });
    }
    const applied = applySettings(settings);

    let added = 0, updated = 0, skipped = 0;
    for (const f of feeds) {
      if (!f || !f.source_url || !isHttpUrl(f.source_url)) { skipped++; continue; }
      // 只取備份檔內有出現的欄位:缺欄位不覆寫、不預設(手寫的精簡備份也安全)
      const patch = {};
      for (const k of FEED_BACKUP_FIELDS) if (k in f) patch[k] = f[k];
      const existing = ctx.feeds.getByUrl(f.source_url);
      if (existing) { ctx.feeds.update(existing.id, patch); updated++; }
      else { ctx.feeds.create({ ...patch, engine: engineOrDefault(patch.engine) }); added++; }
    }
    ctx.logs.append({
      level: 'info', category: 'system',
      message: `匯入備份:設定 ${applied} 鍵,feed 新增 ${added}、更新 ${updated}、略過 ${skipped}`,
    });
    return { settings: applied, feedsAdded: added, feedsUpdated: updated, feedsSkipped: skipped };
  });

  // 測試 API 金鑰(打 Gemini models 清單)。可帶 body.apiKey 測「還沒存的新 key」。
  app.post('/api/test-key', async (req) => {
    const key = (req.body && req.body.apiKey) || apiKey();
    if (!key) return { ok: false, error: '沒有金鑰可測試' };
    try {
      const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': key },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        return { ok: false, error: j?.error?.message || `HTTP ${resp.status}` };
      }
      const data = await resp.json();
      return { ok: true, modelCount: (data.models || []).length };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  // ─── feeds API ───
  // 列表附各狀態篇數(counts):一次 GROUP BY 算全部,前端免逐 feed 撈詳情(N+1),
  // 且統計涵蓋所有文章(舊作法只數詳情回傳的最新 20 篇,數字會低估)
  app.get('/api/feeds', async () => {
    const counts = ctx.entries.statusCountsByFeed();
    return ctx.feeds.list().map((f) => ({
      ...f,
      counts: counts.get(f.id) || { pending: 0, done: 0, error: 0 },
      in_flight: isFeedInFlight(f.id),        // 背景處理中(前端輪詢用)
      last_run: getLastRun(ctx, f.id),        // 最近一次處理結果(完成 toast 用)
    }));
  });
  app.get('/api/feeds/:id', async (req, reply) => {
    const f = ctx.feeds.get(Number(req.params.id));
    if (!f) return reply.code(404).send({ error: 'feed 不存在' });
    return {
      ...f,
      entries: ctx.entries.listByFeed(f.id, 20),
      in_flight: isFeedInFlight(f.id),
      last_run: getLastRun(ctx, f.id),
    };
  });
  app.post('/api/feeds', async (req, reply) => {
    const body = req.body || {};
    if (!body.source_url) return reply.code(400).send({ error: 'source_url 必填' });
    if (!isHttpUrl(body.source_url)) return reply.code(400).send({ error: 'source_url 必須是 http(s) 網址' });
    if (ctx.feeds.getByUrl(body.source_url)) return reply.code(409).send({ error: '此 feed 已存在' });
    return reply.code(201).send(ctx.feeds.create({ ...body, engine: engineOrDefault(body.engine) }));
  });
  app.patch('/api/feeds/:id', async (req, reply) => {
    const body = req.body || {};
    // source_url 可編輯,但比照 POST 驗證:http(s) + 不得撞其他 feed(UNIQUE 約束的前置友善檢查)
    if ('source_url' in body) {
      if (!body.source_url || !isHttpUrl(body.source_url)) {
        return reply.code(400).send({ error: 'source_url 必須是 http(s) 網址' });
      }
      const dup = ctx.feeds.getByUrl(body.source_url);
      if (dup && dup.id !== Number(req.params.id)) {
        return reply.code(409).send({ error: '此 feed 網址已被其他 feed 使用' });
      }
    }
    const f = ctx.feeds.update(Number(req.params.id), body);
    if (!f) return reply.code(404).send({ error: 'feed 不存在' });
    return f;
  });
  app.delete('/api/feeds/:id', async (req, reply) => {
    const ok = ctx.feeds.remove(Number(req.params.id));
    if (!ok) return reply.code(404).send({ error: 'feed 不存在' });
    return { ok: true };
  });
  // ─── OPML 匯出 / 匯入 ───
  app.get('/api/feeds/export.opml', async (req, reply) => {
    const feeds = ctx.feeds.list();
    const base = `${req.protocol}://${req.host}`;
    const xml = feedsToOpml(feeds, (f) => `${base}/rss/${f.id}`);
    reply.header('content-disposition', 'attachment; filename="shinkansen-feed.opml"');
    reply.header('content-type', 'text/x-opml; charset=utf-8');
    return xml;
  });

  app.post('/api/feeds/import-opml', async (req, reply) => {
    const opml = req.body && (typeof req.body === 'string' ? req.body : req.body.opml);
    if (!opml) return reply.code(400).send({ error: '缺 OPML 內容' });
    let entries;
    try {
      entries = parseOpml(opml);
    } catch (err) {
      return reply.code(400).send({ error: 'OPML 解析失敗:' + String(err?.message || err) });
    }
    // 自我參照防護:匯入「本服務匯出的 OPML」時,xmlUrl 是自家譯後網址(/rss/N)——
    // 直接收會變成 feed 訂自己的輸出(自己翻自己)。偵測到時退回 htmlUrl(原始來源);沒有就略過。
    const isSelfRss = (u) => {
      try {
        const p = new URL(u);
        return p.host === req.host && /^\/rss\/\d+$/.test(p.pathname);
      } catch { return false; }
    };
    let added = 0, skipped = 0;
    for (const e of entries) {
      let src = e.source_url;
      if (src && isSelfRss(src)) {
        src = (e.html_url && isHttpUrl(e.html_url) && !isSelfRss(e.html_url)) ? e.html_url : null;
      }
      if (!src || !isHttpUrl(src)) { skipped++; continue; } // 缺網址、非 http(s)、或無法還原的自我參照
      if (ctx.feeds.getByUrl(src)) { skipped++; continue; } // 已存在
      ctx.feeds.create({ source_url: src, title: e.title, engine: engineOrDefault(null) });
      added++;
    }
    ctx.logs.append({ level: 'info', category: 'opml', message: `匯入 OPML:新增 ${added}、略過 ${skipped}(共 ${entries.length})` });
    return { added, skipped, total: entries.length };
  });

  // 測試 feed 網址(抓取 + 解析,不儲存)。回標題與前幾篇。
  app.post('/api/test-feed', async (req, reply) => {
    const url = req.body && req.body.source_url;
    if (!url) return reply.code(400).send({ ok: false, error: 'source_url 必填' });
    const fetchImpl = processDeps.fetchFeed || defaultFetchFeed;
    try {
      const res = await fetchImpl(url, {});
      return {
        ok: true,
        title: res.title || '',
        itemCount: res.items.length,
        sampleTitles: res.items.slice(0, 3).map((i) => i.title).filter(Boolean),
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  // 手動刷新單一 feed(預設背景執行回 202;?wait=1 同步等結果)
  app.post('/api/feeds/:id/refresh', async (req, reply) => {
    const feed = ctx.feeds.get(Number(req.params.id));
    if (!feed) return reply.code(404).send({ error: 'feed 不存在' });
    if (isFeedInFlight(feed.id)) return reply.code(409).send({ error: '此 feed 正在處理中,請稍候' });
    // Google 翻譯不需金鑰;只有 Gemini 引擎缺金鑰才擋
    const engine = feed.engine || ctx.settings.get('engine', 'gemini');
    if (engine === 'gemini' && !apiKey()) {
      return reply.code(400).send({ error: '缺 Gemini API 金鑰,請到設定頁填入或改用 Google 翻譯' });
    }
    return startFeedJob(req, reply, feed);
  });

  // 失敗清單:此 feed 翻譯失敗的文章與各自的錯誤訊息(前端點「N 失敗」badge 查看)
  app.get('/api/feeds/:id/errors', async (req, reply) => {
    const feed = ctx.feeds.get(Number(req.params.id));
    if (!feed) return reply.code(404).send({ error: 'feed 不存在' });
    return ctx.entries.listErrorsByFeed(feed.id);
  });

  // 放棄翻譯:失敗文章標成 done(譯文留空 → RSS 輸出退回原文),之後不再重試
  app.post('/api/entries/:id/dismiss-error', async (req, reply) => {
    const ok = ctx.entries.dismissError(Number(req.params.id));
    if (!ok) return reply.code(404).send({ error: '找不到失敗狀態的文章(可能已重翻成功或已清除)' });
    return { ok: true };
  });

  // 重翻:把此 feed 翻譯失敗(error)的文章重設為 pending 再翻一次
  app.post('/api/feeds/:id/retry-errors', async (req, reply) => {
    const feed = ctx.feeds.get(Number(req.params.id));
    if (!feed) return reply.code(404).send({ error: 'feed 不存在' });
    // 撞鎖要在重設狀態「前」擋:先 reset 再發現在跑,這批 pending 會等到下次排程才補翻
    if (isFeedInFlight(feed.id)) return reply.code(409).send({ error: '此 feed 正在處理中,請稍候' });
    const engine = feed.engine || ctx.settings.get('engine', 'gemini');
    if (engine === 'gemini' && !apiKey()) {
      return reply.code(400).send({ error: '缺 Gemini API 金鑰,請到設定頁填入或改用 Google 翻譯' });
    }
    const reset = ctx.entries.resetErrorsToPending(feed.id);
    if (reset === 0) return { reset: 0, translated: 0, failed: 0 };
    return startFeedJob(req, reply, feed, { reset });
  });

  // 整 feed 重譯:所有文章(含已翻)重設 pending 再翻一次(改模型/prompt/抓全文後套用)
  app.post('/api/feeds/:id/retranslate', async (req, reply) => {
    const feed = ctx.feeds.get(Number(req.params.id));
    if (!feed) return reply.code(404).send({ error: 'feed 不存在' });
    if (isFeedInFlight(feed.id)) return reply.code(409).send({ error: '此 feed 正在處理中,請稍候' });
    const engine = feed.engine || ctx.settings.get('engine', 'gemini');
    if (engine === 'gemini' && !apiKey()) {
      return reply.code(400).send({ error: '缺 Gemini API 金鑰,請到設定頁填入或改用 Google 翻譯' });
    }
    const reset = ctx.entries.resetAllToPending(feed.id);
    ctx.logs.append({ level: 'info', category: 'refresh', message: `整 feed 重譯:${feed.title || feed.source_url}(${reset} 篇)`, feedId: feed.id });
    return startFeedJob(req, reply, feed, { reset });
  });

  // ─── 用量 API ───
  const usageRange = (q) => ({
    from: Number(q.from) || 0,
    to: Number(q.to) || Number.MAX_SAFE_INTEGER,
  });

  // 計價覆蓋(使用者在設定頁填的自訂單價)
  const pricingSettings = () => ({ modelPricingOverrides: ctx.settings.get('modelPricingOverrides', {}) });

  app.get('/api/usage', async (req) => {
    const { from, to } = usageRange(req.query);
    const ps = pricingSettings();
    const stats = ctx.usage.getStats({ from, to });

    // 單趟掃 raw:同時算「逐日」與「逐 feed」彙總 + 費用(以每次 feed 翻譯為基準)
    const dayMap = new Map();
    const feedMap = new Map();
    let totalCost = 0;
    // 切日快取:逐列 toLocaleDateString 太貴(每列建 Intl formatter,萬列等級秒差)。
    // rows 依 ts 升冪、同日連續 → 只在跨日界時重算一次(仍是本地時區切日,行為不變)。
    let dayStart = NaN, dayEnd = NaN, dayStr = '';
    const dayOf = (ts) => {
      if (!(ts >= dayStart && ts < dayEnd)) {
        const d = new Date(ts);
        d.setHours(0, 0, 0, 0);
        dayStart = d.getTime();
        dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); // 跨 DST 也準
        dayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      return dayStr;
    };
    for (const r of ctx.usage.getRaw({ from, to })) {
      const cost = costForUsage(r.model, r, ps);
      totalCost += cost;

      const day = dayOf(r.ts); // YYYY-MM-DD(本地)
      let d = dayMap.get(day);
      if (!d) { d = { day, calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost: 0 }; dayMap.set(day, d); }
      d.calls++; d.input_tokens += r.input_tokens; d.output_tokens += r.output_tokens; d.cached_tokens += r.cached_tokens; d.cost += cost;

      const fkey = r.feed_id ?? 'null';
      let fa = feedMap.get(fkey);
      if (!fa) { fa = { feed_id: r.feed_id, feed_title: r.feed_title || '(已刪除或未知)', calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost: 0 }; feedMap.set(fkey, fa); }
      fa.calls++; fa.input_tokens += r.input_tokens; fa.output_tokens += r.output_tokens; fa.cached_tokens += r.cached_tokens; fa.cost += cost;
    }
    const daily = [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
    const byFeed = [...feedMap.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls);

    const cacheHitRate = stats.input_tokens > 0 ? stats.cached_tokens / stats.input_tokens : 0;
    return {
      total: { ...stats, cost: totalCost, cacheHitRate },
      byFeed,
      daily,
      pending: ctx.entries.countPending(),
    };
  });

  // 用量明細分頁(每頁 50 筆)
  app.get('/api/usage/records', async (req) => {
    const { from, to } = usageRange(req.query);
    const ps = pricingSettings();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const records = ctx.usage.getRecords({ from, to, limit, offset }).map((r) => ({
      ts: r.ts, feed_title: r.feed_title, entry_title: r.entry_title, model: r.model,
      input_tokens: r.input_tokens, output_tokens: r.output_tokens,
      cost: costForUsage(r.model, r, ps),
    }));
    return { records, total: ctx.usage.getStats({ from, to }).calls };
  });

  // CSV 匯出(帶 BOM,Excel 可直接開)—— 每列 = 一次 feed 內某篇文章的翻譯
  app.get('/api/usage/export.csv', async (req, reply) => {
    const { from, to } = usageRange(req.query);
    const ps = pricingSettings();
    const rows = ctx.usage.getRaw({ from, to });
    const header = '時間,來源feed,文章,模型,輸入tokens,輸出tokens,快取tokens,費用USD';
    const lines = rows.map((r) => [
      new Date(r.ts).toISOString(), r.feed_title, r.entry_title, r.model,
      r.input_tokens, r.output_tokens, r.cached_tokens, costForUsage(r.model, r, ps).toFixed(6),
    ].map(csvCell).join(','));
    reply.header('content-disposition', 'attachment; filename="shinkansen-feed-usage.csv"');
    reply.header('content-type', 'text/csv; charset=utf-8');
    return '﻿' + header + '\n' + lines.join('\n');
  });

  // 清空用量紀錄
  app.delete('/api/usage', async () => {
    const deleted = ctx.usage.clear();
    ctx.logs.append({ level: 'info', category: 'system', message: `清空用量紀錄(${deleted} 筆)` });
    return { ok: true, deleted };
  });

  // ─── Log API ───(分頁,每頁 50 筆)
  app.get('/api/logs', async (req) => {
    const { from, to } = usageRange(req.query);
    const level = req.query.level || null;
    const category = req.query.category || null;
    const q = (req.query.q || '').trim() || null;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    return {
      logs: ctx.logs.query({ from, to, level, category, q, limit, offset }),
      total: ctx.logs.count({ from, to, level, category, q }),
    };
  });

  app.get('/api/logs/export.csv', async (req, reply) => {
    const { from, to } = usageRange(req.query);
    const level = req.query.level || null;
    const category = req.query.category || null;
    const q = (req.query.q || '').trim() || null;
    const max = opts.logExportMax ?? 100_000; // 上限防吃爆記憶體;opts 供測試縮小
    const rows = ctx.logs.query({ from, to, level, category, q, limit: max });
    const header = '時間,等級,類別,訊息,來源feed,細節';
    const lines = rows.map((r) => [
      new Date(r.ts).toISOString(), r.level, r.category, r.message, r.feed_title || '', r.detail || '',
    ].map(csvCell).join(','));
    // 有截斷要明講,不能讓匯出檔看起來像全量(全域工作流原則:silent cap 是禁區)
    const total = ctx.logs.count({ from, to, level, category, q });
    if (total > rows.length) lines.push(csvCell(`(已達匯出上限,僅含最新 ${rows.length} 筆,符合條件共 ${total} 筆)`));
    reply.header('content-disposition', 'attachment; filename="shinkansen-feed-logs.csv"');
    reply.header('content-type', 'text/csv; charset=utf-8');
    return '﻿' + header + '\n' + lines.join('\n');
  });

  // 清空所有 log
  app.delete('/api/logs', async () => {
    const deleted = ctx.logs.clear();
    return { ok: true, deleted };
  });

  return app;
}

/** 註冊靜態前端(public/)。分開以便測試不需要。 */
export async function registerStatic(app) {
  const fastifyStatic = (await import('@fastify/static')).default;
  const root = fileURLToPath(new URL('./public/', import.meta.url));
  await app.register(fastifyStatic, { root, prefix: '/' });
}
