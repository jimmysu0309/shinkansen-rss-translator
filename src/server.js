// server.js — 進入點:開 DB、載入 .env、註冊靜態前端、排程、listen。
//
// 環境變數:
//   GEMINI_API_KEY   Gemini 金鑰(必填)
//   DB_PATH          SQLite 檔路徑(預設 data/shinkansen-feed.sqlite)
//   PORT             監聽埠(預設 8088)
//   POLL_CRON        排程 cron(預設每 15 分鐘;空字串 = 不排程)

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { createDb } from './db/index.js';
import { buildServer, registerStatic, DEFAULT_LOG_RETENTION_DAYS } from './web/server.js';
import { processAllFeeds, pruneLogs } from './pipeline/run.js';

// 載入 .env(沒有也不報錯)
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envPath);

const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL('../data/shinkansen-feed.sqlite', import.meta.url));
const PORT = Number(process.env.PORT) || 8088;
const POLL_CRON = process.env.POLL_CRON ?? '*/15 * * * *';

if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });

const ctx = createDb(DB_PATH);
const app = buildServer(ctx, { logger: true });
await registerStatic(app);

// 依保留天數清舊 log
const retention = () => ctx.settings.get('logRetentionDays', DEFAULT_LOG_RETENTION_DAYS);
const pruned = pruneLogs(ctx, retention());
if (pruned) app.log.info(`啟動清理:刪除 ${pruned} 筆過期 log`);

// 排程:定期處理所有啟用中的 feed
if (POLL_CRON && process.env.GEMINI_API_KEY) {
  cron.schedule(POLL_CRON, async () => {
    app.log.info('排程觸發:處理所有 feed');
    try {
      const results = await processAllFeeds(ctx, { apiKey: process.env.GEMINI_API_KEY });
      app.log.info({ results }, '排程完成');
      pruneLogs(ctx, retention()); // 每次排程後清舊 log
    } catch (err) {
      app.log.error({ err }, '排程失敗');
    }
  });
  app.log.info(`已排程:${POLL_CRON}`);
}

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Shinkansen-Feed 已啟動:http://localhost:${PORT}  (DB: ${DB_PATH})`);
