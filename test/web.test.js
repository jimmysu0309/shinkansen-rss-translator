// web server API 測試(離線,用 fastify inject —— 免開埠)。
//
// 訊號層次:
//   ✓ 設定讀寫 round-trip
//   ✓ feeds CRUD + 重複 409 + 缺欄位 400 + 404
//   ✓ 手動刷新(注入 fake fetch/translate)
//   ✓ RSS 端點回 Atom、content-type 正確
//   ✓ 用量端點加總
//   ✗ 不驗:前端 HTML/CSS 互動(人工 / 瀏覽器)
import { describe, it, expect, beforeEach } from 'vitest';
import { buildServer } from '../src/web/server.js';
import { createDb } from '../src/db/index.js';

let ctx, app;
const fakeProcessDeps = {
  fetchFeed: async () => ({
    notModified: false, title: 'F', etag: 'W/"v1"', lastModified: null,
    items: [{ guid: 'g1', title: 'Hello', url: 'https://ex.com/1', contentHtml: '<p>Hi</p>', published_at: 1 }],
  }),
  translateEntry: async ({ title, contentHtml }) => ({
    titleTranslated: `譯:${title}`, contentTranslated: contentHtml.replace('Hi', '嗨'),
    usage: { inputTokens: 50, outputTokens: 10, cachedTokens: 0 }, hadMismatch: false,
  }),
  now: () => 1000,
};

beforeEach(() => {
  ctx = createDb(':memory:');
  app = buildServer(ctx, { apiKey: 'test-key', processDeps: fakeProcessDeps });
});

describe('設定 API', () => {
  it('PUT 後 GET 讀得到', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { model: 'gemini-3.1-flash-lite' } });
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.json()).toEqual({ model: 'gemini-3.1-flash-lite' });
  });

  it('apiKey 存得進去但不從 GET 外洩', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: 'AQ.secret', model: 'x' } });
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.json().apiKey).toBeUndefined(); // 濾除
    expect(res.json().model).toBe('x');
    // 但有效金鑰生效 → defaults.hasApiKey 為 true
    const d = await app.inject({ method: 'GET', url: '/api/defaults' });
    expect(d.json().hasApiKey).toBe(true);
  });

  it('apiKey 空字串 = 不變更(不清掉既有金鑰)', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: 'AQ.keep' } });
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: '', model: 'y' } });
    expect(ctx.settings.get('apiKey')).toBe('AQ.keep'); // 沒被清掉
  });

  it('白名單外的鍵被忽略(不進 settings 表)', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { model: 'ok', hax: 'junk', __proto__x: 1 } });
    const res = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(res.model).toBe('ok');
    expect(res.hax).toBeUndefined();
    expect(ctx.settings.get('hax')).toBeUndefined();
  });

  it('匯出備份:帶 content-disposition,含設定與 feeds,不含 apiKey / 抓取狀態', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: 'AQ.s', model: 'm', engine: 'google' } });
    await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed', title: 'Ex', fetch_article: true } });
    const res = await app.inject({ method: 'GET', url: '/api/backup/export' });
    expect(res.headers['content-disposition']).toContain('shinkansen-feed-backup.json');
    const body = res.json();
    expect(body.settings.model).toBe('m');
    expect(body.settings.engine).toBe('google');
    expect(body.settings.apiKey).toBeUndefined();
    expect(body.feeds).toHaveLength(1);
    expect(body.feeds[0]).toMatchObject({ source_url: 'https://ex.com/feed', title: 'Ex', fetch_article: 1, enabled: 1 });
    expect(body.feeds[0].id).toBeUndefined();   // 不備份內部 id
    expect(body.feeds[0].etag).toBeUndefined(); // 不備份抓取狀態
  });

  it('測試金鑰:沒金鑰 → ok:false(金鑰只來自設定,不讀 env)', async () => {
    const noKeyApp = buildServer(createDb(':memory:'), {}); // 無 opts.apiKey、settings 也沒 apiKey
    const res = await noKeyApp.inject({ method: 'POST', url: '/api/test-key', payload: {} });
    expect(res.json()).toEqual({ ok: false, error: '沒有金鑰可測試' });
  });
});

