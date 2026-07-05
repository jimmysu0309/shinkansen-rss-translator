// app.js — Shinkansen-Feed 前端邏輯(vanilla JS,無框架、無 build)。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const api = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2000);
}

// 禁用詞 <-> 文字 互轉
const termsToText = (arr) => (arr || []).map(t => `${t.forbidden}=${t.replacement || ''}`).join('\n');
const textToTerms = (text) => text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
  const i = l.indexOf('=');
  return i < 0 ? { forbidden: l, replacement: '' } : { forbidden: l.slice(0, i).trim(), replacement: l.slice(i + 1).trim() };
}).filter(t => t.forbidden);

let DEFAULTS = null;

// ─── Tabs ───
$$('.tab').forEach(tab => tab.addEventListener('click', () => {
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.panel').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  $(`#tab-${tab.dataset.tab}`).classList.add('active');
  if (tab.dataset.tab === 'usage') loadUsage();
  if (tab.dataset.tab === 'feeds') loadFeeds();
  if (tab.dataset.tab === 'logs') loadLogs();
}));

// ─── 設定 ───
function fillModelSelect(sel, includeInherit) {
  sel.innerHTML = '';
  if (includeInherit) sel.add(new Option('繼承全域預設', ''));
  DEFAULTS.models.forEach(m => sel.add(new Option(m.label, m.id)));
}

function fillEngineSelect(sel, includeInherit) {
  sel.innerHTML = '';
  if (includeInherit) sel.add(new Option('繼承全域預設', ''));
  DEFAULTS.engines.forEach(e => sel.add(new Option(e.label, e.id)));
}

// 模型計價列(照 Shinkansen options:每個內建計價的模型一列,input/output 覆蓋,placeholder = 內建價)
const MODEL_LABELS = {
  'gemini-3.1-flash-lite': 'Flash Lite',
  'gemini-3-flash-preview': 'Flash',
  'gemini-3.5-flash': 'Flash 3.5',
};
function renderPricingRows(overrides) {
  const wrap = $('#pricing-rows');
  wrap.innerHTML = Object.entries(DEFAULTS.modelPricing).map(([id, built]) => {
    const ov = overrides[id] || {};
    const name = MODEL_LABELS[id] || id;
    return `<div class="pricing-row" data-model="${id}">
      <div class="pricing-label">
        <strong>${esc(name)}</strong>
        <span class="model-id">${esc(id)}</span>
        <span class="builtin">內建 $${built.inputPerMTok ?? '—'} / $${built.outputPerMTok ?? '—'}</span>
      </div>
      <label class="price-field"><span>輸入 /1M</span>
        <input type="number" step="0.01" min="0" class="price-in" placeholder="${built.inputPerMTok ?? ''}" value="${ov.inputPerMTok ?? ''}">
      </label>
      <label class="price-field"><span>輸出 /1M</span>
        <input type="number" step="0.01" min="0" class="price-out" placeholder="${built.outputPerMTok ?? ''}" value="${ov.outputPerMTok ?? ''}">
      </label>
    </div>`;
  }).join('');
}

function collectPricingOverrides() {
  const out = {};
  $$('#pricing-rows .pricing-row').forEach(row => {
    const model = row.dataset.model;
    const inp = row.querySelector('.price-in').value.trim();
    const outp = row.querySelector('.price-out').value.trim();
    // 只有兩欄都填才算有效覆蓋(對齊 vendor getPricingForModel 的 overrideHasPrices 判斷)
    if (inp !== '' && outp !== '') out[model] = { inputPerMTok: Number(inp), outputPerMTok: Number(outp) };
  });
  return out;
}

function updateApiKeyPill(has) {
  const pill = $('#apikey-status');
  pill.textContent = has ? '已設定' : '未設定';
  pill.className = 'pill ' + (has ? 'ok' : 'bad');
}

