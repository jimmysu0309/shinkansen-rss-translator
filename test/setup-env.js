// vitest setupFile:把專案根 .env 載入 process.env,讓整合測試(需 GEMINI_API_KEY)拿得到 key。
// 沒有 .env 也不報錯 —— 那種情況整合測試會自動 skip(見 engine.test.js 的 liveIt)。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// jsdom 測試環境的 import.meta.url 不是 file://,fileURLToPath 會丟錯 → 包起來略過
try {
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
} catch { /* 非 file:// 環境(jsdom),沒 .env 也無妨 */ }