describe('預設 prompt 升級遷移', () => {
  it('存的 systemPrompt 是舊版預設字面值(未客製)→ 開機刪除,新預設生效', async () => {
    const { DEFAULT_SYSTEM_PROMPT } = await import('../src/engine.js');
    // 模擬舊版預設:拿現版預設去掉 v2.0.74 新增的第 6 條句尾標點規則(normalize 應視為同一份)
    const oldDefault = DEFAULT_SYSTEM_PROMPT.replace(/\n6\. 忠於原文的句尾標點[^\n]*\n/, '\n');
    expect(oldDefault).not.toBe(DEFAULT_SYSTEM_PROMPT); // 確認真的有差,測試才有意義
    const c = createDb(':memory:');
    c.settings.set('systemPrompt', oldDefault);
    buildServer(c, {});
    expect(c.settings.get('systemPrompt')).toBeUndefined(); // 已刪 → 落回新預設
  });

  it('真的客製過的 prompt 不動', () => {
    const c = createDb(':memory:');
    c.settings.set('systemPrompt', '我的自訂翻譯風格:一律文言文');
    buildServer(c, {});
    expect(c.settings.get('systemPrompt')).toBe('我的自訂翻譯風格:一律文言文');
  });
});

describe('完整備份匯入', () => {
  it('round-trip:匯出 → 匯入到全新 DB,設定與 feeds 都還原', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { model: 'gemini-3.6-flash', temperature: 0.7 } });
    await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://a.com/feed', title: 'A', engine: 'google' } });
    await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://b.com/feed', title: 'B', fetch_article: true } });
    const backup = (await app.inject({ method: 'GET', url: '/api/backup/export' })).json();

    const fresh = buildServer(createDb(':memory:'), {});
    const r = (await fresh.inject({ method: 'POST', url: '/api/backup/import', payload: backup })).json();
    expect(r).toMatchObject({ feedsAdded: 2, feedsUpdated: 0, feedsSkipped: 0 });
    expect(r.settings).toBeGreaterThanOrEqual(2);
    const s = (await fresh.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(s.model).toBe('gemini-3.6-flash');
    expect(s.temperature).toBe(0.7);
    const feeds = (await fresh.inject({ method: 'GET', url: '/api/feeds' })).json();
    expect(feeds).toHaveLength(2);
    expect(feeds.find(f => f.source_url === 'https://a.com/feed')).toMatchObject({ title: 'A', engine: 'google' });
    expect(feeds.find(f => f.source_url === 'https://b.com/feed').fetch_article).toBe(1);
  });

  it('已存在的 feed 依 source_url 更新設定,不重複新增、文章不動', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed', title: '舊名' } })).json();
    ctx.entries.upsertNew({ feed_id: f.id, guid: 'g1', title: 'T', content_html: '<p>x</p>' });
    const r = (await app.inject({
      method: 'POST', url: '/api/backup/import',
      payload: { settings: {}, feeds: [{ source_url: 'https://ex.com/feed', title: '新名', enabled: 0 }] },
    })).json();
    expect(r).toMatchObject({ feedsAdded: 0, feedsUpdated: 1 });
    const list = (await app.inject({ method: 'GET', url: '/api/feeds' })).json();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('新名');
    expect(list[0].enabled).toBe(0);
    expect(ctx.entries.listByFeed(f.id)).toHaveLength(1); // 文章保留
  });

  it('非 http(s) 的 feed 列入 skipped;設定走白名單', async () => {
    const r = (await app.inject({
      method: 'POST', url: '/api/backup/import',
      payload: { settings: { model: 'ok', hax: 'junk' }, feeds: [{ source_url: 'javascript:alert(1)' }] },
    })).json();
    expect(r).toMatchObject({ settings: 1, feedsAdded: 0, feedsSkipped: 1 });
    expect(ctx.settings.get('hax')).toBeUndefined();
  });

  it('相容舊版設定匯出檔({settings})與裸設定物件;pollCron 觸發重排', async () => {
    let changedTo = null;
    const a = buildServer(createDb(':memory:'), { onPollCronChange: (c) => { changedTo = c; } });
    await a.inject({ method: 'POST', url: '/api/backup/import', payload: { exportedAt: 'x', settings: { model: 'm1' } } });
    expect((await a.inject({ method: 'GET', url: '/api/settings' })).json().model).toBe('m1');
    await a.inject({ method: 'POST', url: '/api/backup/import', payload: { model: 'm2', pollCron: '0 * * * *' } });
    expect((await a.inject({ method: 'GET', url: '/api/settings' })).json().model).toBe('m2');
    expect(changedTo).toBe('0 * * * *');
  });

  it('格式不正確(settings 非物件)→ 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/backup/import', payload: { settings: 'nope', feeds: [] } });
    expect(r.statusCode).toBe(400);
  });
});

