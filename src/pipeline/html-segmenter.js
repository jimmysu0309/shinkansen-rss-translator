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
//   ✓ 容器內區塊之間的「文字 + inline」合成一段(不逐文字節點切碎句子)
//   ✓ 防禦式回填(移植上游 content-serialize 修復鏈):壞標記收斂(❰❱ / ⟦0 drug⟧ / ⟦/2» / 全形數字)、
//     半殘配對補標記、重複標記去重、遺失的原子元素(圖片 / hr / code)補回段尾、殘留標記剝除、
//     CJK 標記旁幻覺空白收斂與中英交界補空格;單一段落壞掉不影響其他段落
//   ✗ 不驗:真實翻譯品質(整合測試 translateEntry 驗)
//
// 歷史:v1 用「文字節點層級」切段(結構安全但句子被 inline 切碎);此版換 block+佔位符提升語序品質。

import { parseHTML } from 'linkedom';

const TEXT_NODE = 1 + 2; // 3
const ELEMENT_NODE = 1;

// 內容不翻譯、原樣保留的容器
// HEAD:email 電子報(LetterFeed)給的是整份 <html><head>…<body> 文件,head 內的 title/style 不是內文
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'CODE', 'KBD', 'SAMP', 'HEAD']);
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

// 原始碼空白(含硬換行)瀏覽器顯示時本就壓成一個空格;PRE 在 SKIP_TAGS、<br> 走原子標記,
// 所以文字節點裡的 \n 一律是排版用空白。不壓的話會觸發引擎「段內換行保留」規則,
// Gemini 會吐字面 \n(2026-11-04 Daring Fireball 引文)。對齊上游 content-serialize 的 /\s+/ collapse。
function collapseWs(s) { return String(s).replace(/\s+/g, ' '); }
// 防禦層:模型仍吐字面 \n(反斜線 + n)且原文沒有時,換成空格(上游 v1.4.6 同類修正)
function stripLiteralNewlines(t, src) {
  return (t.includes('\\n') && !src.includes('\\n')) ? t.replace(/\\n/g, ' ') : t;
}
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
// ── 序列化:inline 內容 → 帶佔位符的純文字 + markers 對照 ──
// nodes:一個區塊的 childNodes,或容器下一串「鬆散 inline run」的兄弟節點
function serializeInline(nodes) {
  const markers = []; // markers[n] = { atomic, node }
  let s = '';
  const walk = (list) => {
    for (const node of list) {
      if (node.nodeType === TEXT_NODE) {
        s += collapseWs(node.nodeValue);
      } else if (node.nodeType === ELEMENT_NODE) {
        // 段內 inline 的 translate="no" / notranslate 整顆保留為 ⟦*N⟧ 不送翻(人名、代碼、icon 名)
        if (SKIP_TAGS.has(node.tagName) || isAtomic(node) || isNoTranslateMarked(node)) {
          const n = markers.length; markers.push({ atomic: true, node }); s += ATOM(n);
        } else {
          const n = markers.length; markers.push({ atomic: false, node }); s += OPEN(n);
          walk(node.childNodes);
          s += CLOSE(n);
        }
      }
    }
  };
  walk(nodes);
  return { text: s.trim(), markers };
}

