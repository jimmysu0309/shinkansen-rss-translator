// rss-output.js — 把譯好的 entries 組成 Atom feed 給 Miniflux 訂閱。
//
// 策略:每篇用「譯文」;若該篇還沒翻好(pending/error)則退回原文,
// 確保 Miniflux 永遠看得到文章,翻好後下次刷新自動變中文。
//
// 訊號層次:
//   ✓ 輸出 Atom XML,含正確篇數、譯文標題/內文、連結、日期
//   ✓ pending/error 篇退回原文(不遺漏文章)
//   ✓ 有 image_url 的篇章把封面圖前置成 hero(內文已有同圖 / 開頭已有圖則不加)
//   ✗ 不驗:Miniflux 端解析與實際版面(部署時實測)

import { Feed } from 'feed';
import { getOpenccConvert } from '../engine.js';

/**
 * @param {object} args
 * @param {object} args.feed  feeds 表一列(提供 title / source_url)
 * @param {Array}  args.entries entries 列(依時間新到舊)
 * @param {string} args.selfUrl 本 feed 的輸出網址(Atom self link / id)
 * @returns {string} Atom 1.0 XML
 */
export function buildFeedXml({ feed, entries, selfUrl }) {
  const title = feed.title || feed.source_url || 'Shinkansen RSS Translator';
  const updated = latestDate(entries) || new Date(0);

  const out = new Feed({
    title: `${title}（繁中翻譯）`,
    id: selfUrl || feed.source_url,
    link: feed.source_url,
    updated,
    generator: 'Shinkansen RSS Translator',
    feedLinks: selfUrl ? { atom: selfUrl } : undefined,
  });

  // 作者欄:LLM 引擎保留原名不翻譯(AI 不該改寫人名);opencc 是零失真字元映射,
  // 作者名一併轉繁(對齊被取代的 opencc proxy 整份直轉行為)。
  const convertAuthor = feed.engine === 'opencc' ? getOpenccConvert() : (s) => s;

  for (const e of entries) {
    const done = e.translation_status === 'done';
    out.addItem({
      title: (done && e.title_translated) || e.title || '(無標題)',
      id: e.guid,
      link: e.url || feed.source_url,
      // 作者沒帶會讓下游(Miniflux → Readwise)整條丟失作者
      author: e.author ? [{ name: convertAuthor(e.author) }] : undefined,
      content: withHero((done && e.content_translated) || e.content_html || '', e.image_url),
      date: e.published_at ? new Date(e.published_at) : new Date(e.created_at || 0),
    });
  }

  return out.atom1();
}

// 封面圖前置成 hero。做在輸出層(而非入庫或翻譯前)是刻意的:翻譯管線的
// 「段數進出必須相等」斷言只認內文,hero 在譯完之後才貼,永遠不可能影響切段回填。
//
// 兩個不加的情況:
//   1. 內文已經出現同一張圖(比對「去掉 query 的網址」,CDN 常在同圖後面掛不同參數)
//   2. 內文開頭 600 字元內已經有 <img>(圖輯類文章本來就以圖開場,再前置一張會變重複封面)
// 判斷刻意用字串比對而不引 DOM 解析器:輸出路徑每次刷新都會跑,不值得為此背一個解析器。
const HEAD_WINDOW = 600;

function stripQuery(url) {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
}

export function withHero(html, imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return html;
  const body = html || '';
  if (body.slice(0, HEAD_WINDOW).includes('<img')) return body;
  if (body.includes(stripQuery(imageUrl))) return body;
  return `<figure><img src="${escapeAttr(imageUrl)}" alt="" /></figure>${body}`;
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function latestDate(entries) {
  let max = 0;
  for (const e of entries) {
    const t = e.published_at || e.created_at || 0;
    if (t > max) max = t;
  }
  return max ? new Date(max) : null;
}
