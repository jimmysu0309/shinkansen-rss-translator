// html-segmenter.js — 把文章 HTML 切成可翻譯段落,翻完原位回填。
//
// 策略:**整段 + ⟦⟧ 佔位符切段(block + placeholder)**。
//   - 以「葉子區塊」(p / li / h1-6 / blockquote …,且內部沒有巢狀區塊)為一個翻譯單位,
//     整段一起送翻 → LLM 有完整句子語境,中英語序才對(勝過把句子按 inline 切碎)。
//   - 段內的 inline 元素(a / b / em / span …)用配對佔位符 ⟦N⟧…⟦/N⟧ 包住;
//     不可翻譯的原子元素(img / br / hr)用自閉合 ⟦*N⟧。引擎 system prompt 已內建
//     「原樣保留佔位符」規則,故 translateBatch 會把標記原封帶回,回填時換回原元素。
//
// 訊號層次:
//   ✓ 段數不變量:texts 段數 = 翻譯單位數;reassemble 段數不符丟錯
//   ✓ 結構/圖片/連結/屬性保留(img 走原子標記、inline 走配對標記還原 tag+屬性)
//   ✓ 尊重 translate="no" / class="notranslate"(區塊整顆跳過、inline 走原子標記;translate="yes" 重開;
//     文件級 wrapper 不採信)—— 跟進 Shinkansen v2.4.13
//   ✓ 防禦式回填:LLM 弄壞/漏標記時不崩(未配對的開標記在段末補關、壞標記略過),
//     且單一段落壞掉不影響其他段落
//   ✗ 不驗:真實翻譯品質(整合測試 translateEntry 驗)
//
// 歷史:v1 用「文字節點層級」切段(結構安全但句子被 inline 切碎);此版換 block+佔位符提升語序品質。

import { parseHTML } from 'linkedom';

const TEXT_NODE = 1 + 2; // 3
const ELEMENT_NODE = 1;

// 內容不翻譯、原樣保留的容器
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'CODE', 'KBD', 'SAMP']);
// 區塊級元素(當作翻譯單位的候選)
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
  'DD', 'DT', 'FIGCAPTION', 'SUMMARY', 'TD', 'TH', 'CAPTION', 'SECTION', 'ARTICLE',
  'HEADER', 'FOOTER', 'ASIDE', 'MAIN', 'UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY', 'TR', 'FIGURE',
]);
// 原子(不可翻、無文字)inline 元素 → 自閉合佔位符
const ATOMIC_TAGS = new Set(['IMG', 'BR', 'HR', 'WBR', 'INPUT', 'SVG', 'VIDEO', 'AUDIO', 'IFRAME', 'EMBED', 'OBJECT']);

// 「不翻譯」宣告(跟進 Shinkansen v2.4.13,移植 content-ns.js isNoTranslateMarked /
// content-detect.js isInsideExcludedContainer 的語意):
//   - HTML 標準 translate="no" 屬性,或 Google Translate 慣例的 class="notranslate"
//   - 依 HTML 規範,translate="yes" 可在 translate="no" 祖先內重新開放翻譯
//   - 「文件級」宣告不採信:整篇內容被一個 notranslate wrapper 包住(其文字量佔整體一半以上)
//     多半是 SPA 避開 Google Translate 改 DOM 的 workaround,不代表內容不該翻
//   - 上游另有 icon 字型 ligature 判斷(靠 computed font-family),伺服器端無 CSS 可查,不移植
function isNoTranslateMarked(el) {
  const tr = el.getAttribute && el.getAttribute('translate');
  if (tr != null && tr.trim().toLowerCase() === 'no') return true;
  return !!(el.classList && el.classList.contains('notranslate'));
}
function isTranslateYes(el) {
  const tr = el.getAttribute && el.getAttribute('translate');
  return tr != null && tr.trim().toLowerCase() === 'yes';
}
// 回傳「這個元素是否該整顆跳過」的判斷函式;文件級 wrapper 以 body 文字量為基準豁免
function makeNoTranslateChecker(body) {
  const bodyLen = (body.textContent || '').length;
  return (el) => {
    if (!isNoTranslateMarked(el)) return false;
    if (el.children.length === 0 || bodyLen === 0) return true;
    return (el.textContent || '').length * 2 < bodyLen; // 佔一半以上 = 文件級,不採信
  };
}