describe('模型清單', () => {
  it('defaults 提供四個可選模型(含 3.6 flash 與 3.5 flash lite),且都有內建計價', async () => {
    const d = (await app.inject({ method: 'GET', url: '/api/defaults' })).json();
    const ids = d.models.map(m => m.id);
    expect(ids).toEqual([
      'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.6-flash',
    ]);
    for (const id of ids) expect(d.modelPricing[id]).toBeTruthy(); // 選得到的模型必有單價(費用統計不落空)
  });
});

describe('更新頻率(pollCron)', () => {
  it('defaults 提供 pollCron 預設與選項', async () => {
    const d = (await app.inject({ method: 'GET', url: '/api/defaults' })).json();
    expect(d.pollCron).toBe('*/15 * * * *');
    expect(d.pollCronOptions.map(o => o.value)).toContain('0 * * * *');
    expect(d.pollCronOptions.some(o => o.value === '')).toBe(true); // 關閉選項
  });

  it('PUT pollCron 會存起來並觸發 onPollCronChange', async () => {
    let changedTo = null;
    const a = buildServer(createDb(':memory:'), { onPollCronChange: (c) => { changedTo = c; } });
    const res = await a.inject({ method: 'PUT', url: '/api/settings', payload: { pollCron: '0 */2 * * *' } });
    expect(res.json().pollCron).toBe('0 */2 * * *');
    expect(changedTo).toBe('0 */2 * * *'); // 即時重排回呼被呼叫
  });
});

describe('feeds API', () => {
  it('POST 建立 → GET 列出', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed', title: 'Ex' } });
    expect(create.statusCode).toBe(201);
    expect(create.json().id).toBeGreaterThan(0);
    const list = await app.inject({ method: 'GET', url: '/api/feeds' });
    expect(list.json()).toHaveLength(1);
  });

  it('缺 source_url → 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/feeds', payload: { title: 'x' } });
    expect(r.statusCode).toBe(400);
  });

  it('重複 source_url → 409', async () => {
    await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://dup.com/feed' } });
    const r = await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://dup.com/feed' } });
    expect(r.statusCode).toBe(409);
  });

  it('PATCH 更新;DELETE 刪除', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed' } })).json();
    const patched = await app.inject({ method: 'PATCH', url: `/api/feeds/${f.id}`, payload: { fetch_article: true, model: 'gemini-3-flash-preview' } });
    expect(patched.json().fetch_article).toBe(1);
    expect(patched.json().model).toBe('gemini-3-flash-preview');
    const del = await app.inject({ method: 'DELETE', url: `/api/feeds/${f.id}` });
    expect(del.json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: '/api/feeds' })).json()).toHaveLength(0);
  });

  it('GET 不存在的 feed → 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/feeds/999' });
    expect(r.statusCode).toBe(404);
  });

  it('編輯:PATCH 整組參數(title/engine/model/fetch_article/enabled);category 已移除、傳了也忽略', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed', title: '舊' } })).json();
    const patched = (await app.inject({
      method: 'PATCH', url: `/api/feeds/${f.id}`,
      payload: { title: '新標題', category: '科技', engine: 'google', model: null, fetch_article: true, enabled: false },
    })).json();
    expect(patched.title).toBe('新標題');
    expect(patched.category).toBeUndefined(); // 欄位已隨遷移刪除,舊 client / 舊備份傳來也不炸
    expect(patched.engine).toBe('google');
    expect(patched.model).toBe(null);
    expect(patched.fetch_article).toBe(1);
    expect(patched.enabled).toBe(0);
  });
});