// ── 譯文修復:移植上游 content-serialize.js(v2.5.8)的佔位符修復鏈 ──
// 上游是瀏覽器 content script(IIFE + window.__SK),無法 import,故重寫;
// 這是同一份事實的雙實作,升級 submodule 時照 CLAUDE.md 鐵律 2 比對同步。
const CJK = '[\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef]'; // = SK.CJK_CHAR
const TOK_SRC = '⟦[*\\/]?\\d+⟧';
const RE_ANY_TOKEN_G = /⟦\*?\/?\d+⟧/g;
const RE_CJK_SP_OPEN = new RegExp('(' + CJK + ')[ \\t]+(⟦\\d+⟧' + CJK + ')', 'g');
const RE_CJK_SP_CLOSE = new RegExp('(' + CJK + '⟦\\/\\d+⟧)[ \\t]+(' + CJK + ')', 'g');
const RE_CJK_SP_ATOMIC_L = new RegExp('(' + CJK + ')[ \\t]+(⟦\\*\\d+⟧)', 'g');
const RE_CJK_SP_ATOMIC_R = new RegExp('(⟦\\*\\d+⟧)[ \\t]+(' + CJK + ')', 'g');
const RE_CJK_RUN_MID = new RegExp('(' + CJK + ')((?:[ \\t]*(?:' + TOK_SRC + '))+[ \\t]*)(?=' + CJK + ')', 'g');
const RE_CJK_RUN_HEAD = new RegExp('^((?:[ \\t]*(?:' + TOK_SRC + '))+[ \\t]*)(?=' + CJK + ')');
const RE_CJK_RUN_TAIL = new RegExp('(' + CJK + ')((?:[ \\t]*(?:' + TOK_SRC + '))+[ \\t]*)$');
const RE_STRAY_HALF_CLOSE_G = /[*/]\d+⟧/g;
const RE_STRAY_BRACKETS_G = /[⟦⟧❰❱]/g;
// 與上游差一處:加注首字元用 [^\s⟧] 而非 \S——\S 會吃到 ⟧,把「⟦ 0 ⟧貓⟦/0 ⟧」整段誤當一個加注標記(上游同 bug)
const RE_NORM_ANNOTATED_G = /⟦\s*(\*?\/?\d+)[ \t]+[^\s⟧][^⟧]{0,28}⟧/g;
const RE_NORM_SPACED_G = /⟦\s*(\*?\/?\d+)\s*⟧/g;
const RE_NORM_MANGLED_CLOSE_G = /⟦(\*?\/?\d+)(?:[»›❱》〉≫]|(?=[^⟧0-9])|$)/g;
const RE_TOK_G = /⟦(\*)?(\/)?(\d+)⟧/g;
const RE_PAIRED_OCC_G = /⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧/g;
const RE_PARSE_G = /⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧|⟦\*(\d+)⟧/g;
const BOUNDARY_RE = /[。？！；，、.!?;,\n]/;
const RE_BOUNDARY_G = /[。？！；，、.!?;,\n]/g;
const FULLWIDTH = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9', '＊': '*', '／': '/' };

// 模型寫壞的標記收斂成標準形(上游 normalizeLlmPlaceholders):
//   ❰❱ 替代括號、⟦0 drug⟧ 加注、⟦ 0 ⟧ 空白、⟦/2» / 段尾 ⟦/2 漏閉合;
//   另補上游 prompt 有禁但沒修的全形數字 / 斜線 / 星號(⟦／０⟧)
export function normalizeLlmPlaceholders(s) {
  if (!s) return s;
  s = s.replace(/❰/g, '⟦').replace(/❱/g, '⟧');
  s = s.replace(/⟦[\s*/＊／0-9０-９]+/g, (m) => m.replace(/[０-９＊／]/g, (c) => FULLWIDTH[c]));
  s = s.replace(RE_NORM_ANNOTATED_G, '⟦$1⟧');
  s = s.replace(RE_NORM_SPACED_G, '⟦$1⟧');
  return s.replace(RE_NORM_MANGLED_CLOSE_G, '⟦$1⟧');
}

// 認不得的殘留標記從文字中剝掉,不讓 ⟦3⟧ / ⟦ / /2⟧ 碎片顯示在譯文(上游 stripStrayPlaceholderMarkers)
function stripStrayMarkers(s) {
  return normalizeLlmPlaceholders(s)
    .replace(RE_ANY_TOKEN_G, '')
    .replace(RE_STRAY_HALF_CLOSE_G, '')
    .replace(RE_STRAY_BRACKETS_G, '');
}

// 兩個 CJK 字元之間只隔著標記與空白時,空白是模型幻覺 → 移除(上游 collapseCjkSpacesAroundPlaceholders)。
// 不動 CJK / 拉丁邊界的空格(中英空格是合法排版)
export function collapseCjkSpacesAroundPlaceholders(s) {
  if (!s) return s;
  s = s.replace(RE_CJK_SP_OPEN, '$1$2');
  s = s.replace(RE_CJK_SP_CLOSE, '$1$2');
  s = s.replace(RE_CJK_SP_ATOMIC_L, '$1$2');
  s = s.replace(RE_CJK_SP_ATOMIC_R, '$1$2');
  const strip = (run) => run.replace(/[ \t]+/g, '');
  s = s.replace(RE_CJK_RUN_MID, (m, a, run) => a + strip(run));
  s = s.replace(RE_CJK_RUN_HEAD, (m, run) => strip(run));
  s = s.replace(RE_CJK_RUN_TAIL, (m, a, run) => a + strip(run));
  return s;
}

