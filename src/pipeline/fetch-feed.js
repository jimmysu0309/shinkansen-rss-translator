// fetch-feed.js — 抓取並解析 RSS/Atom feed,支援 conditional GET(etag / last-modified)。
//
// parseFeedXml(xml) 是純函式(可離線測);fetchFeed(url, opts) 加上網路與 304 處理。
//
// 訊號層次:
//   ✓ parseFeedXml:把各種 feed 格式正規化成統一 item 形狀(guid/title/url/author/contentHtml/published_at)
//   ✓ fetchFeed:304 Not Modified → 不重抓;回傳新的 etag/last-modified
//   ✗ 不驗:真實網路(整合/部署階段驗);單元測試用注入的 fetch

import Parser from 'rss-parser';

const parser = new Parser({
  // 讓 content:encoded(全文)可取用
  customFields: { item: [['content:encoded', 'contentEncoded']] },
});

function pickContentHtml(item) {
  // 優先全文,退而求其次摘要
  return item.contentEncoded || item['content:encoded'] || item.content || item.summary || item.contentSnippet || '';
}

function toEpoch(item) {
  const s = item.isoDate || item.pubDate;
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function pickAuthor(item) {
  // rss-parser 的欄位形狀:RSS dc:creator → item.creator(人名);
  // RSS <author> → 兩者皆有(email 格式);Atom <author><name> → 只有 item.author。
  // 優先 creator(人名),退 author;非字串(多作者物件等罕見形狀)不猜,回 null。
  const v = item.creator || item.author;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function normalizeItem(item) {
  return {
    guid: item.guid || item.id || item.link || null,
    title: item.title || '',
    url: item.link || null,
    author: pickAuthor(item),
    contentHtml: pickContentHtml(item),
    published_at: toEpoch(item),
  };
}

/** 純函式:解析 feed XML 字串 → { title, items[] } */
export async function parseFeedXml(xml) {
  const feed = await parser.parseString(xml);
  return {
    title: feed.title || '',
    items: (feed.items || []).map(normalizeItem),
  };
}

/**
 * 抓取 feed,支援 conditional GET。
 * XML 解析失敗(上游偶發截斷回應,如 Daring Fireball 的「Unclosed root tag」)視為
 * 暫時性故障,隔幾秒重抓一次;HTTP 錯誤與網路逾時不重試(避免掛掉的來源讓每輪多等一倍)。
 * @param {string} url
 * @param {{etag?, lastModified?, fetchImpl?, timeoutMs?, parseRetryDelayMs?}} [opts] fetchImpl 供測試注入
 * @returns {Promise<{notModified:boolean, title?, items, etag, lastModified}>}
 */
export async function fetchFeed(url, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const headers = { 'user-agent': 'Shinkansen-Feed/0.1 (+RSS translator)' };
  if (opts.etag) headers['if-none-match'] = opts.etag;
  if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;

  const attempt = async () => {
    // timeout:掛掉的來源不能卡住整條管線(undici 預設 headers timeout 長達 5 分鐘)
    const resp = await doFetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    if (resp.status === 304) {
      return { notModified: true, items: [], etag: opts.etag || null, lastModified: opts.lastModified || null };
    }
    if (!resp.ok) throw new Error(`抓取 ${url} 失敗:HTTP ${resp.status}`);

    const xml = await resp.text();
    let parsed;
    try {
      parsed = await parseFeedXml(xml);
    } catch (err) {
      err.isParseError = true; // 標記給外層判斷是否重試
      throw err;
    }
    return {
      notModified: false,
      title: parsed.title,
      items: parsed.items,
      etag: resp.headers.get('etag') || null,
      lastModified: resp.headers.get('last-modified') || null,
    };
  };

  try {
    return await attempt();
  } catch (err) {
    if (!err.isParseError) throw err;
    await new Promise((r) => setTimeout(r, opts.parseRetryDelayMs ?? 3000));
    return attempt(); // 第二次再失敗就往外拋(交由上層記 log / last_error)
  }
}
