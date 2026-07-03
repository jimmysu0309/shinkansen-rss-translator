// vitest setupFile:把專案根 .env 載入 process.env,讓整合測試(需 GEMINI_API_KEY)拿得到 key。
// 沒有 .env 也不報錯 —— 那種情況整合測試會自動 skip(見 engine.test.js 的 liveIt)。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
}
