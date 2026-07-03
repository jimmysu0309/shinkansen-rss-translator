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
 * @param {string} html 整頁 HTML
 * @param {string} url  該頁網址(解析相對連結用)
 * @returns {string|null} 正文 HTML;抽不出來回 null
 */
export function extractReadable(html, url) {
  let article;
  try {
    const { document } = parseHTML(html);
    article = new Readability(document).parse();
  } catch {
    return null;
  }
  if (!article || !article.content) return null;
  return absolutizeUrls(article.content, url);
}

/**
 * 抓取文章網址並抽全文。
 * @param {string} url
 * @param {{fetchImpl?:function}} [opts] fetchImpl 供測試注入
 * @returns {Promise<string|null>}
 */
export async function fetchFullText(url, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const resp = await doFetch(url, { headers: { 'user-agent': 'Shinkansen-Feed/0.1 (+full-text)' } });
  if (!resp.ok) return null;
  const html = await resp.text();
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