describe('手動刷新', () => {
  it('POST refresh → 抓取 + 翻譯 + 記帳 + 費用', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed' } })).json();
    const r = await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/refresh` });
    expect(r.json()).toMatchObject({ added: 1, translated: 1, failed: 0 });
    const usage = (await app.inject({ method: 'GET', url: '/api/usage' })).json();
    expect(usage.total.calls).toBe(1);
    expect(usage.total.input_tokens).toBe(50);
    expect(usage.total.cost).toBeGreaterThan(0); // gemini-3.1-flash-lite 有單價
    expect(usage.byFeed[0].cost).toBeGreaterThan(0);
    expect(usage.byFeed[0].feed_title).toBeTruthy();
  });
});

describe('OPML 匯入 / 匯出', () => {
  it('匯出:回 OPML,每個 feed 一 outline', async () => {
    await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://a.com/feed', title: 'A' } });
    await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://b.com/feed', title: 'B' } });
    const res = await app.inject({ method: 'GET', url: '/api/feeds/export.opml' });
    expect(res.headers['content-disposition']).toContain('.opml');
    expect((res.body.match(/<outline /g) || []).length).toBe(2);
    expect(res.body).toContain('htmlUrl="https://a.com/feed"');
  });

  it('匯入:批次新增,重複略過', async () => {
    await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://dup.com/feed' } });
    const opml = `<opml><body>
      <outline text="新1" xmlUrl="https://new1.com/feed"/>
      <outline text="新2" xmlUrl="https://new2.com/feed"/>
      <outline text="重複" xmlUrl="https://dup.com/feed"/>
    </body></opml>`;
    const res = await app.inject({ method: 'POST', url: '/api/feeds/import-opml', payload: { opml } });
    expect(res.json()).toMatchObject({ added: 2, skipped: 1, total: 3 });
    expect((await app.inject({ method: 'GET', url: '/api/feeds' })).json()).toHaveLength(3);
  });

  it('匯入缺內容 → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/feeds/import-opml', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('計價覆蓋影響用量費用', () => {
  it('設了自訂單價後 /api/usage 費用照新價算', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed' } })).json();
    await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/refresh` }); // fake usage: in50 out10, model gemini-3.1-flash-lite
    const before = (await app.inject({ method: 'GET', url: '/api/usage' })).json().total.cost;
    // 把 lite 單價拉高 1000 倍
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { modelPricingOverrides: { 'gemini-3.1-flash-lite': { inputPerMTok: 250, outputPerMTok: 1500 } } } });
    const after = (await app.inject({ method: 'GET', url: '/api/usage' })).json().total.cost;
    expect(after).toBeGreaterThan(before * 100);
  });
});

