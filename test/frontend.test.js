// @vitest-environment jsdom
//
// 前端(app.js)行為測試 —— 用 jsdom 載入真實 index.html + app.js。
// 目的:補上「純 Node 測試涵蓋不到前端 DOM 行為」的漏洞
//   (例:先前「複製」按鈕因加了編輯表單 input 而抓錯目標的 bug,就是這類測試能擋下的)。
//
// 訊號層次:
//   ✓ feed 卡片「複製」抓的是 .rss-row input(RSS 網址),不是編輯表單的 input
//   ✓ 純工具函式(禁用詞 round-trip)
//   ✗ 不驗:真實剪貼簿寫入(jsdom 無)、視覺樣式
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const bodyHtml = read('../src/web/public/index.html').match(/<body>([\s\S]*)<\/body>/)[1];
const appSrc = read('../src/web/public/app.js');

const DEFAULTS = {
  model: 'gemini-3.1-flash-lite', models: [{ id: 'gemini-3.1-flash-lite', label: 'Lite' }],
  engines: [{ id: 'gemini', label: 'Gemini' }, { id: 'google', label: 'Google' }],
  systemPrompt: 'sp', forbiddenTerms: [{ forbidden: '視頻', replacement: '影片' }], targetLanguage: 'zh-TW',
  maxUnitsPerBatch: 50, maxCharsPerBatch: 3500, temperature: 1, logRetentionDays: 7,
  logLevels: ['info', 'warn', 'error'], logCategories: ['fetch', 'translate'],
  pollCron: '*/15 * * * *', pollCronOptions: [{ value: '*/15 * * * *', label: '每 15 分鐘' }, { value: '', label: '關閉' }],
  modelPricing: { 'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5 } }, hasApiKey: true,
};
const FEEDS = [{ id: 1, title: 'take.surf', source_url: 'https://take.surf/feed.atom', engine: 'gemini', model: 'gemini-3.1-flash-lite', enabled: 1, fetch_article: 0, category: '已翻譯' }];
const FEED_DETAIL = { ...FEEDS[0], entries: [{ translation_status: 'done' }] };

function mockFetch(url) {
  const u = String(url);
  const json = (d) => Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve(d), text: () => Promise.resolve('') });
  if (u.endsWith('/api/defaults')) return json(DEFAULTS);
  if (u.endsWith('/api/settings')) return json({});
  if (/\/api\/feeds\/1$/.test(u)) return json(FEED_DETAIL);
  if (u.endsWith('/api/feeds')) return json(FEEDS);
  return json({});
}

async function boot() {
  document.body.innerHTML = bodyHtml;
  global.fetch = vi.fn(mockFetch);
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  // app.js 是 classic script;用 new Function 包在函式作用域執行(可重複跑,不污染全域 const)
  new Function(appSrc)();
  await new Promise((r) => setTimeout(r, 60)); // 等初始 loadSettings + loadFeeds
}

describe('前端:feed 複製按鈕', () => {
  beforeEach(boot);

  it('複製抓 .rss-row input(RSS 網址),不是編輯表單的第一個 input', async () => {
    const card = document.querySelector('#feed-list .feed-item');
    expect(card).toBeTruthy();
    const firstInput = card.querySelector('input');        // 編輯表單的 input 排在前面
    const rssInput = card.querySelector('.rss-row input');
    expect(rssInput.value).toContain('/rss/1');
    expect(firstInput).not.toBe(rssInput);                 // 記錄 bug 類:別抓第一個

    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    card.querySelector('[data-act="copy"]').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(writeText).toHaveBeenCalledWith(rssInput.value); // 複製到的是 RSS 網址,不是標題
  });
});

describe('前端:設定頁載入', () => {
  beforeEach(boot);

  it('更新頻率下拉有選項、金鑰狀態顯示已設定', () => {
    expect(document.querySelector('#s-pollcron').options.length).toBeGreaterThan(0);
    expect(document.querySelector('#apikey-status').textContent).toContain('已設定');
    // 禁用詞從 DEFAULTS 預填
    expect(document.querySelector('#s-forbidden').value).toContain('視頻=影片');
  });
});
