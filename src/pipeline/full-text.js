// full-text.js — 抓取全文(fetch_article):抓文章網址 → Mozilla Readability 抽正文 → 保留圖片。
//
// 用途:RSS 只給摘要的 feed,勾「抓取全文」後,翻譯前先抓整篇正文再翻。
// 相對網址(img src / a href)會被解析成絕對網址,確保在閱讀器裡圖片/連結可用。
//
// 註:vendor 的 readability.js 是 CommonJS,但本專案是 ESM(type:module),
// 直接 import 會被當 ESM 而拿不到 module.exports。改用 Module._compile 以 CJS 情境載入原檔
// (不複製 vendor、維持單一資料源)。
//
// 限制:Readability 只能處理「伺服器端已渲染」的 HTML;純前端 JS 渲染的站(部分現代新聞站)
// 抓到的內容可能很少 —— 這是 readability 的先天限制,非本專案 bug。

import { readFileSync } from 'node:fs';
import { Module } from 'node:module';
import { parseHTML } from 'linkedom';

// 以 CommonJS 情境載入 vendor readability.js
const _readabilityUrl = new URL('../../vendor/shinkansen/shinkansen/lib/readability.js', import.meta.url);
const _mod = new Module('readability');
_mod._compile(readFileSync(_readabilityUrl, 'utf8'), _readabilityUrl.pathname);
const Readability = _mod.exports;

/**
 * 從一頁 HTML 抽出正文(Readability),相對網址轉絕對。
 * 正文開頭沒有 hero 等級的圖時,以頁面 og:image 前置補 hero(見 maybePrependHero)。
 * @param {string} html 整頁 HTML
 * @param {string} url  該頁網址(解析相對連結用)
 * @returns {string|null} 正文 HTML;抽不出來回 null
 */
export function extractReadable(html, url) {
  let article;
  let ogImage = null;
  try {
    const { document } = parseHTML(html);
    // og:image 必須在 Readability.parse() 之前讀——parse 會就地改寫 document
    ogImage = readOgImage(document, url);
    article = new Readability(document).parse();
  } catch {
    return null;
  }
  if (!article || !article.content) return null;
  return maybePrependHero(dedupeExtracted(absolutizeUrls(article.content, url)), ogImage);
}

/**
 * Readability 重複抽取去重(通則):部分站點(The Verge 等)同一份內容在頁面上
 * 放兩份(桌機 / 手機雙版本、lightbox 複本),Readability 兩份全收,正文出現
 * 重複的 lead image 與導言。三條保守規則:
 *   1. 重複圖:src pathname 與前面任一張相同 → 移除後面那張(連同只剩空殼的
 *      figure / picture 外層)
 *   2. 相鄰重複文字塊:與「前一個 element 兄弟」trimmed 文字完全相同且 > 20 字
 *      → 移除後者(只比相鄰,避免誤刪合法的重複句)
 *   3. skip link:整段只有一個 href="#…" 的無障礙跳轉連結(「跳至主要內容」
 *      / Skip to content)→ 移除
 */