async function loadSettings() {
  DEFAULTS = await api('GET', '/api/defaults');
  const s = await api('GET', '/api/settings'); // 不含 apiKey(伺服器已濾除)

  $('#app-version').textContent = DEFAULTS.version ? `v${DEFAULTS.version}` : '';
  updateApiKeyPill(DEFAULTS.hasApiKey);
  $('#s-apikey').value = ''; // 永遠留空;有值才代表要變更

  fillEngineSelect($('#s-engine'), false);
  $('#s-engine').value = s.engine || 'gemini';
  fillModelSelect($('#s-model'), false);
  $('#s-model').value = s.model || DEFAULTS.model;
  $('#s-units').value = s.maxUnitsPerBatch ?? DEFAULTS.maxUnitsPerBatch;
  $('#s-chars').value = s.maxCharsPerBatch ?? DEFAULTS.maxCharsPerBatch;
  $('#s-temp').value = s.temperature ?? DEFAULTS.temperature;
  $('#s-logdays').value = s.logRetentionDays ?? DEFAULTS.logRetentionDays;
  $('#s-maxentries').value = s.maxEntriesPerFeed ?? DEFAULTS.maxEntriesPerFeed;
  // 更新頻率下拉
  const pc = $('#s-pollcron');
  pc.innerHTML = DEFAULTS.pollCronOptions.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  pc.value = s.pollCron ?? DEFAULTS.pollCron;
  $('#s-prompt').value = s.systemPrompt ?? DEFAULTS.systemPrompt;
  renderPricingRows(s.modelPricingOverrides || {});
  initLogFilters();
  $('#s-forbidden').value = termsToText(s.forbiddenTerms ?? DEFAULTS.forbiddenTerms);

  // 新增 feed 表單的引擎/模型下拉(含「繼承全域」sentinel)
  fillEngineSelect($('#add-feed select[name=engine]'), true);
  fillModelSelect($('#add-feed select[name=model]'), true);
}

$('#save-settings').addEventListener('click', async () => {
  try {
    const payload = {
      engine: $('#s-engine').value,
      model: $('#s-model').value,
      maxUnitsPerBatch: Number($('#s-units').value),
      maxCharsPerBatch: Number($('#s-chars').value),
      temperature: Number($('#s-temp').value),
      logRetentionDays: Number($('#s-logdays').value),
      maxEntriesPerFeed: Number($('#s-maxentries').value),
      pollCron: $('#s-pollcron').value,
      systemPrompt: $('#s-prompt').value,
      forbiddenTerms: textToTerms($('#s-forbidden').value),
      modelPricingOverrides: collectPricingOverrides(),
    };
    const key = $('#s-apikey').value.trim();
    if (key) payload.apiKey = key; // 有填才送(空 = 不變更)
    await api('PUT', '/api/settings', payload);
    if (key) { updateApiKeyPill(true); $('#s-apikey').value = ''; }
    $('#save-status').textContent = '✓ 已儲存';
    setTimeout(() => ($('#save-status').textContent = ''), 2000);
  } catch (e) { toast('儲存失敗:' + e.message); }
});

// 測試金鑰(優先測輸入框裡還沒存的新 key)
$('#test-key').addEventListener('click', async () => {
  const btn = $('#test-key');
  btn.textContent = '測試中…'; btn.disabled = true;
  try {
    const key = $('#s-apikey').value.trim();
    const r = await api('POST', '/api/test-key', key ? { apiKey: key } : {});
    if (r.ok) toast(`✓ 金鑰有效,可用模型 ${r.modelCount} 個`);
    else toast('✗ 金鑰無效:' + r.error);
  } catch (e) { toast('測試失敗:' + e.message); }
  finally { btn.textContent = '測試'; btn.disabled = false; }
});

// 匯出設定(下載 JSON)
$('#export-settings').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = '/api/settings/export';
  a.download = 'shinkansen-feed-settings.json';
  a.click();
});

// 匯入設定(選檔 → PUT;與儲存共用同一條路徑,伺服器白名單守門)
$('#import-settings').addEventListener('click', () => $('#settings-file').click());
$('#settings-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const settings = data.settings ?? data; // 支援匯出檔({exportedAt, settings})或裸設定物件
    await api('PUT', '/api/settings', settings);
    await loadSettings(); // 匯入後重載畫面
    toast('已匯入設定');
  } catch (err) { toast('匯入失敗:' + err.message); }
  finally { e.target.value = ''; } // 允許重複選同一檔
});

// ─── Feeds ───
function statusBadges(counts) {
  const parts = [];
  if (counts.done) parts.push(`<span class="badge done">✓ ${counts.done} 已翻</span>`);
  if (counts.pending) parts.push(`<span class="badge pending">${counts.pending} 待翻</span>`);
  if (counts.error) parts.push(`<span class="badge error">${counts.error} 失敗</span>`);
  return parts.join('') || '<span class="badge">尚無文章</span>';
}

