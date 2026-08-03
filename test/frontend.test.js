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
  version: '9.9.9',
  model: 'gemini-3.1-flash-lite', models: [{ id: 'gemini-3.1-flash-lite', label: 'Lite' }],
  engines: [{ id: 'gemini', label: 'Gemini' }, { id: 'google', label: 'Google' }],
  systemPrompt: 'sp', forbiddenTerms: [{ forbidden: '視頻', replacement: '影片' }], targetLanguage: 'zh-TW',
  maxUnitsPerBatch: 50, maxCharsPerBatch: 3500, temperature: 1, logRetentionDays: 7, maxEntriesPerFeed: 300,
  logLevels: ['info', 'warn', 'error'], logCategories: ['fetch', 'translate'],
  pollCron: '*/15 * * * *', pollCronOptions: [{ value: '*/15 * * * *', label: '每 15 分鐘' }, { value: '', label: '關閉' }],
  modelPricing: { 'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5 } }, hasApiKey: true,
};
// counts 由伺服器列表附上(前端不再逐 feed 撈詳情)
const FEEDS = [
  { id: 1, title: 'take.surf', source_url: 'https://take.surf/feed.atom', engine: 'gemini', model: 'gemini-3.1-flash-lite', enabled: 1, fetch_article: 0, counts: { done: 1, pending: 0, error: 0 } },
  { id: 2, title: 'err.feed', source_url: 'https://err.example/feed', engine: 'gemini', model: null, enabled: 1, fetch_article: 0, counts: { done: 3, pending: 0, error: 2 } },
];
const FEED2_ERRORS = [
  { id: 9, title: '壞文章', url: 'https://err.example/a1', translation_error: 'Gemini API 500: internal error' },
  { id: 10, title: null, url: null, translation_error: '譯文段數不符' },
];

const USAGE = {
  total: { cost: 0.07, calls: 25, input_tokens: 400, output_tokens: 130, cached_tokens: 0, cacheHitRate: 0 },
  daily: [],
  byFeed: [
    { feed_id: 1, feed_title: 'Bravo', calls: 5, input_tokens: 100, output_tokens: 50, cached_tokens: 0, cost: 0.02 },
    { feed_id: 2, feed_title: 'Alpha', calls: 20, input_tokens: 300, output_tokens: 80, cached_tokens: 0, cost: 0.05 },
  ],
  pending: 0,
};

function mockFetch(url) {
  const u = String(url);
  const json = (d) => Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve(d), text: () => Promise.resolve('') });
  if (u.endsWith('/api/defaults')) return json(DEFAULTS);
  if (u.endsWith('/api/backup/import')) return json({ settings: 1, feedsAdded: 2, feedsUpdated: 0, feedsSkipped: 0 });
  if (u.endsWith('/api/settings')) return json({});
  if (u.endsWith('/api/feeds/2/errors')) return json(FEED2_ERRORS);
  if (u.endsWith('/api/feeds')) return json(FEEDS);
  if (u.includes('/api/usage/records')) return json({ records: [], total: 0 });
  if (u.includes('/api/usage')) return json(USAGE);
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

describe('前端:feed 卡片狀態徽章', () => {
  beforeEach(boot);

  it('徽章用列表附的 counts 渲染(不再逐 feed 撈詳情)', () => {
    const card = document.querySelector('#feed-list .feed-item');
    expect(card.textContent).toContain('1 已翻');
    // 只打了一次 /api/feeds,沒有 /api/feeds/1 詳情請求
    const calls = global.fetch.mock.calls.map(c => String(c[0]));
    expect(calls.some(u => /\/api\/feeds\/1$/.test(u))).toBe(false);
  });
});

describe('前端:失敗 badge 展開失敗原因', () => {
  beforeEach(boot);

  it('點「N 失敗」→ 撈 /errors 顯示標題與錯誤;再點一次收合', async () => {
    const card = document.querySelector('#feed-list .feed-item[data-id="2"]');
    const badge = card.querySelector('button.badge.error[data-act="errors"]');
    expect(badge.textContent).toContain('2 失敗');
    const panel = card.querySelector('.feed-errors');
    expect(panel.hidden).toBe(true);

    badge.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain('壞文章');
    expect(panel.textContent).toContain('Gemini API 500: internal error');
    expect(panel.textContent).toContain('(無標題)');
    expect(panel.textContent).toContain('譯文段數不符');
    expect(panel.querySelector('a').href).toBe('https://err.example/a1');

    badge.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(panel.hidden).toBe(true);
  });

  it('沒失敗的 feed 不渲染失敗 badge', () => {
    const card1 = document.querySelector('#feed-list .feed-item[data-id="1"]');
    expect(card1.querySelector('[data-act="errors"]')).toBeNull();
  });
});

