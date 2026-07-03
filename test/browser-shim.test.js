// browser-shim 適配層測試(離線)。
//
// 這條驗的訊號層次:
//   ✓ 記憶體版 chrome.storage 的 get/set/remove/clear round-trip 正確
//   ✓ chrome.storage.get 的多型(string / array / object-with-default / null)符合 chrome 語意
//   ✓ onChanged listener 會在寫入時觸發
//   ✗ 不驗:持久化(shim 本就不持久化,Phase 2 SQLite 才接管)
import { describe, it, expect, beforeEach } from 'vitest';
import { storage, resetBrowserShim } from '../src/engine-adapters/browser-shim.js';

beforeEach(() => resetBrowserShim());

describe('browser-shim: chrome.storage 記憶體實作', () => {
  it('set 後 get 讀得到(round-trip)', async () => {
    await storage.local.set({ apiKey: 'AQ.test', model: 'gemini-2.5-flash' });
    expect(await storage.local.get('apiKey')).toEqual({ apiKey: 'AQ.test' });
    expect(await storage.local.get(['apiKey', 'model'])).toEqual({
      apiKey: 'AQ.test',
      model: 'gemini-2.5-flash',
    });
  });

  it('get(不存在的鍵) → 空物件;get({鍵:預設}) → 回預設', async () => {
    expect(await storage.local.get('nope')).toEqual({});
    expect(await storage.local.get({ nope: 'fallback' })).toEqual({ nope: 'fallback' });
  });

  it('get(null) → 回全部', async () => {
    await storage.local.set({ a: 1, b: 2 });
    expect(await storage.local.get(null)).toEqual({ a: 1, b: 2 });
  });

  it('remove / clear 生效', async () => {
    await storage.local.set({ a: 1, b: 2 });
    await storage.local.remove('a');
    expect(await storage.local.get(null)).toEqual({ b: 2 });
    await storage.local.clear();
    expect(await storage.local.get(null)).toEqual({});
  });

  it('local 與 sync 是獨立命名空間', async () => {
    await storage.local.set({ x: 'local' });
    await storage.sync.set({ x: 'sync' });
    expect(await storage.local.get('x')).toEqual({ x: 'local' });
    expect(await storage.sync.get('x')).toEqual({ x: 'sync' });
  });

  it('onChanged listener 在寫入時觸發,帶 changes 與 areaName', async () => {
    const seen = [];
    storage.onChanged.addListener((changes, area) => seen.push({ changes, area }));
    await storage.local.set({ k: 'v' });
    expect(seen).toHaveLength(1);
    expect(seen[0].area).toBe('local');
    expect(seen[0].changes.k.newValue).toBe('v');
  });
});