// 產生 <option> 字串(含「繼承全域」sentinel),selected 標在目前值
function optionsHtml(items, selected) {
  const inherit = `<option value=""${!selected ? ' selected' : ''}>繼承全域預設</option>`;
  return inherit + items.map(o => {
    const val = o.id ?? o;
    const label = o.label ?? o;
    return `<option value="${esc(val)}"${val === selected ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

async function loadFeeds() {
  const feeds = await api('GET', '/api/feeds'); // 列表已附各狀態篇數(counts),免逐 feed 撈詳情
  const list = $('#feed-list');
  if (!feeds.length) { list.innerHTML = '<p class="hint">還沒有 feed。用上方表單新增第一個。</p>'; return; }

  list.innerHTML = feeds.map(f => {
    const counts = f.counts || { done: 0, pending: 0, error: 0 };
    const rssUrl = `${location.origin}/rss/${f.id}`;
    return `<div class="feed-item" data-id="${f.id}">
      <div class="feed-head">
        <div>
          <div class="feed-title">${esc(f.title || f.source_url)}${f.enabled ? '' : ' <span class="badge">已停用</span>'}</div>
          <div class="feed-url">${esc(f.source_url)}</div>
        </div>
        <div class="feed-actions">
          <button class="ghost" data-act="edit">編輯</button>
          ${counts.error ? '<button class="ghost" data-act="retry">重翻</button>' : ''}
          <button class="ghost" data-act="refresh">刷新</button>
          <button class="danger" data-act="delete">刪除</button>
        </div>
      </div>
      <div class="feed-meta">
        ${statusBadges(counts)}
        <span>引擎:${engineLabel(f.engine)}</span>
        ${f.engine !== 'google' ? `<span>模型:${f.model ? esc(f.model) : '繼承全域'}</span>` : ''}
        ${f.fetch_article ? '<span>全文抓取</span>' : ''}
        ${f.category ? `<span>分類:${esc(f.category)}</span>` : ''}
        ${f.last_error ? `<span class="badge error">抓取錯誤</span>` : ''}
      </div>

      <div class="feed-edit" hidden>
        <div class="grid2">
          <label>標題<input type="text" data-f="title" value="${esc(f.title || '')}"></label>
          <label>分類<input type="text" data-f="category" value="${esc(f.category || '')}"></label>
          <label>引擎<select data-f="engine">${DEFAULTS.engines.map(o => `<option value="${esc(o.id)}"${o.id === (f.engine || 'gemini') ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
          <label>Gemini 模型<select data-f="model">${optionsHtml(DEFAULTS.models, f.model)}</select></label>
        </div>
        <div class="edit-row">
          <label class="checkbox-label"><input type="checkbox" data-f="fetch_article" ${f.fetch_article ? 'checked' : ''}><span>抓取全文</span></label>
          <label class="checkbox-label"><input type="checkbox" data-f="enabled" ${f.enabled ? 'checked' : ''}><span>啟用</span></label>
          <button class="danger" data-act="retranslate" title="所有文章(含已翻)重翻一次,套用目前的模型/prompt/抓全文設定">全部重譯</button>
          <div class="edit-actions">
            <button class="primary" data-act="save">儲存</button>
            <button class="ghost" data-act="cancel">取消</button>
          </div>
        </div>
      </div>

      <div class="rss-row">
        <input type="text" readonly value="${esc(rssUrl)}">
        <button class="ghost" data-act="copy">複製</button>
      </div>
    </div>`;
  }).join('');
}

$('#feed-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const item = e.target.closest('.feed-item'); const id = item.dataset.id;
  const act = btn.dataset.act;
  const origLabel = btn.textContent; // 失敗時還原(否則按鈕卡在「刷新中…」)
  try {
    if (act === 'copy') {
      await copyText($('.rss-row input', item).value); // 鎖定 RSS 那格,別抓到編輯表單的 input
      toast('已複製 RSS 網址');
    } else if (act === 'refresh') {
      btn.textContent = '刷新中…'; btn.disabled = true;
      const r = await api('POST', `/api/feeds/${id}/refresh`);
      toast(`新增 ${r.added} 篇、翻譯 ${r.translated} 篇${r.failed ? `、失敗 ${r.failed}` : ''}`);
      loadFeeds();
    } else if (act === 'retry') {
      btn.textContent = '重翻中…'; btn.disabled = true;
      const r = await api('POST', `/api/feeds/${id}/retry-errors`);
      toast(`重翻 ${r.reset} 篇:成功 ${r.translated}、失敗 ${r.failed}`);
      loadFeeds();
    } else if (act === 'retranslate') {
      if (!confirm('把這個 feed 的所有文章(含已翻)全部重翻一次?\n會重新花費 token（Gemini 引擎）。')) return;
      btn.textContent = '重譯中…'; btn.disabled = true;
      const r = await api('POST', `/api/feeds/${id}/retranslate`);
      toast(`全部重譯 ${r.reset} 篇:成功 ${r.translated}、失敗 ${r.failed}`);
      loadFeeds();
    } else if (act === 'delete') {
      if (!confirm('確定刪除這個 feed 及其所有文章?')) return;
      await api('DELETE', `/api/feeds/${id}`);
      toast('已刪除'); loadFeeds();
    } else if (act === 'edit') {
      const box = $('.feed-edit', item);
      box.hidden = !box.hidden; // 切換編輯面板
    } else if (act === 'cancel') {
      $('.feed-edit', item).hidden = true;
    } else if (act === 'save') {
      const box = $('.feed-edit', item);
      const val = (sel) => $(`[data-f="${sel}"]`, box);
      const patch = {
        title: val('title').value.trim() || null,
        category: val('category').value.trim() || null,
        engine: val('engine').value,          // engine 一律具體值(NOT NULL)
        model: val('model').value || null,    // model 可為 null = 繼承全域
        fetch_article: val('fetch_article').checked,
        enabled: val('enabled').checked,
      };
      await api('PATCH', `/api/feeds/${id}`, patch);
      toast('已更新'); loadFeeds();
    }
  } catch (err) { toast('操作失敗:' + err.message); btn.textContent = origLabel; btn.disabled = false; }
});

// OPML 匯出
$('#export-opml').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = '/api/feeds/export.opml';
  a.download = 'shinkansen-feed.opml';
  a.click();
});

