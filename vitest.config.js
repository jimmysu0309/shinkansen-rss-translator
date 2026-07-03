import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 只跑本專案 test/ 下的測試。
    // vendor/shinkansen 是 submodule,自帶 360+ 個 Playwright spec(需瀏覽器擴充環境),
    // 不屬於本專案測試範圍 —— 明確排除,避免污染 npm test。
    include: ['test/**/*.test.js'],
    exclude: ['vendor/**', 'node_modules/**'],
    // 載入 .env,讓需要 GEMINI_API_KEY 的整合測試拿得到 key(沒 .env 則整合測試自動 skip)
    setupFiles: ['test/setup-env.js'],
  },
});
