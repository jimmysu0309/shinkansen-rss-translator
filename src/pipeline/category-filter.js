// category-filter.js — 逐 feed「依分類排除文章」。
//
// 用途:綜合 feed 裡混有另外單獨訂閱的子專欄(例:The Verge 主 feed 內含 Installer /
// The Stepback / Optimizer 電子報,Atom <category term="…">),在入庫前就丟掉 ——
// 不入庫 = 不翻譯、不燒 token、RSS 輸出也不會出現。
//
// 儲存形狀:feeds.exclude_categories 為逗號分隔字串(null = 不排除)。
// 比對規則:去頭尾空白、不分大小寫、整個分類名完全相等(不做子字串比對,避免 "AI" 誤中 "Email")。
//
// 訊號層次:
//   ✓ 純函式:解析 / 正規化 / 比對(離線單元測試)
//   ✗ 不驗:來源站分類命名是否穩定(來源改名就會漏網,靜默)

/** 逗號分隔字串或陣列 → 去重、去空白後的分類名陣列 */
export function parseCategoryList(v) {
  if (v === null || v === undefined) return [];
  const parts = Array.isArray(v) ? v : String(v).split(/[,，\n]/);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const s = String(p ?? '').trim();
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
  }
  return out;
}

/** API / 備份輸入 → 落庫值:空 → null;否則 "A, B, C" */
export function normalizeExcludeCategories(v) {
  const list = parseCategoryList(v);
  return list.length ? list.join(', ') : null;
}

/** 文章分類是否命中排除清單;命中回傳該分類名(供 log),否則 null */
export function matchExcludedCategory(itemCategories, excludeSetting) {
  const ex = parseCategoryList(excludeSetting);
  if (!ex.length || !Array.isArray(itemCategories) || !itemCategories.length) return null;
  const wanted = new Set(ex.map((s) => s.toLowerCase()));
  for (const c of itemCategories) {
    if (typeof c === 'string' && wanted.has(c.trim().toLowerCase())) return c.trim();
  }
  return null;
}