function dedupeExtracted(content) {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${content}</body></html>`);
  // 1. 重複圖(正規化 pathname 比對,忽略 CDN 參數與圖片代理主機前綴)
  const seen = new Set();
  for (const img of [...document.querySelectorAll('img')]) {
    const src = img.getAttribute('src');
    if (!src) continue;
    const path = canonicalImagePath(src);
    if (!path) continue;
    if (seen.has(path)) {
      let victim = img;
      const wrap = img.closest('figure, picture');
      // figure 內除了這張圖沒有別的內容(圖說歸第一份)→ 整個 figure 移除
      if (wrap && wrap.querySelectorAll('img').length === 1) victim = wrap;
      victim.remove();
    } else {
      seen.add(path);
    }
  }
  // 2. 相鄰重複文字塊
  for (const el of [...document.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6')]) {
    const prev = el.previousElementSibling;
    if (!prev || prev.tagName !== el.tagName) continue;
    const t = el.textContent.trim();
    if (t.length > 20 && t === prev.textContent.trim()) el.remove();
  }
  // 3. skip link 段落
  for (const a of [...document.querySelectorAll('a[href^="#"]')]) {
    const p = a.parentElement;
    if (p && p.tagName === 'P' && p.children.length === 1 &&
        p.textContent.trim() === a.textContent.trim()) p.remove();
  }
  return document.body.innerHTML;
}

// 圖片網址正規化(去重 / hero 比對共用):取 pathname,再剝掉「圖片代理 CDN 把來源主機
// 塞進 path」的前綴 —— WordPress Photon 等:i0.wp.com/9to5mac.com/wp-content/… 與原站
// 9to5mac.com/wp-content/… 是同一張圖,pathname 卻不同。第一段長得像主機名(含點、
// 字母 TLD 結尾)才剝;一般版本號路徑段(/v1.2/…)不受影響。壞網址回 null(呼叫端跳過)。
function canonicalImagePath(url) {
  let path;
  try { path = new URL(url).pathname; } catch { return null; }
  const m = path.match(/^\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(\/.+)$/i);
  return m ? m[1] : path;
}

// 讀頁面宣告的社群分享主圖(og:image 優先,twitter:image 備援),相對網址以文章網址解析
function readOgImage(document, base) {
  const meta =
    document.querySelector('meta[property="og:image"]') ||
    document.querySelector('meta[property="og:image:url"]') ||
    document.querySelector('meta[name="twitter:image"]');
  const raw = meta && meta.getAttribute('content');
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

// 正文開頭視為「已有 hero」的檢查範圍(字元),與小圖(頭像 / icon)寬度門檻
const HERO_SCAN_CHARS = 600;
const HERO_MIN_WIDTH = 200;

/**
 * og:image hero 補圖:Readability 常把正文容器外的 lead image 丟掉(The Verge 等
 * 新聞站 hero 在 header 區)。通則補法——滿足以下三者才前置 hero,避免重複或蓋掉
 * 站方原有 lead:
 *   1. 頁面有 og:image(文章專屬主圖,新聞站幾乎都有)
 *   2. 正文裡沒有同一張圖(以 URL pathname 比對,忽略 CDN 參數差異)
 *   3. 正文開頭(前 HERO_SCAN_CHARS 字)沒有 hero 等級的圖——width 屬性 >=
 *      HERO_MIN_WIDTH 或未標寬度的圖視為 hero;頭像等小圖(width < 門檻)不算
 */
function maybePrependHero(content, ogImage) {
  if (!ogImage) return content;
  const heroPath = canonicalImagePath(ogImage);
  if (!heroPath) return content;
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${content}</body></html>`);
  for (const img of document.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (!src) continue;
    if (canonicalImagePath(src) === heroPath) return content; // 正文已有同一張,不重複
  }
  // 掃描窗只界定 <img 的「起點」;tag 本體從起點往後配對到閉合 >。
  // (9to5Mac 類長 srcset 的 img tag 可超過掃描窗,閉合落在窗外會誤判「開頭沒圖」)
  const at = content.slice(0, HERO_SCAN_CHARS).search(/<img\b/i);
  if (at !== -1) {
    const tag = content.slice(at).match(/<img[^>]*>/i);
    const w = tag && tag[0].match(/width=["']?(\d+)/i);
    if (!w || Number(w[1]) >= HERO_MIN_WIDTH) return content; // 開頭已有 hero 等級圖
  }
  return `<figure><img src="${escapeAttr(ogImage)}" alt=""></figure>` + content;
}

// 屬性值跳脫(og:image URL 可能含 & 等字元)
function escapeAttr(s) {
  return s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/**
 * 抓取文章網址並抽全文。
 * @param {string} url
 * @param {{fetchImpl?:function, timeoutMs?:number}} [opts] fetchImpl 供測試注入
 * @returns {Promise<string|null>}
 */
// 單頁 HTML 大小上限:超過視為異常頁(影音檔、爆量頁),放棄抽全文改用摘要,防吃爆記憶體
const MAX_HTML_BYTES = 5 * 1024 * 1024;

export async function fetchFullText(url, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const resp = await doFetch(url, {
    headers: { 'user-agent': 'Shinkansen-Feed/0.1 (+full-text)' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  if (!resp.ok) return null;
  const declared = Number(resp.headers?.get?.('content-length'));
  if (declared > MAX_HTML_BYTES) return null;
  const html = await resp.text();
  if (html.length > MAX_HTML_BYTES) return null; // 沒宣告 content-length 的以實際長度擋
  return extractReadable(html, url);
}

// 把 img/src、a/href、source/src 的相對網址解析成絕對(以 base 為基準)
function absolutizeUrls(html, base) {
  if (!base) return html;
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  for (const el of document.querySelectorAll('[src], [href]')) {
    const attr = el.hasAttribute('src') ? 'src' : 'href';
    const v = el.getAttribute(attr);
    if (!v || /^(https?:|data:|mailto:|#)/i.test(v)) continue;
    try { el.setAttribute(attr, new URL(v, base).href); } catch { /* 壞網址就不動 */ }
  }
  return document.body.innerHTML;
}