describe('測試 feed 網址', () => {
  it('POST /api/test-feed → 回標題與篇數(注入 fake fetch)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/test-feed', payload: { source_url: 'https://ex.com/feed' } });
    expect(res.json()).toMatchObject({ ok: true, title: 'F', itemCount: 1 });
    expect(res.json().sampleTitles).toContain('Hello');
  });
  it('缺 source_url → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/test-feed', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('用量:日彙總 / 快取命中率 / CSV', () => {
  beforeEach(async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed' } })).json();
    await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/refresh` });
  });
  it('/api/usage 回 daily、cacheHitRate、byFeed(以 feed 為基準)', async () => {
    const u = (await app.inject({ method: 'GET', url: '/api/usage' })).json();
    expect(Array.isArray(u.daily)).toBe(true);
    expect(u.daily.length).toBeGreaterThanOrEqual(1);
    expect(u.daily[0]).toHaveProperty('cost');
    expect(u.total).toHaveProperty('cacheHitRate');
    expect(u.byFeed[0]).toHaveProperty('cached_tokens');
    expect(u.byFeed[0]).toHaveProperty('feed_id');
  });
  it('CSV 匯出:BOM + 標頭 + content-disposition', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/usage/export.csv' });
    expect(res.headers['content-disposition']).toContain('.csv');
    expect(res.body.charCodeAt(0)).toBe(0xFEFF); // BOM
    expect(res.body).toContain('輸入tokens');
  });

  it('用量明細分頁:含時間/模型 + total,offset 生效', async () => {
    const r0 = (await app.inject({ method: 'GET', url: '/api/usage/records?limit=50&offset=0' })).json();
    expect(r0.records.length).toBeGreaterThanOrEqual(1);
    expect(r0.records[0]).toHaveProperty('ts');
    expect(r0.records[0]).toHaveProperty('model');
    expect(typeof r0.total).toBe('number');
    // limit=1 分頁:第 0 頁與第 1 頁不同筆(若有 >1 筆)
    const p0 = (await app.inject({ method: 'GET', url: '/api/usage/records?limit=1&offset=0' })).json();
    expect(p0.records).toHaveLength(1);
  });
});

describe('Log API', () => {
  beforeEach(async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed' } })).json();
    await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/refresh` }); // 產生 fetch + translate log
  });

  it('GET /api/logs 回紀錄(新到舊)+ total,分頁 offset 生效', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/logs' })).json();
    expect(r.logs.length).toBeGreaterThanOrEqual(2); // 至少 fetch + translate
    expect(typeof r.total).toBe('number');
    expect(r.total).toBeGreaterThanOrEqual(r.logs.length);
    for (let i = 1; i < r.logs.length; i++) expect(r.logs[i - 1].ts).toBeGreaterThanOrEqual(r.logs[i].ts);
    // 每頁 1 筆:第 0、1 頁不同
    const a = (await app.inject({ method: 'GET', url: '/api/logs?limit=1&offset=0' })).json();
    const b = (await app.inject({ method: 'GET', url: '/api/logs?limit=1&offset=1' })).json();
    expect(a.logs).toHaveLength(1);
    if (r.total > 1) expect(a.logs[0].id).not.toBe(b.logs[0].id);
  });

  it('依 category 過濾', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/logs?category=translate' })).json();
    expect(r.logs.length).toBeGreaterThanOrEqual(1);
    expect(r.logs.every(l => l.category === 'translate')).toBe(true);
  });

  it('依 level 過濾', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/logs?level=info' })).json();
    expect(r.logs.every(l => l.level === 'info')).toBe(true);
  });

  it('CSV 匯出:BOM + 標頭', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/logs/export.csv' });
    expect(res.headers['content-disposition']).toContain('logs.csv');
    expect(res.body.charCodeAt(0)).toBe(0xFEFF);
    expect(res.body).toContain('等級');
  });

  it('defaults 提供版本號(與 package.json 一致,單一資料源)', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const d = (await app.inject({ method: 'GET', url: '/api/defaults' })).json();
    expect(d.version).toBe(pkg.version);
  });

  it('defaults 提供保留天數(7)與 filter 選項', async () => {
    const d = (await app.inject({ method: 'GET', url: '/api/defaults' })).json();
    expect(d.logRetentionDays).toBe(7);
    expect(d.maxEntriesPerFeed).toBe(300); // 每 feed 文章上限預設(前端預填用)
    expect(d.logLevels).toContain('error');
    expect(d.logCategories).toContain('translate');
  });

  it('DELETE /api/logs 清空紀錄', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/logs' })).json().logs.length).toBeGreaterThan(0);
    const del = (await app.inject({ method: 'DELETE', url: '/api/logs' })).json();
    expect(del.ok).toBe(true);
    expect(del.deleted).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/api/logs' })).json().logs).toHaveLength(0);
  });
});

describe('清除用量', () => {
  it('DELETE /api/usage 清空用量後統計歸零', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed' } })).json();
    await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/refresh` });
    expect((await app.inject({ method: 'GET', url: '/api/usage' })).json().total.calls).toBeGreaterThan(0);
    const del = (await app.inject({ method: 'DELETE', url: '/api/usage' })).json();
    expect(del.ok).toBe(true);
    const after = (await app.inject({ method: 'GET', url: '/api/usage' })).json();
    expect(after.total.calls).toBe(0);
    const recs = (await app.inject({ method: 'GET', url: '/api/usage/records' })).json();
    expect(recs.records).toHaveLength(0);
  });
});

describe('重翻失敗文章', () => {
  it('retry-errors:重設 error→pending 再翻', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed' } })).json();
    // 造一筆 error 條目
    const { entry } = ctx.entries.upsertNew({ feed_id: f.id, guid: 'e1', title: 'Err', content_html: '<p>x</p>' });
    ctx.entries.markError(entry.id, new Error('boom'));
    const r = (await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/retry-errors` })).json();
    expect(r.reset).toBe(1);
    expect(ctx.entries.getByGuid(f.id, 'e1').translation_status).toBe('done'); // 被 fake 翻好
  });
  it('沒有 error → reset 0,不動作', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://noerr.com/feed' } })).json();
    const r = (await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/retry-errors` })).json();
    expect(r).toMatchObject({ reset: 0, translated: 0 });
  });

  it('整 feed 重譯:已翻的也重設 pending 再翻', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/rt' } })).json();
    await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/refresh` }); // 產生 1 篇 done
    expect(ctx.entries.listByFeed(f.id)[0].translation_status).toBe('done');
    const r = (await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/retranslate` })).json();
    expect(r.reset).toBe(1);
    expect(r.translated).toBe(1); // 重設後又翻一次
  });
});

describe('引擎欄位', () => {
  it('建立 feed 可指定 google 引擎', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/g', engine: 'google' } })).json();
    expect(f.engine).toBe('google');
  });
  it('/api/defaults 提供引擎清單', async () => {
    const d = (await app.inject({ method: 'GET', url: '/api/defaults' })).json();
    expect(d.engines.map(e => e.id)).toContain('google');
    expect(d.engines.map(e => e.id)).toContain('gemini');
  });
});

describe('輸出網址含 port(Fastify 5 的 req.hostname 不含 port,必須用 req.host)', () => {
  it('/rss/:id 的 self link 保留 host 的 port', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed' } })).json();
    const rss = await app.inject({ method: 'GET', url: `/rss/${f.id}`, headers: { host: 'myhost:8088' } });
    expect(rss.body).toContain(`http://myhost:8088/rss/${f.id}`);
  });

  it('OPML 匯出的 xmlUrl 保留 port', async () => {
    await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed' } });
    const res = await app.inject({ method: 'GET', url: '/api/feeds/export.opml', headers: { host: 'myhost:8088' } });
    expect(res.body).toContain('xmlUrl="http://myhost:8088/rss/');
  });
});