// OPML 匯入(選檔 → 讀文字 → POST)
$('#import-opml').addEventListener('click', () => $('#opml-file').click());
$('#opml-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const opml = await file.text();
    const r = await api('POST', '/api/feeds/import-opml', { opml });
    toast(`匯入完成:新增 ${r.added}、略過 ${r.skipped}（共 ${r.total}）`);
    loadFeeds();
  } catch (err) { toast('匯入失敗:' + err.message); }
  finally { e.target.value = ''; } // 允許重複選同一檔
});

// 測試 RSS 網址(抓取解析,不儲存)
$('#test-feed').addEventListener('click', async () => {
  const url = $('#add-feed input[name=source_url]').value.trim();
  if (!url) { toast('請先填 RSS 網址'); return; }
  const btn = $('#test-feed');
  btn.textContent = '測試中…'; btn.disabled = true;
  try {
    const r = await api('POST', '/api/test-feed', { source_url: url });
    if (r.ok) {
      toast(`✓ ${r.title || '(無標題)'}:${r.itemCount} 篇文章`);
      // 若標題欄為空,順手帶入抓到的標題
      const titleInput = $('#add-feed input[name=title]');
      if (!titleInput.value && r.title) titleInput.value = r.title;
    } else {
      toast('✗ 抓取失敗:' + r.error);
    }
  } catch (e) { toast('測試失敗:' + e.message); }
  finally { btn.textContent = '測試'; btn.disabled = false; }
});

$('#add-feed').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('POST', '/api/feeds', {
      source_url: fd.get('source_url').trim(),
      title: fd.get('title').trim() || null,
      category: fd.get('category').trim() || null,
      engine: fd.get('engine') || null,
      model: fd.get('model') || null,
      fetch_article: fd.get('fetch_article') === 'on',
    });
    e.target.reset();
    fillEngineSelect($('#add-feed select[name=engine]'), true);
    fillModelSelect($('#add-feed select[name=model]'), true);
    toast('已新增 feed'); loadFeeds();
  } catch (err) { toast('新增失敗:' + err.message); }
});

// ─── 用量 ───
let usageDays = 7; // 目前選的日期範圍(0 = 全部)

function rangeParams() {
  if (!usageDays) return '';
  const from = Date.now() - usageDays * 86400_000;
  return `?from=${from}`;
}