// 半殘配對修復(上游 repairHalfBrokenPlaceholders,2026-07-20):
//   A) 有開無關 → 往後掃,在「外層配對的關標記 / 子句邊界標點 / 字串尾」最早者前補 ⟦/N⟧
//   B) 有關無開 → 往回掃,在「最近的標記之後 / 子句邊界標點之後 / 字串頭」最近者補 ⟦N⟧
// 只插標記不動文字;只修 markers 裡真實存在的配對型 index
export function repairHalfBrokenPlaceholders(text, markers) {
  if (!text || !Array.isArray(markers) || markers.length === 0 || !text.includes('⟦')) return text;
  const isPaired = (mk) => !!mk && !mk.atomic;
  const toks = [];
  let m;
  RE_TOK_G.lastIndex = 0;
  while ((m = RE_TOK_G.exec(text)) !== null) {
    toks.push({ star: !!m[1], close: !!m[2], n: Number(m[3]), start: m.index, end: m.index + m[0].length });
  }
  if (toks.length === 0) return text;
  const opens = new Map();
  const closes = new Map();
  for (const t of toks) {
    if (t.star) continue;
    if (t.close) closes.set(t.n, t);
    else if (!opens.has(t.n)) opens.set(t.n, t);
  }
  const insertions = [];
  const brokenOpens = [...opens.keys()]
    .filter((n) => !closes.has(n) && isPaired(markers[n]))
    .sort((a, b) => opens.get(a).start - opens.get(b).start);
  for (const n of brokenOpens) {
    const openTok = opens.get(n);
    let cursor = openTok.end;
    let pos = text.length;
    const after = toks.filter((t) => t.start >= openTok.end).sort((a, b) => a.start - b.start);
    for (const t of after) {
      if (t.start < cursor) continue;
      const bm = text.slice(cursor, t.start).match(BOUNDARY_RE);
      if (bm) { pos = cursor + bm.index; break; }
      if (t.star) { cursor = t.end; continue; }
      if (!t.close) {
        const c = closes.get(t.n);
        cursor = (c && c.start > t.start) ? c.end : t.end;
        continue;
      }
      const o = opens.get(t.n);
      if (o && o.start < openTok.start) { pos = t.start; break; }
      cursor = t.end;
    }
    if (pos === text.length) {
      const bm = text.slice(cursor).match(BOUNDARY_RE);
      if (bm) pos = cursor + bm.index;
    }
    insertions.push({ pos, marker: CLOSE(n), tieOrder: openTok.start });
  }
  const brokenCloses = [...closes.keys()].filter((n) => !opens.has(n) && isPaired(markers[n]));
  for (const n of brokenCloses) {
    const closeTok = closes.get(n);
    const before = toks.filter((t) => t.end <= closeTok.start).sort((a, b) => b.end - a.end);
    const nearestTokEnd = before.length ? before[0].end : 0;
    const gap = text.slice(nearestTokEnd, closeTok.start);
    const g = gap.match(RE_BOUNDARY_G);
    const lastBoundary = g ? gap.lastIndexOf(g[g.length - 1]) : -1;
    const pos = lastBoundary >= 0 ? nearestTokEnd + lastBoundary + 1 : nearestTokEnd;
    insertions.push({ pos, marker: OPEN(n), tieOrder: -closeTok.start });
  }
  if (insertions.length === 0) return text;
  insertions.sort((a, b) => (b.pos - a.pos) || (a.tieOrder - b.tieOrder));
  let out = text;
  for (const ins of insertions) out = out.slice(0, ins.pos) + ins.marker + out.slice(ins.pos);
  return out;
}

// 同一配對標記出現多次 → 保留第一個有內容的,其餘降級成純文字(上游 selectBestSlotOccurrences)
export function selectBestSlotOccurrences(text) {
  if (!text) return text;
  const occ = [];
  let m;
  RE_PAIRED_OCC_G.lastIndex = 0;
  while ((m = RE_PAIRED_OCC_G.exec(text)) !== null) {
    occ.push({
      idx: Number(m[1]), start: m.index, end: m.index + m[0].length, inner: m[2],
      nonEmpty: m[2].replace(RE_ANY_TOKEN_G, '').trim().length > 0,
    });
  }
  const byIdx = new Map();
  for (const o of occ) {
    if (!byIdx.has(o.idx)) byIdx.set(o.idx, []);
    byIdx.get(o.idx).push(o);
  }
  const losers = [];
  for (const [, list] of byIdx) {
    if (list.length === 1) continue;
    const winner = list.find((o) => o.nonEmpty) || list[0];
    for (const o of list) if (o !== winner) losers.push(o);
  }
  if (losers.length === 0) return text;
  losers.sort((a, b) => b.start - a.start);
  let out = text;
  for (const l of losers) out = out.slice(0, l.start) + l.inner + out.slice(l.end);
  return out;
}

