// server.js — Fastify app factory。REST API(設定 / feeds / 用量)+ RSS 輸出 + 靜態前端。
//
// buildServer(ctx, opts) 回傳 fastify 實例但不 listen —— 測試用 app.inject() 免開埠。
//
// 訊號層次:
//   ✓ API 行為:設定讀寫、feeds CRUD、手動刷新、用量統計、RSS 輸出
//   ✗ 不驗:前端 UI 互動(那靠瀏覽器 / 人工);真實 listen(server.js entry 負責)

import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { buildFeedXml } from '../pipeline/rss-output.js';
import { processFeed } from '../pipeline/run.js';
import { fetchFeed as defaultFetchFeed } from '../pipeline/fetch-feed.js';
import {
  DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT, DEFAULT_FORBIDDEN_TERMS, ENGINES,
  DEFAULT_MAX_UNITS_PER_BATCH, DEFAULT_MAX_CHARS_PER_BATCH, DEFAULT_TEMPERATURE,
} from '../engine.js';
import { costForUsage, MODEL_PRICING } from '../pricing.js';
import { feedsToOpml, parseOpml } from '../pipeline/opml.js';

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

// 前端下拉可選的模型(對應現有 rssbox 的 Lite / Flash 兩檔)
export const SELECTABLE_MODELS = [
  { id: 'gemini-3.1-flash-lite', label: 'Lite（gemini-3.1-flash-lite）— 便宜' },
  { id: 'gemini-3-flash-preview', label: 'Flash（gemini-3-flash-preview）— 品質' },
];

// 儲存於 settings 表、但不可透過 GET /api/settings 回傳的敏感鍵
const SECRET_KEYS = new Set(['apiKey']);