async function loadUsage() {
  const u = await api('GET', '/api/usage' + rangeParams());
  $('#u-cost').textContent = fmtUsd(u.total.cost);
  $('#u-calls').textContent = fmt(u.total.calls);
  $('#u-in').textContent = fmt(u.total.input_tokens);
  $('#u-out').textContent = fmt(u.total.output_tokens);
  $('#u-cache').textContent = (u.total.cacheHitRate * 100).toFixed(0) + '%';
  $('#u-pending-note').textContent = u.pending ? `目前有 ${u.pending} 篇待翻譯` : '';

  renderChart(u.daily);

  byFeedData = u.byFeed;
  renderByFeed();

  recPage = 0;
  await loadRecords();
}

// 各 feed 用量:可依欄位排序
let byFeedData = [];
let byFeedSort = { key: 'cost', dir: 'desc' }; // 預設依費用高到低(同伺服器)

function renderByFeed() {
  const { key, dir } = byFeedSort;
  const sorted = byFeedData.slice().sort((a, b) => {
    let va = a[key], vb = b[key];
    let cmp;
    if (key === 'feed_title') cmp = String(va || '').localeCompare(String(vb || ''), 'zh-Hant');
    else cmp = (Number(va) || 0) - (Number(vb) || 0);
    return dir === 'asc' ? cmp : -cmp;
  });
  $('#u-byfeed tbody').innerHTML = sorted.length
    ? sorted.map(f => `<tr><td>${esc(f.feed_title || '—')}</td><td>${fmt(f.calls)}</td><td>${fmt(f.input_tokens)}</td><td>${fmt(f.output_tokens)}</td><td>${fmt(f.cached_tokens)}</td><td>${fmtUsd(f.cost)}</td></tr>`).join('')
    : '<tr><td colspan="6" style="text-align:center;color:var(--fg-dim)">尚無資料</td></tr>';
  // 更新表頭箭頭
  $$('#u-byfeed thead th').forEach(th => {
    const arrow = th.dataset.key === key ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    th.textContent = th.dataset.label + arrow;
    th.classList.toggle('sorted', th.dataset.key === key);
  });
}

$('#u-byfeed thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-key]'); if (!th) return;
  const key = th.dataset.key;
  if (byFeedSort.key === key) {
    byFeedSort.dir = byFeedSort.dir === 'asc' ? 'desc' : 'asc'; // 同欄再點 → 切升降
  } else {
    byFeedSort = { key, dir: key === 'feed_title' ? 'asc' : 'desc' }; // 文字預設升冪、數字預設降冪
  }
  renderByFeed();
});

const PAGE_SIZE = 50;

// 分頁列渲染 + 按鈕啟用狀態
function renderPager(sel, page, total) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const el = $(sel);
  el.querySelector('.pager-info').textContent = total ? `第 ${page + 1} / ${pages} 頁（共 ${total}）` : '無資料';
  el.querySelector('[data-dir="-1"]').disabled = page <= 0;
  el.querySelector('[data-dir="1"]').disabled = page >= pages - 1;
}

// 用量明細(分頁,每頁 50)
let recPage = 0;
async function loadRecords() {
  const p = new URLSearchParams();
  if (usageDays) p.set('from', Date.now() - usageDays * 86400_000);
  p.set('limit', PAGE_SIZE); p.set('offset', recPage * PAGE_SIZE);
  const { records, total } = await api('GET', '/api/usage/records?' + p.toString());
  $('#u-records tbody').innerHTML = records.length
    ? records.map(r => `<tr><td class="time">${fmtTime(r.ts)}</td><td>${esc(r.feed_title || '—')}</td><td>${esc(r.model || '—')}</td><td>${fmt(r.input_tokens)}</td><td>${fmt(r.output_tokens)}</td><td>${fmtUsd(r.cost)}</td></tr>`).join('')
    : '<tr><td colspan="6" style="text-align:center;color:var(--fg-dim)">尚無資料</td></tr>';
  renderPager('#rec-pager', recPage, total);
}

$('#rec-pager').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  recPage += Number(b.dataset.dir); loadRecords();
});

$('#refresh-usage').addEventListener('click', () => loadUsage());

function renderChart(daily) {
  const el = $('#u-chart');
  if (!daily || !daily.length) { el.innerHTML = '<div class="chart-empty">此範圍尚無用量</div>'; return; }
  const max = Math.max(...daily.map(d => d.cost), 1e-9);
  el.innerHTML = daily.map(d => {
    const h = Math.max(2, Math.round((d.cost / max) * 120));
    const md = d.day.slice(5); // MM-DD
    return `<div class="bar-wrap" title="${d.day}｜${fmtUsd(d.cost)}｜${fmt(d.output_tokens)} 輸出">
      <div class="bar" style="height:${h}px"><span class="bar-val">${fmtUsd(d.cost)}</span></div>
      <span class="bar-label">${md}</span>
    </div>`;
  }).join('');
}