// ── 回填:譯文 → DOM(上游 parseSegment / _maybePadCjkLatinSpace / _appendInlineImg)──
function tailEndsCjk(t) { return /[㐀-鿿豈-﫿ｦ-ﾟ]$/.test(t || ''); }
function headStartsLatin(t) { return /^[A-Za-z0-9@#\-+/%&]/.test((t || '').replace(/^\s+/, '')); }
function findTrailingTextNode(node) {
  let cur = node;
  while (cur && cur.nodeType === ELEMENT_NODE) {
    if (cur.tagName === 'BR') return null;
    cur = cur.lastChild;
  }
  return cur && cur.nodeType === TEXT_NODE ? cur : null;
}
function appendSpaceToTail(last) {
  if (last.nodeType === TEXT_NODE) last.nodeValue += ' ';
  else { const t = findTrailingTextNode(last); if (t) t.nodeValue += ' '; }
}
function tailText(last) {
  return last.nodeType === TEXT_NODE ? (last.nodeValue || '') : (last.textContent || '');
}
// CJK 結尾 + 下一個元素以拉丁字開頭 → 補一格(台灣排版慣例;模型常吃掉標記周邊空白)
function maybePadCjkLatin(container, next) {
  const last = container.lastChild;
  if (!last) return;
  const t = tailText(last);
  if (!t || /\s$/.test(t) || !tailEndsCjk(t)) return;
  if (!headStartsLatin(next.textContent || '')) return;
  appendSpaceToTail(last);
}
// 段內圖片前後補空格(CJK 空白收斂會讓圖片緊貼文字)
function appendInlineImg(container, img) {
  const last = container.lastChild;
  if (last) {
    const t = tailText(last);
    if (t && !/\s$/.test(t)) appendSpaceToTail(last);
  }
  container.appendChild(img);
  container.appendChild(container.ownerDocument.createTextNode(' '));
}
function placeAtomic(container, node) {
  const c = node.cloneNode(true);
  if (c.tagName === 'IMG') appendInlineImg(container, c);
  else { maybePadCjkLatin(container, c); container.appendChild(c); }
}
function parseInto(container, text, markers, used) {
  const doc = container.ownerDocument;
  const pushText = (s) => {
    const clean = stripStrayMarkers(s);
    if (clean) container.appendChild(doc.createTextNode(clean));
  };
  // 不共用全域 regex:巢狀遞迴會互相改 lastIndex
  const re = new RegExp(RE_PARSE_G.source, 'g');
  let cursor = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) pushText(text.slice(cursor, m.index));
    if (m[3] !== undefined) {
      const n = Number(m[3]);
      const mk = markers[n];
      if (mk && mk.atomic && !used.has(n)) { used.add(n); placeAtomic(container, mk.node); }
    } else {
      const n = Number(m[1]);
      const mk = markers[n];
      if (mk && !mk.atomic) {
        used.add(n);
        const shell = mk.node.cloneNode(false);
        parseInto(shell, m[2], markers, used);
        maybePadCjkLatin(container, shell);
        container.appendChild(shell);
      } else {
        parseInto(container, m[2], markers, used); // 壞索引:殼丟掉、內文保留
      }
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) pushText(text.slice(cursor));
}

// 防禦式回填:修復鏈 → 建 DOM → 回收遺失的原子元素
function rebuildInto(container, str, markers) {
  let t = normalizeLlmPlaceholders(str);
  t = collapseCjkSpacesAroundPlaceholders(t);
  t = repairHalfBrokenPlaceholders(t, markers);
  t = selectBestSlotOccurrences(t);
  const used = new Set();
  parseInto(container, t, markers, used);
  // 遺失回收(上游 2026-07-09):模型把 ⟦*N⟧ 整顆吃掉 → 圖片 / hr / inline code 會從段落消失。
  // 位置資訊已隨譯文遺失,補到段尾是無資訊下的最小破壞。配對型(連結 / 粗體)不回收:文字還在譯文裡。
  // 上游只在「至少配到一個標記」時回收(否則走 fallback 不用此結果);本專案沒有 fallback,一律回收。
  markers.forEach((mk, n) => { if (mk.atomic && !used.has(n)) placeAtomic(container, mk.node); });
}

// ── 收集翻譯單位 ──
// 不翻、且會打斷 inline run 的容器(CODE / KBD / SAMP 在 run 內走原子標記,不打斷)
const RUN_BREAK_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'HEAD']);
function hasTranslateYesDescendant(el) {
  for (const d of el.querySelectorAll('[translate]')) if (isTranslateYes(d)) return true;
  return false;
}
function pushRun(run, units) {
  while (run.length && run[run.length - 1].nodeType !== TEXT_NODE && run[run.length - 1].nodeType !== ELEMENT_NODE) run.pop();
  if (!run.some((n) => hasTranslatable(n.textContent))) return;
  // 只有一個非原子元素(其餘是空白)→ 照區塊處理:回填只換它的 innerHTML,元素本身不經佔位符,最穩
  const els = run.filter((n) => n.nodeType === ELEMENT_NODE);
  const onlyWs = run.every((n) => n.nodeType === ELEMENT_NODE || !/\S/.test(n.nodeValue || ''));
  if (els.length === 1 && onlyWs && !isAtomic(els[0]) && !SKIP_TAGS.has(els[0].tagName) && !isNoTranslateMarked(els[0])) {
    units.push({ kind: 'block', node: els[0] });
    return;
  }
  units.push({ kind: 'run', nodes: run.slice() });
}
// 葉子區塊自成一段;容器內「區塊之間」連續的文字 + inline(連結、粗體、圖片、inline code)合成一個 run 一段,
// 不再逐文字節點切碎(`<li>See <a>this</a> for more.<ul>…` 原本切成三段,句子語境斷掉;對齊上游
// content-detect extractInlineFragments)。
// skipped=true:在 translate="no" 子樹內,不收集,只往下找 translate="yes" 重開的後代。
function collectUnits(root, units, noTr, skipped = false) {
  let run = [];
  const flush = () => { if (run.length) pushRun(run, units); run = []; };
  for (const node of root.childNodes) {
    if (node.nodeType === TEXT_NODE) {
      if (!skipped) run.push(node);
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) {
      if (run.length) run.push(node); // run 中間的註解跟著 run 一起被替換
      continue;
    }
    if (skipped) {
      if (!isTranslateYes(node)) { collectUnits(node, units, noTr, true); continue; }
      // translate="yes" 重開:這顆自成單位
      if (isBlock(node) || containsBlock(node)) collectUnits(node, units, noTr);
      else if (hasTranslatable(node.textContent) && !isAtomic(node)) units.push({ kind: 'block', node });
      continue;
    }
    if (RUN_BREAK_TAGS.has(node.tagName)) { flush(); continue; }
    if (isBlock(node) || (!isAtomic(node) && containsBlock(node))) {
      flush();
      if (noTr(node)) { collectUnits(node, units, noTr, true); continue; }
      // 非區塊標籤卻包著區塊(<html>/<body>/<center>/<a> 包 <div>…)也當容器往下找。
      // 不這樣做會整顆變一段:2026-10-16 Culpium 電子報整封 18K 字元成 1 段,譯文超過 maxOutputTokens
      if (containsBlock(node)) collectUnits(node, units, noTr);
      else if (hasTranslatable(node.textContent)) units.push({ kind: 'block', node });
      continue;
    }
    // inline:notranslate 的 inline 在 run 內走原子標記;但內含 translate="yes" 後代時要往下重開
    if (isNoTranslateMarked(node) && noTr(node) && hasTranslateYesDescendant(node)) {
      flush();
      collectUnits(node, units, noTr, true);
      continue;
    }
    run.push(node);
  }
  flush();
}

