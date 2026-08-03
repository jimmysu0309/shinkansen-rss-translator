// opml.js — feed 清單的 OPML 匯入 / 匯出。
//
// 匯出:把本服務的 feed 產成 OPML。每個 outline 的
//   xmlUrl  = 譯後 RSS 輸出網址(可直接匯入 Miniflux 等閱讀器批次訂閱)
//   htmlUrl = 原始來源網址(備份 / 追溯用)
// 匯入:讀每個 outline 的 xmlUrl(退而求其次 htmlUrl)當作新 feed 的來源網址,批次新增。
//
// 訊號層次:
//   ✓ 匯出 OPML 結構正確、每個 feed 一個 outline、屬性跳脫
//   ✓ 匯入能解析標準 OPML(含巢狀資料夾 outline)、取出 xmlUrl / title
//   ✗ 不驗:各家閱讀器的 OPML 方言邊角(遇到再補)

function xmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

/**
 * @param {Array} feeds feeds 表列
 * @param {(feed)=>string} rssUrlOf 回傳該 feed 的譯後 RSS 網址
 * @returns {string} OPML XML
 */
export function feedsToOpml(feeds, rssUrlOf) {
  const outlines = feeds.map((f) => {
    const title = xmlEscape(f.title || f.source_url);
    const xmlUrl = xmlEscape(rssUrlOf(f));
    const htmlUrl = xmlEscape(f.source_url);
    return `    <outline type="rss" text="${title}" title="${title}" xmlUrl="${xmlUrl}" htmlUrl="${htmlUrl}"/>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Shinkansen RSS Translator 訂閱清單</title>
  </head>
  <body>
${outlines}
  </body>
</opml>`;
}

/**
 * 解析 OPML 字串 → [{ source_url, title }]。分類(category 屬性)不收:分類交給 Miniflux 匯入時處理。
 * 用 regex 直接抽 outline 標籤(對自閉合 / 巢狀 / 屬性順序都穩,避開 HTML 解析器對自訂標籤的怪癖)。
 * @param {string} opmlText
 * @returns {Array<{source_url:string, title:string|null}>}
 */
export function parseOpml(opmlText) {
  const out = [];
  const outlineRe = /<outline\b([^>]*?)\/?>/gi;
  let m;
  while ((m = outlineRe.exec(opmlText || ''))) {
    const attrs = parseAttrs(m[1]);
    const url = attrs.xmlurl || attrs.htmlurl;
    if (!url) continue; // 資料夾型 outline(只有 text、無 url)→ 跳過
    out.push({
      source_url: xmlUnescape(url.trim()),
      title: xmlUnescape(attrs.title || attrs.text || '') || null,
    });
  }
  return out;
}

// 把屬性字串解析成 { 小寫鍵: 值 }(雙引號 / 單引號皆可 —— 部分閱讀器匯出用單引號)
function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1].toLowerCase()] = m[2] ?? m[3];
  return attrs;
}

function xmlUnescape(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
