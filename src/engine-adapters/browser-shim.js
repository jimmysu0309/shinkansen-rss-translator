// browser-shim.js — 在 Node 環境提供最小可用的 chrome.storage 相容層。
//
// 為什麼需要:Shinkansen 引擎透過 lib/compat.js 的 Proxy 讀 globalThis.chrome / globalThis.browser。
// 在瀏覽器擴充環境這是真的 chrome.storage;在 Node 沒有,任何 storage 呼叫會 throw。
// 依專案鐵律「不改 vendor、寫適配層」,這裡在 import 引擎「之前」把 globalThis.chrome
// 設成一個忠實的記憶體版 storage —— 呼叫 get/set/remove 會真的 round-trip,不是回空物件。
//
// 這條的訊號層次:
//   ✓ 讓 logger.js / storage.js / cache.js / rate-limiter.js 的 chrome.storage 呼叫在 Node 不炸
//   ✓ 提供 get/set 一致性(set 後 get 讀得到),供離線測試驗證行為
//   ✗ 不做持久化 —— 程式重啟即清空。真正的設定/快取/用量持久化在 Phase 2 用 SQLite 後端接管。
//
// 匯入本檔即安裝(side-effect)。也匯出 store 與 installBrowserShim 供測試檢查 / 重置。

/** 建立一個 chrome.storage.StorageArea 相容的記憶體實作 */
function makeStorageArea() {
  const map = new Map();

  // 忠實模擬 chrome.storage 的 get 多型:
  //   get()/get(null)      → 全部
  //   get('k')             → { k: v }(不存在則不含該鍵)
  //   get(['k1','k2'])     → present 的鍵
  //   get({ k: default })  → k,不存在則用 default
  async function get(query) {
    if (query == null) return Object.fromEntries(map);
    if (typeof query === 'string') {
      return map.has(query) ? { [query]: map.get(query) } : {};
    }
    if (Array.isArray(query)) {
      const out = {};
      for (const k of query) if (map.has(k)) out[k] = map.get(k);
      return out;
    }
    // 物件形式:鍵帶預設值
    const out = {};
    for (const [k, def] of Object.entries(query)) {
      out[k] = map.has(k) ? map.get(k) : def;
    }
    return out;
  }

  async function set(items) {
    const changes = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: map.get(k), newValue: v };
      map.set(k, v);
    }
    emitChange(changes, areaName);
  }

  async function remove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    for (const k of arr) {
      if (map.has(k)) { changes[k] = { oldValue: map.get(k), newValue: undefined }; map.delete(k); }
    }
    emitChange(changes, areaName);
  }

  async function clear() {
    const changes = {};
    for (const [k, v] of map) changes[k] = { oldValue: v, newValue: undefined };
    map.clear();
    emitChange(changes, areaName);
  }

  async function getBytesInUse() {
    return Buffer.byteLength(JSON.stringify(Object.fromEntries(map)) || '', 'utf8');
  }

  let areaName = 'local'; // 由 install 時覆寫
  const area = { get, set, remove, clear, getBytesInUse, _map: map, _setAreaName: (n) => { areaName = n; } };
  return area;
}

const listeners = new Set();
function emitChange(changes, areaName) {
  if (!changes || Object.keys(changes).length === 0) return;
  for (const fn of listeners) {
    try { fn(changes, areaName); } catch { /* listener 錯誤不影響 storage 寫入 */ }
  }
}

const local = makeStorageArea(); local._setAreaName('local');
const sync = makeStorageArea(); sync._setAreaName('sync');
const session = makeStorageArea(); session._setAreaName('session');

const storage = {
  local,
  sync,
  session,
  onChanged: {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
  },
};

const chromeShim = { storage };

/** 安裝 shim 到 globalThis(冪等)。回傳 store 供測試檢查。 */
export function installBrowserShim() {
  if (!globalThis.chrome) globalThis.chrome = chromeShim;
  if (!globalThis.browser) globalThis.browser = chromeShim;
  return { chrome: globalThis.chrome, storage };
}

/** 清空所有記憶體 storage(測試隔離用)。 */
export function resetBrowserShim() {
  local._map.clear();
  sync._map.clear();
  session._map.clear();
}

// import 即安裝
installBrowserShim();

export { storage };