describe('前端:各 feed 用量排序', () => {
  beforeEach(boot);

  const feedCol = () => [...document.querySelectorAll('#u-byfeed tbody tr td:first-child')].map(td => td.textContent);
  const callsCol = () => [...document.querySelectorAll('#u-byfeed tbody tr td:nth-child(2)')].map(td => td.textContent);

  it('預設依費用降冪;點欄位標頭可改排序 + 切升降', async () => {
    document.querySelector('.tab[data-tab="usage"]').click();
    await new Promise(r => setTimeout(r, 30));
    // 預設 cost desc → Alpha(0.05) 在 Bravo(0.02) 前
    expect(feedCol()).toEqual(['Alpha', 'Bravo']);

    // 點「Feed」欄 → 文字升冪 A→B
    document.querySelector('#u-byfeed th[data-key="feed_title"]').click();
    expect(feedCol()).toEqual(['Alpha', 'Bravo']);
    // 再點一次 → 降冪 B→A
    document.querySelector('#u-byfeed th[data-key="feed_title"]').click();
    expect(feedCol()).toEqual(['Bravo', 'Alpha']);

    // 點「翻譯篇數」→ 數字降冪(20 在 5 前 → Alpha 先)
    document.querySelector('#u-byfeed th[data-key="calls"]').click();
    expect(callsCol()).toEqual(['20', '5']);
    // 表頭有排序箭頭
    expect(document.querySelector('#u-byfeed th[data-key="calls"]').textContent).toMatch(/▼/);
  });
});

describe('前端:匯入備份', () => {
  beforeEach(boot);

  it('選檔後 POST 整份備份到 /api/backup/import(形狀判讀交給伺服器)', async () => {
    const input = document.querySelector('#backup-file');
    const payload = { exportedAt: '2026-08-03', settings: { model: 'imported-model' }, feeds: [{ source_url: 'https://x.com/f' }] };
    const file = new File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 30));

    const postCall = global.fetch.mock.calls.find(
      (c) => c[1]?.method === 'POST' && String(c[0]).endsWith('/api/backup/import'),
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse(postCall[1].body)).toEqual(payload); // 整份原樣上送
  });
});

describe('前端:feed 啟用/停用 toggle', () => {
  beforeEach(boot);

  it('卡片有 toggle,切換後 PATCH enabled', async () => {
    const card = document.querySelector('#feed-list .feed-item');
    const t = card.querySelector('.feed-toggle');
    expect(t).toBeTruthy();
    expect(t.checked).toBe(true); // FEEDS fixture enabled:1

    t.checked = false;
    t.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));

    const patchCall = global.fetch.mock.calls.find(
      (c) => c[1]?.method === 'PATCH' && String(c[0]).endsWith('/api/feeds/1'),
    );
    expect(patchCall).toBeTruthy();
    expect(JSON.parse(patchCall[1].body)).toEqual({ enabled: false });
  });

  it('編輯面板不再有 enabled 欄位(toggle 是唯一入口,防雙路徑 drift)', () => {
    expect(document.querySelector('#feed-list [data-f="enabled"]')).toBeNull();
  });
});

describe('前端:設定頁載入', () => {
  beforeEach(boot);

  it('更新頻率下拉有選項、金鑰狀態顯示已設定', () => {
    expect(document.querySelector('#s-pollcron').options.length).toBeGreaterThan(0);
    expect(document.querySelector('#apikey-status').textContent).toContain('已設定');
    // 禁用詞從 DEFAULTS 預填
    expect(document.querySelector('#s-forbidden').value).toContain('視頻=影片');
    // 每 feed 文章上限從 DEFAULTS 預填
    expect(document.querySelector('#s-maxentries').value).toBe('300');
  });

  it('標題下方顯示版本與 GitHub 連結;head 有 favicon', () => {
    expect(document.querySelector('#app-version').textContent).toBe('v9.9.9');
    const gh = document.querySelector('.app-meta a');
    expect(gh.href).toContain('github.com/jimmysu0309/shinkansen-rss-translator');
    expect(gh.rel).toContain('noopener');
    // favicon 在 index.html 的 <head>(jsdom 只掛 body,直接驗原始 HTML)
    expect(read('../src/web/public/index.html')).toContain('rel="icon"');
  });
});