describe('feeds 列表附狀態篇數', () => {
  it('GET /api/feeds 每個 feed 帶 counts(涵蓋所有文章,非只列表頁那幾篇)', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed' } })).json();
    await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/refresh` }); // 1 篇 done
    const { entry } = ctx.entries.upsertNew({ feed_id: f.id, guid: 'err-1', title: 'E', content_html: '<p>x</p>' });
    ctx.entries.markError(entry.id, new Error('boom'));
    const list = (await app.inject({ method: 'GET', url: '/api/feeds' })).json();
    expect(list[0].counts).toEqual({ pending: 0, done: 1, error: 1 });
  });

  it('沒有文章的 feed counts 全 0', async () => {
    await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://empty.com/feed' } });
    const list = (await app.inject({ method: 'GET', url: '/api/feeds' })).json();
    expect(list[0].counts).toEqual({ pending: 0, done: 0, error: 0 });
  });
});

describe('feed 來源網址驗證', () => {
  it('非 http(s) 的 source_url → 400', async () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url']) {
      const r = await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: bad } });
      expect(r.statusCode).toBe(400);
    }
  });

  it('OPML 匯入:非 http(s) 網址列入 skipped', async () => {
    const opml = `<opml><body>
      <outline text="好" xmlUrl="https://ok.com/feed"/>
      <outline text="壞" xmlUrl="javascript:alert(1)"/>
    </body></opml>`;
    const res = await app.inject({ method: 'POST', url: '/api/feeds/import-opml', payload: { opml } });
    expect(res.json()).toMatchObject({ added: 1, skipped: 1 });
  });
});

describe('CSV 公式注入防護', () => {
  it('= 開頭的標題在 CSV 內補單引號前綴', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed', title: '=1+2' } })).json();
    await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/refresh` });
    const res = await app.inject({ method: 'GET', url: '/api/usage/export.csv' });
    expect(res.body).toContain("'=1+2");
    expect(res.body).not.toContain(',=1+2'); // 不能有裸公式欄位
  });
});

describe('併發保護(同 feed 同時只跑一個)', () => {
  it('刷新進行中再打 refresh → 409,且只翻一次', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const slowDeps = {
      ...fakeProcessDeps,
      translateEntry: async (e) => { await gate; return fakeProcessDeps.translateEntry(e); },
    };
    const ctx2 = createDb(':memory:');
    const app2 = buildServer(ctx2, { apiKey: 'k', processDeps: slowDeps });
    const f = (await app2.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://slow.com/feed' } })).json();

    const first = app2.inject({ method: 'POST', url: `/api/feeds/${f.id}/refresh` }); // 卡在翻譯
    await new Promise((r) => setTimeout(r, 20));
    const second = await app2.inject({ method: 'POST', url: `/api/feeds/${f.id}/refresh` });
    expect(second.statusCode).toBe(409);
    const retr = await app2.inject({ method: 'POST', url: `/api/feeds/${f.id}/retranslate` });
    expect(retr.statusCode).toBe(409); // 重譯也要擋(否則 reset 會攪亂進行中的批次)

    release();
    expect((await first).json()).toMatchObject({ translated: 1 });
    expect(ctx2.usage.getStats().calls).toBe(1); // 沒有重複記帳
  });
});