// 日期範圍切換
$('#range-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range'); if (!btn) return;
  $$('#range-tabs .range').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  usageDays = Number(btn.dataset.days);
  loadUsage();
});

// 匯出 CSV
$('#export-csv').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = '/api/usage/export.csv' + rangeParams();
  a.download = 'shinkansen-feed-usage.csv';
  a.click();
});

// 清除用量紀錄
$('#clear-usage').addEventListener('click', async () => {
  if (!confirm('確定清除所有用量紀錄?此動作無法復原。')) return;
  try {
    const r = await api('DELETE', '/api/usage');
    toast(`已清除 ${r.deleted} 筆用量紀錄`);
    loadUsage();
  } catch (e) { toast('清除失敗:' + e.message); }
});

// ─── 紀錄(Log)───
let logFiltersReady = false;
function initLogFilters() {
  if (logFiltersReady) return;
  const lvl = $('#log-level'), cat = $('#log-category');
  DEFAULTS.logLevels.forEach(l => lvl.add(new Option(l, l)));
  DEFAULTS.logCategories.forEach(c => cat.add(new Option(c, c)));
  const reload = () => { logPage = 0; loadLogs(); };
  lvl.addEventListener('change', reload);
  cat.addEventListener('change', reload);
  $('#log-pager').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    logPage += Number(b.dataset.dir); loadLogs();
  });
  logFiltersReady = true;
}

// 過濾條件(給匯出用,不含分頁)
function logQuery() {
  const p = new URLSearchParams();
  const lvl = $('#log-level').value, cat = $('#log-category').value;
  if (lvl) p.set('level', lvl);
  if (cat) p.set('category', cat);
  return p.toString() ? '?' + p.toString() : '';
}

let logPage = 0;
async function loadLogs() {
  const p = new URLSearchParams();
  const lvl = $('#log-level').value, cat = $('#log-category').value;
  if (lvl) p.set('level', lvl);
  if (cat) p.set('category', cat);
  p.set('limit', PAGE_SIZE); p.set('offset', logPage * PAGE_SIZE);
  const { logs, total } = await api('GET', '/api/logs?' + p.toString());
  $('#log-table tbody').innerHTML = logs.length
    ? logs.map(l => `<tr>
        <td class="time">${fmtTime(l.ts)}</td>
        <td><span class="lvl lvl-${l.level}">${esc(l.level)}</span></td>
        <td>${esc(l.category || '—')}</td>
        <td class="msg">${esc(l.message)}${l.detail ? `<br><small style="color:var(--fg-dim)">${esc(l.detail)}</small>` : ''}</td>
        <td>${esc(l.feed_title || '—')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" style="text-align:center;color:var(--fg-dim)">此範圍尚無紀錄</td></tr>';
  renderPager('#log-pager', logPage, total);
}

$('#export-logs').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = '/api/logs/export.csv' + logQuery();
  a.download = 'shinkansen-feed-logs.csv';
  a.click();
});

// 清除紀錄
$('#clear-logs').addEventListener('click', async () => {
  if (!confirm('確定清除所有紀錄?此動作無法復原。')) return;
  try {
    const r = await api('DELETE', '/api/logs');
    toast(`已清除 ${r.deleted} 筆紀錄`);
    loadLogs();
  } catch (e) { toast('清除失敗:' + e.message); }
});

// ─── utils ───
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtTime(ts) { const d = new Date(Number(ts) || 0); return d.toLocaleString('sv').slice(0, 19); }
function fmt(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); }
function fmtUsd(n) { n = Number(n) || 0; if (n === 0) return '$0'; if (n < 0.01) return '$' + n.toFixed(4); if (n < 1) return '$' + n.toFixed(3); return '$' + n.toFixed(2); }
function engineLabel(id) { return id === 'google' ? 'Google 翻譯' : id === 'gemini' ? 'Gemini' : '繼承全域'; }

// 複製文字:優先 clipboard API(需 secure context),失敗則用暫時 textarea 後備
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* 落到後備 */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.top = '-9999px';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
}

// 啟動
(async () => {
  try { await loadSettings(); await loadFeeds(); }
  catch (e) { toast('載入失敗:' + e.message); }
})();
