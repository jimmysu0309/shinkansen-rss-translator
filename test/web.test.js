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

  it('匯出設定:帶 content-disposition,不含 apiKey', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: 'AQ.s', model: 'm', engine: 'google' } });
    const res = await app.inject({ method: 'GET', url: '/api/settings/export' });
    expect(res.headers['content-disposition']).toContain('shinkansen-feed-settings.json');
    const body = res.json();
    expect(body.settings.model).toBe('m');
    expect(body.settings.engine).toBe('google');
    expect(body.settings.apiKey).toBeUndefined();
  });

  it('測試金鑰:沒金鑰 → ok:false(不需網路)', async () => {
    // setup-env 會把 .env 的 key 載進 process.env,這裡暫時清掉以測「完全無金鑰」路徑
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const noKeyApp = buildServer(createDb(':memory:'), {}); // 無 apiKey
      const res = await noKeyApp.inject({ method: 'POST', url: '/api/test-key', payload: {} });
      expect(res.json()).toEqual({ ok: false, error: '沒有金鑰可測試' });
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
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

  it('編輯:PATCH 整組參數(title/category/engine/model/fetch_article/enabled)', async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed', title: '舊' } })).json();
    const patched = (await app.inject({
      method: 'PATCH', url: `/api/feeds/${f.id}`,
      payload: { title: '新標題', category: '科技', engine: 'google', model: null, fetch_article: true, enabled: false },
    })).json();
    expect(patched.title).toBe('新標題');
    expect(patched.category).toBe('科技');
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

  it('用量明細含時間與模型', async () => {
    const u = (await app.inject({ method: 'GET', url: '/api/usage' })).json();
    expect(u.records.length).toBeGreaterThanOrEqual(1);
    expect(u.records[0]).toHaveProperty('ts');
    expect(u.records[0]).toHaveProperty('model');
  });
});

describe('Log API', () => {
  beforeEach(async () => {
    const f = (await app.inject({ method: 'POST', url: '/api/feeds', payload: { source_url: 'https://ex.com/feed' } })).json();
    await app.inject({ method: 'POST', url: `/api/feeds/${f.id}/refresh` }); // 產生 fetch + translate log
  });

  it('GET /api/logs 回紀錄(新到舊)', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/logs' })).json();
    expect(r.logs.length).toBeGreaterThanOrEqual(2); // 至少 fetch + translate
    // 新到舊:ts 遞減
    for (let i = 1; i < r.logs.length; i++) expect(r.logs[i - 1].ts).toBeGreaterThanOrEqual(r.logs[i].ts);
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

  it('defaults 提供保留天數(7)與 filter 選項', async () => {
    const d = (await app.inject({ method: 'GET', url: '/api/defaults' })).json();
    expect(d.logRetentionDays).toBe(7);
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
    expect(after.records).toHaveLength(0);
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
