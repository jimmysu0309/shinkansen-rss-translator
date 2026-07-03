// html-segmenter.js — 把文章 HTML 切成可翻譯的文字段落,翻完再原位回填。
//
// 防漏譯是本專案存在的理由,這支是核心。策略:
//   **文字節點層級切段**(text-node walking)。只收集 / 替換文字節點的內容,
//   絕不觸碰任何「元素」。因此 <img> / <a> / <b> / 版面結構 100% 原樣保留 ——
//   等同 rssbox 的 BeautifulSoup 換節點做法,但譯文改走 Shinkansen 抗漏譯的
//   translateBatch(段序標記 + retry + 段數對映),結構上比 rssbox 更安全。
//
// 訊號層次:
//   ✓ 保證:輸出段數 === 輸入段數(段數不變量,呼叫端會斷言)
//   ✓ 保證:非文字節點(圖片 / 連結 / 標籤結構)不被改動
//   ✓ 只翻「含實際文字」的節點,純空白 / 純標點節點原樣保留(減少無意義段)
//   ✗ 已知限制:跨 inline 元素的句子被切成多段,少了整句語境(品質略降)。
//      更高品質的「block + ⟦⟧ 佔位符」切段列為 Phase 3b。
//   ✗ 不處理:<script> / <style> / <noscript> 內的文字(跳過,不翻)

import { parseHTML } from 'linkedom';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP']);
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// 「含實際文字」= 去掉空白後仍非空,且含至少一個字母 / 數字 / CJK。
// 純標點 / 純符號(例如 " · "、"—")不送翻,原樣保留。
function hasTranslatableText(s) {
  if (!s || !s.trim()) return false;
  return /[\p{L}\p{N}]/u.test(s);
}

function collectTextNodes(root, out) {
  for (const node of root.childNodes) {
    if (node.nodeType === TEXT_NODE) {
      if (hasTranslatableText(node.nodeValue)) out.push(node);
    } else if (node.nodeType === ELEMENT_NODE) {
      if (SKIP_TAGS.has(node.tagName)) continue;
      collectTextNodes(node, out);
    }
  }
}

/**
 * 切段。回傳 { texts, reassemble }。
 *   texts:要送翻的段落陣列(依文件順序)。
 *   reassemble(translations):把譯文填回原節點,回傳完整 HTML 字串。
 *     translations 長度必須等於 texts 長度,否則丟錯(防漏譯不變量)。
 *
 * 保留原文字節點前後的空白(只替換 trim 後的文字部分),避免破壞排版間距。
 *
 * @param {string} html 文章內容 HTML(片段即可)
 */
export function segmentHtml(html) {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html || ''}</body></html>`);
  const body = document.body;
  const nodes = [];
  collectTextNodes(body, nodes);

  // 記錄每段的前後空白,回填時保留
  const meta = nodes.map((n) => {
    const raw = n.nodeValue;
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.match(/\s*$/)[0];
    return { lead, trail, core: raw.slice(lead.length, raw.length - trail.length) };
  });
  const texts = meta.map((m) => m.core);

  function reassemble(translations) {
    if (!Array.isArray(translations) || translations.length !== nodes.length) {
      throw new Error(
        `html-segmenter 段數不符:輸入 ${nodes.length} 段、譯文 ${translations?.length} 段(防漏譯不變量被破壞)`,
      );
    }
    for (let i = 0; i < nodes.length; i++) {
      const t = translations[i];
      // 譯文為空 / undefined 時保留原文,不要留白(避免內容消失)
      const core = (t === undefined || t === null || t === '') ? texts[i] : t;
      nodes[i].nodeValue = meta[i].lead + core + meta[i].trail;
    }
    return body.innerHTML;
  }

  return { texts, reassemble };
}
