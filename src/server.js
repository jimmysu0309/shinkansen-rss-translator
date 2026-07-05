// server.js — 進入點:開 DB、載入 .env、註冊靜態前端、排程、listen。
//
// 環境變數:
//   DB_PATH          SQLite 檔路徑(預設 data/shinkansen-feed.sqlite)
//   PORT             監聽埠(預設 8088)
//   POLL_CRON        首次啟動的預設更新頻率(僅當 DB 尚未設過時採用;之後以 web 設定為準)
//
// 註:Gemini 金鑰改由 web 介面「設定」頁輸入(存 SQLite),不再讀環境變數。

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { createDb } from './db/index.js';
import { buildServer, registerStatic, DEFAULT_LOG_RETENTION_DAYS, DEFAULT_POLL_CRON } from './web/server.js';
import { processAllFeeds, pruneLogs } from './pipeline/run.js';

// 載入 .env(沒有也不報錯)—— 只為 PORT / DB_PATH / 初始 POLL_CRON
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envPath);

const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL('../data/shinkansen-feed.sqlite', import.meta.url));
const PORT = Number(process.env.PORT) || 8088;

if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });

const ctx = createDb(DB_PATH);

const retention = () => ctx.settings.get('logRetentionDays', DEFAULT_LOG_RETENTION_DAYS);
const resolveKey = () => ctx.settings.get('apiKey', '');

// 更新頻率來源:web 設定 > 環境變數 POLL_CRON(僅初始預設)> 內建預設
const initialCron = ctx.settings.get('pollCron', process.env.POLL_CRON ?? DEFAULT_POLL_CRON);

// ─── 可重排的排程 ───
let pollTask = null;
function applyPollCron(cronStr) {
  if (pollTask) { pollTask.stop(); pollTask = null; }
  if (!cronStr) { app.log.info('自動更新:已關閉'); return; }
  if (!cron.validate(cronStr)) { app.log.warn(`無效的 cron:${cronStr},略過`); return; }
  pollTask = cron.schedule(cronStr, async () => {
    app.log.info('排程觸發:處理所有 feed');
    try {
      const results = await processAllFeeds(ctx, { apiKey: resolveKey() });
      app.log.info({ results }, '排程完成');
      pruneLogs(ctx, retention());
    } catch (err) {
      app.log.error({ err }, '排程失敗');
    }
  });
  app.log.info(`自動更新已排程:${cronStr}`);
}

// buildServer 需要 onPollCronChange(設定頁改頻率時即時重排)
const app = buildServer(ctx, { logger: true, onPollCronChange: applyPollCron });
await registerStatic(app);

// 啟動清理 log
const pruned = pruneLogs(ctx, retention());
if (pruned) app.log.info(`啟動清理:刪除 ${pruned} 筆過期 log`);

applyPollCron(initialCron);

// log 清理獨立排程(每日 03:30):不能綁在 pollCron 上,否則關閉自動更新後 log 無限累積
cron.schedule('30 3 * * *', () => {
  const n = pruneLogs(ctx, retention());
  if (n) app.log.info(`每日清理:刪除 ${n} 筆過期 log`);
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Shinkansen RSS Translator 已啟動:http://localhost:${PORT}  (DB: ${DB_PATH})`);
