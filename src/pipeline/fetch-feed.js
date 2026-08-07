// fetch-feed.js — 抓取並解析 RSS/Atom feed,支援 conditional GET(etag / last-modified)。
//
// parseFeedXml(xml) 是純函式(可離線測);fetchFeed(url, opts) 加上網路與 304 處理。
//
// 訊號層次:
//   ✓ parseFeedXml:把各種 feed 格式正規化成統一 item 形狀(guid/title/url/author/contentHtml/published_at)
//   ✓ fetchFeed:304 Not Modified → 不重抓;回傳新的 etag/last-modified
//   ✗ 不驗:真實網路(整合/部署階段驗);單元測試用注入的 fetch

import Parser from 'rss-parser';
import { APP_VERSION } from '../version.js';

// 回應大小上限:壞掉/惡意來源回超大內容不能吃爆記憶體(與 full-text 的 MAX_HTML_BYTES 同款護欄;
// feed 常帶 content:encoded 全文,上限放寬到 10MB)
const MAX_XML_BYTES = 10 * 1024 * 1024;

const parser = new Parser({
  // 讓 content:encoded(全文)與 Media RSS 的圖片欄位可取用
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
    ],
  },
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

// 封面圖:很多來源(The Atlantic、多數 WordPress 站)把封面掛在文章本體「外面」的
// media:content / media:thumbnail / enclosure,內文本身一張圖都沒有。不撈進來的話
// 下游(Miniflux / Readwise)就是全篇無圖 —— 這是本欄位存在的唯一理由。
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)(\?|#|$)/i;

function isImageUrl(url, type, medium) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  if (typeof medium === 'string' && medium.toLowerCase() === 'image') return true;
  if (typeof type === 'string' && type.toLowerCase().startsWith('image/')) return true;
  // 沒宣告型別的(Atlantic 的 media:content 就沒有)只能看副檔名
  return !type && !medium ? IMAGE_EXT.test(url) : false;
}

function pickImage(item) {
  // rss-parser 把未知標籤的屬性放進 `$`;keepArray 讓多張圖時拿得到全部(取第一張)。
  const candidates = [];
  if (item.enclosure) candidates.push(item.enclosure);
  for (const key of ['mediaContent', 'mediaThumbnail']) {
    const v = item[key];
    if (Array.isArray(v)) candidates.push(...v);
    else if (v) candidates.push(v);
  }
  for (const c of candidates) {
    const a = (c && c.$) || c || {};
    const url = a.url || a.href;
    if (isImageUrl(url, a.type, a.medium)) return url;
  }
  return null;
}

function normalizeItem(item) {
  return {
    guid: item.guid || item.id || item.link || null,
    title: item.title || '',
    url: item.link || null,
    author: pickAuthor(item),
    contentHtml: pickContentHtml(item),
    image_url: pickImage(item),
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
  const headers = { 'user-agent': `Shinkansen-Feed/${APP_VERSION} (+RSS translator)` };
  if (opts.etag) headers['if-none-match'] = opts.etag;
  if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;

  const attempt = async () => {
    // timeout:掛掉的來源不能卡住整條管線(undici 預設 headers timeout 長達 5 分鐘)
    const resp = await doFetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    if (resp.status === 304) {
      return { notModified: true, items: [], etag: opts.etag || null, lastModified: opts.lastModified || null };
    }
    if (!resp.ok) throw new Error(`抓取 ${url} 失敗:HTTP ${resp.status}`);

    const declared = Number(resp.headers.get('content-length'));
    if (declared > MAX_XML_BYTES) throw new Error(`抓取 ${url} 失敗:回應過大(${declared} bytes)`);
    const xml = await resp.text();
    if (xml.length > MAX_XML_BYTES) throw new Error(`抓取 ${url} 失敗:回應過大(${xml.length} 字元)`); // 沒宣告 content-length 的以實際長度擋
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
