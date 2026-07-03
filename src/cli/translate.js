// translate.js — Phase 1 冒煙 CLI:餵一段文字 → 印出繁中譯文。
//
// 用法:
//   node src/cli/translate.js "Hello, world."
//   echo "Hello, world." | node src/cli/translate.js
//   node --env-file=.env src/cli/translate.js "..."(讀 .env 的 GEMINI_API_KEY)
//
// npm script:`npm run translate -- "Hello"`
//
// 讀 .env:Node 20.6+ 支援 process.loadEnvFile();若已用 --env-file 則跳過。

import { translateTexts } from '../engine.js';

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function loadEnvFile() {
  // 若環境還沒有 key,嘗試從專案根 .env 載入
  if (process.env.GEMINI_API_KEY) return;
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(new URL('../../.env', import.meta.url));
    }
  } catch { /* 沒 .env 也沒關係,下面會檢查 key */ }
}

async function main() {
  loadEnvFile();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ 缺 GEMINI_API_KEY(放進專案根 .env,或用 --env-file / 環境變數)');
    process.exit(1);
  }

  const argText = process.argv.slice(2).join(' ').trim();
  const text = argText || (await readStdin());
  if (!text) {
    console.error('❌ 沒有輸入文字。用法:node src/cli/translate.js "要翻的文字"');
    process.exit(1);
  }

  // 以空行切成多段,模擬 feed 文章的多段落結構
  const paragraphs = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const inputSegs = paragraphs.length || 1;
  const texts = paragraphs.length ? paragraphs : [text];

  const t0 = Date.now();
  const { translations, usage, hadMismatch } = await translateTexts(texts, { apiKey });
  const ms = Date.now() - t0;

  console.log('\n===== 譯文 =====');
  translations.forEach((t, i) => console.log(texts.length > 1 ? `[${i + 1}] ${t}` : t));
  console.log('\n===== 診斷 =====');
  console.log(`輸入段數: ${inputSegs}  輸出段數: ${translations.length}  ${inputSegs === translations.length ? '✅ 段數相符' : '❌ 段數不符(漏譯風險!)'}`);
  console.log(`hadMismatch: ${hadMismatch}`);
  console.log(`tokens: in=${usage.inputTokens} out=${usage.outputTokens} cached=${usage.cachedTokens}  耗時: ${ms}ms`);
}

main().catch((err) => {
  console.error('翻譯失敗:', err?.message || err);
  process.exit(1);
});
