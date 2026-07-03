// rss-output.js — 把譯好的 entries 組成 Atom feed 給 Miniflux 訂閱。
//
// 策略:每篇用「譯文」;若該篇還沒翻好(pending/error)則退回原文,
// 確保 Miniflux 永遠看得到文章,翻好後下次刷新自動變中文。
//
// 訊號層次:
//   ✓ 輸出 Atom XML,含正確篇數、譯文標題/內文、連結、日期
//   ✓ pending/error 篇退回原文(不遺漏文章)
//   ✗ 不驗:Miniflux 端解析(部署時實測)

import { Feed } from 'feed';

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

  for (const e of entries) {
    const done = e.translation_status === 'done';
    out.addItem({
      title: (done && e.title_translated) || e.title || '(無標題)',
      id: e.guid,
      link: e.url || feed.source_url,
      content: (done && e.content_translated) || e.content_html || '',
      date: e.published_at ? new Date(e.published_at) : new Date(e.created_at || 0),
    });
  }

  return out.atom1();
}

function latestDate(entries) {
  let max = 0;
  for (const e of entries) {
    const t = e.published_at || e.created_at || 0;
    if (t > max) max = t;
  }
  return max ? new Date(max) : null;
}