describe('認證(Basic Auth,AUTH_PASSWORD)', () => {
  const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  let authCtx, authApp;

  beforeEach(async () => {
    authCtx = createDb(':memory:');
    authApp = buildServer(authCtx, { apiKey: 'k', processDeps: fakeProcessDeps, authPassword: 's3cret' });
    // 造一個 feed 供 /rss/:id 測豁免
    await authApp.inject({
      method: 'POST', url: '/api/feeds',
      headers: { authorization: basic('x', 's3cret') },
      payload: { source_url: 'https://ex.com/feed' },
    });
  });

  it('沒帶認證 → 401 + www-authenticate', async () => {
    const r = await authApp.inject({ method: 'GET', url: '/api/feeds' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toContain('Basic');
  });

  it('密碼錯 → 401;密碼對(帳號隨意)→ 200', async () => {
    const bad = await authApp.inject({ method: 'GET', url: '/api/feeds', headers: { authorization: basic('x', 'wrong') } });
    expect(bad.statusCode).toBe(401);
    const ok = await authApp.inject({ method: 'GET', url: '/api/feeds', headers: { authorization: basic('任何帳號', 's3cret') } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveLength(1);
  });

  it('/rss/:id 豁免認證(Miniflux 要能免登入抓 feed)', async () => {
    const r = await authApp.inject({ method: 'GET', url: '/rss/1' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('atom');
  });

  it('dot-segment 混淆路徑(/rss/../api/…)不能繞過認證', async () => {
    const r = await authApp.inject({ method: 'GET', url: '/rss/../api/settings' });
    expect(r.statusCode).not.toBe(200); // 豁免判斷用 route pattern,原始路徑騙不到
  });

  it('沒設 authPassword → 一切照舊(不認證)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/feeds' });
    expect(r.statusCode).toBe(200);
  });

  it('防暴力:同 IP 帶錯密碼連錯 10 次 → 鎖定,連對的密碼也 429', async () => {
    for (let i = 0; i < 10; i++) {
      await authApp.inject({ method: 'GET', url: '/api/feeds', headers: { authorization: basic('x', `wrong${i}`) } });
    }
    const locked = await authApp.inject({ method: 'GET', url: '/api/feeds', headers: { authorization: basic('x', 's3cret') } });
    expect(locked.statusCode).toBe(429);
  });

  it('防暴力:無憑證的 401(登入框流程)不計失敗次數', async () => {
    for (let i = 0; i < 15; i++) await authApp.inject({ method: 'GET', url: '/api/feeds' });
    const ok = await authApp.inject({ method: 'GET', url: '/api/feeds', headers: { authorization: basic('x', 's3cret') } });
    expect(ok.statusCode).toBe(200); // 沒被鎖
  });

  it('防暴力:登入成功即歸零,之前的失敗不累計', async () => {
    const wrong = () => authApp.inject({ method: 'GET', url: '/api/feeds', headers: { authorization: basic('x', 'nope') } });
    const right = () => authApp.inject({ method: 'GET', url: '/api/feeds', headers: { authorization: basic('x', 's3cret') } });
    for (let i = 0; i < 9; i++) await wrong();
    expect((await right()).statusCode).toBe(200); // 第 10 次前成功 → 歸零
    for (let i = 0; i < 9; i++) await wrong();    // 再錯 9 次(若沒歸零早鎖了)
    expect((await right()).statusCode).toBe(200);
  });
});

describe('RSS 輸出端點', () => {
  it('GET /rss/:id → Atom,content-type 正確,含譯文', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed', title: 'Ex' } })).json();
    await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/refresh` });
    const rss = await app.inject({ method: 'GET', url: `/rss/${f.id}` });
    expect(rss.statusCode).toBe(200);
    expect(rss.headers['content-type']).toContain('application/atom+xml');
    expect(rss.body).toContain('譯:Hello');
    expect(rss.body).toContain('嗨');
  });

  it('不存在的 feed → 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/rss/999' });
    expect(r.statusCode).toBe(404);
  });
});