// CSV 欄位跳脫:含逗號 / 引號 / 換行時用雙引號包起來
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildServer(ctx, opts = {}) {
  const app = Fastify({ logger: opts.logger ?? false });
  // 有效金鑰:先看 settings(webui 填的),再看啟動 opts / 環境變數
  // 金鑰只從 web 設定(SQLite)取;不再讀 .env / 環境變數。opts.apiKey 供測試注入。
  const apiKey = () => ctx.settings.get('apiKey', '') || opts.apiKey || '';
  // processDeps:測試可注入 fake fetch/translate;正式為 undefined → 用真實實作
  const processDeps = opts.processDeps || {};

  // ─── RSS 輸出 ───
  app.get('/rss/:id', async (req, reply) => {
    const feed = ctx.feeds.get(Number(req.params.id));
    if (!feed) return reply.code(404).send({ error: 'feed 不存在' });
    const entries = ctx.entries.listByFeed(feed.id, Number(req.query.limit) || 50);
    const selfUrl = `${req.protocol}://${req.hostname}/rss/${feed.id}`;
    const xml = buildFeedXml({ feed, entries, selfUrl });
    reply.header('content-type', 'application/atom+xml; charset=utf-8').send(xml);
  });

  // ─── 預設值 / 環境狀態(前端預填用)───
  app.get('/api/defaults', async () => ({
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

  // ─── 設定 API ───
  app.get('/api/settings', async () => publicSettings());
  app.put('/api/settings', async (req) => {
    const body = req.body || {};
    for (const [k, v] of Object.entries(body)) {
      // apiKey 空字串代表「不變更」,不覆寫既有金鑰
      if (SECRET_KEYS.has(k) && (v === '' || v == null)) continue;
      ctx.settings.set(k, v);
    }
    // 更新頻率有變 → 通知 entry 重新排程(即時生效,免重啟)
    if ('pollCron' in body && typeof opts.onPollCronChange === 'function') {
      opts.onPollCronChange(ctx.settings.get('pollCron', DEFAULT_POLL_CRON));
    }
    return publicSettings();
  });

  // 匯出設定(JSON 下載)。含所有非敏感設定,不含 apiKey。
  app.get('/api/settings/export', async (req, reply) => {
    reply.header('content-disposition', 'attachment; filename="shinkansen-feed-settings.json"');
    reply.header('content-type', 'application/json; charset=utf-8');
    return { exportedAt: new Date().toISOString(), settings: publicSettings() };
  });

  // 測試 API 金鑰(打 Gemini models 清單)。可帶 body.apiKey 測「還沒存的新 key」。
  app.post('/api/test-key', async (req) => {
    const key = (req.body && req.body.apiKey) || apiKey();
    if (!key) return { ok: false, error: '沒有金鑰可測試' };
    try {
      const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': key },
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
  app.get('/api/feeds', async () => ctx.feeds.list());
  app.get('/api/feeds/:id', async (req, reply) => {
    const f = ctx.feeds.get(Number(req.params.id));
    if (!f) return reply.code(404).send({ error: 'feed 不存在' });
    return { ...f, entries: ctx.entries.listByFeed(f.id, 20) };
  });
  app.post('/api/feeds', async (req, reply) => {
    const body = req.body || {};
    if (!body.source_url) return reply.code(400).send({ error: 'source_url 必填' });
    if (ctx.feeds.getByUrl(body.source_url)) return reply.code(409).send({ error: '此 feed 已存在' });
    return reply.code(201).send(ctx.feeds.create(body));
  });
  app.patch('/api/feeds/:id', async (req, reply) => {
    const f = ctx.feeds.update(Number(req.params.id), req.body || {});
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
    const base = `${req.protocol}://${req.hostname}`;
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
    let added = 0, skipped = 0;
    for (const e of entries) {
      if (!e.source_url) { skipped++; continue; }
      if (ctx.feeds.getByUrl(e.source_url)) { skipped++; continue; } // 已存在
      ctx.feeds.create({ source_url: e.source_url, title: e.title, category: e.category });
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

  // 手動刷新單一 feed
  app.post('/api/feeds/:id/refresh', async (req, reply) => {
    const feed = ctx.feeds.get(Number(req.params.id));
    if (!feed) return reply.code(404).send({ error: 'feed 不存在' });
    // Google 翻譯不需金鑰;只有 Gemini 引擎缺金鑰才擋
    const engine = feed.engine || ctx.settings.get('engine', 'gemini');
    if (engine === 'gemini' && !apiKey()) {
      return reply.code(400).send({ error: '缺 Gemini API 金鑰,請到設定頁填入或改用 Google 翻譯' });
    }
    const result = await processFeed(ctx, feed, { apiKey: apiKey(), ...processDeps });
    return result;
  });

  // 重翻:把此 feed 翻譯失敗(error)的文章重設為 pending 再翻一次
  app.post('/api/feeds/:id/retry-errors', async (req, reply) => {
    const feed = ctx.feeds.get(Number(req.params.id));
    if (!feed) return reply.code(404).send({ error: 'feed 不存在' });
    const reset = ctx.entries.resetErrorsToPending(feed.id);
    if (reset === 0) return { reset: 0, translated: 0, failed: 0 };
    const engine = feed.engine || ctx.settings.get('engine', 'gemini');
    if (engine === 'gemini' && !apiKey()) {
      return reply.code(400).send({ error: '缺 Gemini API 金鑰,請到設定頁填入或改用 Google 翻譯' });
    }
    const r = await processFeed(ctx, feed, { apiKey: apiKey(), ...processDeps });
    return { reset, translated: r.translated, failed: r.failed };
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
    for (const r of ctx.usage.getRaw({ from, to })) {
      const cost = costForUsage(r.model, r, ps);
      totalCost += cost;

      const day = new Date(r.ts).toLocaleDateString('en-CA'); // YYYY-MM-DD(本地)
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
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    return {
      logs: ctx.logs.query({ from, to, level, category, limit, offset }),
      total: ctx.logs.count({ from, to, level, category }),
    };
  });

  app.get('/api/logs/export.csv', async (req, reply) => {
    const { from, to } = usageRange(req.query);
    const level = req.query.level || null;
    const category = req.query.category || null;
    const rows = ctx.logs.query({ from, to, level, category, limit: 100000 });
    const header = '時間,等級,類別,訊息,來源feed,細節';
    const lines = rows.map((r) => [
      new Date(r.ts).toISOString(), r.level, r.category, r.message, r.feed_title || '', r.detail || '',
    ].map(csvCell).join(','));
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