const OPEN = (n) => `⟦${n}⟧`;        // ⟦N⟧
const CLOSE = (n) => `⟦/${n}⟧`;      // ⟦/N⟧
const ATOM = (n) => `⟦*${n}⟧`;       // ⟦*N⟧
const MARKER_RE = /⟦(\/)?(\*)?(\d+)⟧/g;

function hasTranslatable(s) { return !!s && /[\p{L}\p{N}]/u.test(s); }
function isBlock(el) { return BLOCK_TAGS.has(el.tagName); }
function isAtomic(el) { return ATOMIC_TAGS.has(el.tagName); }
function containsBlock(el) {
  for (const c of el.children) {
    if (isBlock(c)) return true;
    if (containsBlock(c)) return true;
  }
  return false;
}
function escText(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function escAttr(s) { return String(s).replace(/[&"]/g, (c) => ({ '&': '&amp;', '"': '&quot;' }[c])); }
function openTag(el) {
  let s = '<' + el.tagName.toLowerCase();
  for (const a of el.attributes) s += ` ${a.name}="${escAttr(a.value)}"`;
  return s + '>';
}
function closeTag(el) { return '</' + el.tagName.toLowerCase() + '>'; }

// 把一個區塊的 inline 內容序列化成「帶佔位符的純文字」+ markers 對照
function serializeInline(el) {
  const markers = []; // markers[n] = { atomic, node }
  let s = '';
  const walk = (parent) => {
    for (const node of parent.childNodes) {
      if (node.nodeType === TEXT_NODE) {
        s += node.nodeValue;
      } else if (node.nodeType === ELEMENT_NODE) {
        // 段內 inline 的 translate="no" / notranslate 整顆保留為 ⟦*N⟧ 不送翻(人名、代碼、icon 名)
        if (SKIP_TAGS.has(node.tagName) || isAtomic(node) || isNoTranslateMarked(node)) {
          const n = markers.length; markers.push({ atomic: true, node }); s += ATOM(n);
        } else {
          const n = markers.length; markers.push({ atomic: false, node }); s += OPEN(n);
          walk(node);
          s += CLOSE(n);
        }
      }
    }
  };
  walk(el);
  return { text: s, markers };
}

// 防禦式回填:把帶佔位符的譯文還原成 innerHTML
function rebuildInline(str, markers) {
  let out = '';
  const stack = [];
  let last = 0, m;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(str))) {
    out += escText(str.slice(last, m.index));
    last = MARKER_RE.lastIndex;
    const isClose = !!m[1], isAtom = !!m[2], n = Number(m[3]);
    const mk = markers[n];
    if (isAtom) {
      if (mk && mk.atomic) out += mk.node.outerHTML; // 壞索引則略過
    } else if (isClose) {
      // 關到對應的開標記;找不到就忽略(段末統一補關)
      const idx = stack.lastIndexOf(n);
      if (idx !== -1) { out += closeTag(markers[n].node); stack.splice(idx, 1); }
    } else {
      if (mk && !mk.atomic) { out += openTag(mk.node); stack.push(n); }
    }
  }
  out += escText(str.slice(last));
  while (stack.length) out += closeTag(markers[stack.pop()].node); // 未關的補關
  return out;
}

// 收集翻譯單位(葉子區塊 / 容器內的鬆散文字 / 鬆散 inline)
// skipped=true 代表在 translate="no" 子樹內:不收集,但仍往下走,只為了找 translate="yes" 重開的後代。
function collectUnits(root, units, noTr, skipped = false) {
  for (const node of root.childNodes) {
    if (node.nodeType === TEXT_NODE) {
      if (!skipped && hasTranslatable(node.nodeValue)) units.push({ kind: 'text', node });
    } else if (node.nodeType === ELEMENT_NODE) {
      if (SKIP_TAGS.has(node.tagName)) continue;
      let sk = skipped;
      if (sk) { if (isTranslateYes(node)) sk = false; }
      else if (noTr(node)) sk = true;
      if (sk) { collectUnits(node, units, noTr, true); continue; }
      if (isBlock(node)) {
        if (containsBlock(node)) collectUnits(node, units, noTr); // 容器 → 往下找葉子區塊
        else if (hasTranslatable(node.textContent)) units.push({ kind: 'block', node });
      } else if (!isAtomic(node) && hasTranslatable(node.textContent)) {
        units.push({ kind: 'block', node });                       // 容器下鬆散的 inline,自成一段
      }
    }
  }
}

// ── textnode 模式:逐「文字節點」切段(無佔位符)──
// 給不吃佔位符的引擎(Google 翻譯):純文字進出,結構靠只換文字節點保留。
// 代價:跨 inline 的句子被切碎、少整句語境;但 Google 品質本就普通,可接受。
const TN_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP']);
function collectTextNodes(root, out, noTr, skipped = false) {
  for (const node of root.childNodes) {
    if (node.nodeType === TEXT_NODE) {
      if (!skipped && hasTranslatable(node.nodeValue)) out.push(node);
    } else if (node.nodeType === ELEMENT_NODE && !TN_SKIP.has(node.tagName)) {
      // translate="no" / notranslate 子樹不收;translate="yes" 後代重開(語意同 collectUnits)
      let sk = skipped;
      if (sk) { if (isTranslateYes(node)) sk = false; }
      else if (noTr(node)) sk = true;
      collectTextNodes(node, out, noTr, sk);
    }
  }
}
function segmentTextNodes(body) {
  const nodes = [];
  collectTextNodes(body, nodes, makeNoTranslateChecker(body));
  const meta = nodes.map((n) => {
    const raw = n.nodeValue;
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.match(/\s*$/)[0];
    return { lead, trail, core: raw.slice(lead.length, raw.length - trail.length) };
  });
  const texts = meta.map((m) => m.core);
  function reassemble(translations) {
    if (!Array.isArray(translations) || translations.length !== nodes.length) {
      throw new Error(`html-segmenter 段數不符:輸入 ${nodes.length} 段、譯文 ${translations?.length} 段`);
    }
    for (let i = 0; i < nodes.length; i++) {
      const t = translations[i];
      const core = (t === undefined || t === null || t === '') ? texts[i] : t;
      nodes[i].nodeValue = meta[i].lead + core + meta[i].trail;
    }
    return body.innerHTML;
  }
  return { texts, reassemble };
}

/**
 * 切段。回傳 { texts, reassemble }。
 * @param {string} html 文章內容 HTML(片段即可)
 * @param {{mode?: 'placeholder'|'textnode'}} [opts]
 *   placeholder(預設,給 Gemini):block + ⟦⟧ 佔位符,整句語境、語序準。
 *   textnode(給 Google 翻譯):逐文字節點、無標記,避免純文字 MT 弄壞佔位符。
 */
export function segmentHtml(html, opts = {}) {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html || ''}</body></html>`);
  const body = document.body;
  if (opts.mode === 'textnode') return segmentTextNodes(body);
  const units = [];
  collectUnits(body, units, makeNoTranslateChecker(body));

  // 為每個單位算出送翻文字 + 回填用資料
  const prepared = units.map((u) => {
    if (u.kind === 'text') {
      const raw = u.node.nodeValue;
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      return { u, text: raw.slice(lead.length, raw.length - trail.length), lead, trail };
    }
    const { text, markers } = serializeInline(u.node);
    return { u, text, markers };
  })
    // 去掉佔位符後沒有可翻文字的單位(整段只剩 ⟦*N⟧,例如段落裡只有 <code> 或 notranslate 的人名)
    // 不送翻:省 token,也避免 LLM 對「只有標記」的輸入亂補字
    .filter((p) => hasTranslatable(p.text.replace(MARKER_RE, '')));
  const texts = prepared.map((p) => p.text);

  function reassemble(translations) {
    if (!Array.isArray(translations) || translations.length !== prepared.length) {
      throw new Error(
        `html-segmenter 段數不符:輸入 ${prepared.length} 段、譯文 ${translations?.length} 段(防漏譯不變量被破壞)`,
      );
    }
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      const t = translations[i];
      const val = (t === undefined || t === null || t === '') ? p.text : t; // 空譯文保留原文
      if (p.u.kind === 'text') {
        p.u.node.nodeValue = p.lead + val + p.trail;
      } else {
        p.u.node.innerHTML = rebuildInline(val, p.markers);
      }
    }
    return body.innerHTML;
  }

  return { texts, reassemble };
}