// ── textnode 模式:逐「文字節點」切段(無佔位符)──
// 給不吃佔位符的引擎(Google 翻譯):純文字進出,結構靠只換文字節點保留。
// 代價:跨 inline 的句子被切碎、少整句語境;但 Google 品質本就普通,可接受。
const TN_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'HEAD']);
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
    const { text, markers } = serializeInline(u.kind === 'run' ? u.nodes : u.node.childNodes);
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
      const val = (t === undefined || t === null || t === '') ? p.text : stripLiteralNewlines(t, p.text); // 空譯文保留原文
      if (p.u.kind === 'block') {
        const el = p.u.node;
        while (el.firstChild) el.removeChild(el.firstChild);
        rebuildInto(el, val, p.markers);
      } else {
        // run:譯文建在暫存容器,搬到 run 第一個節點前,再移除原 run 節點;頭尾空白保留(與相鄰元素的間距)
        const nodes = p.u.nodes;
        const first = nodes[0], last = nodes[nodes.length - 1];
        const parent = first.parentNode;
        const tmp = document.createElement('div');
        rebuildInto(tmp, val, p.markers);
        const lead = first.nodeType === TEXT_NODE ? first.nodeValue.match(/^\s*/)[0] : '';
        const trail = last.nodeType === TEXT_NODE ? last.nodeValue.match(/\s*$/)[0] : '';
        if (lead) parent.insertBefore(document.createTextNode(lead), first);
        while (tmp.firstChild) parent.insertBefore(tmp.firstChild, first);
        if (trail) parent.insertBefore(document.createTextNode(trail), first);
        for (const n of nodes) parent.removeChild(n);
      }
    }
    return body.innerHTML;
  }

  return { texts, reassemble };
}
