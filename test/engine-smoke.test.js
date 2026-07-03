// Phase 0/1 冒煙測試:驗證 Shinkansen 引擎的純函式能在純 Node(非瀏覽器)環境載入並運作。
//
// 這條驗的訊號層次:
//   ✓ 「引擎對瀏覽器零依賴、可 verbatim 引用」這個整個專案賴以成立的假設
//   ✓ packChunks 分批邏輯(段數/字元雙門檻)行為正確 —— 防漏譯的第一道關卡
//   ✗ 不驗:真實 Gemini 翻譯品質(需 API key,見 translate 整合測試)
//   ✗ 不驗:HTML 切段/回填(Phase 3)
import { describe, it, expect } from 'vitest';
import {
  packChunks,
  buildEffectiveSystemInstruction,
} from '../vendor/shinkansen/shinkansen/lib/system-instruction.js';
import { DEFAULT_FORBIDDEN_TERMS } from '../vendor/shinkansen/shinkansen/lib/storage.js';

describe('引擎在純 Node 可載入', () => {
  it('packChunks 是可呼叫的函式(證明 ESM 引擎無瀏覽器依賴即可 import)', () => {
    expect(typeof packChunks).toBe('function');
    expect(typeof buildEffectiveSystemInstruction).toBe('function');
  });
});

describe('packChunks 分批行為', () => {
  it('依 maxUnits 門檻切批:5 段、每批上限 2 段 → 3 批', () => {
    const texts = ['a', 'b', 'c', 'd', 'e'];
    const batches = packChunks(texts, { maxUnits: 2, maxChars: 10_000 });
    expect(batches).toEqual([
      { start: 0, end: 2, chars: 2 },
      { start: 2, end: 4, chars: 2 },
      { start: 4, end: 5, chars: 1 },
    ]);
  });

  it('依 maxChars 門檻切批:字元預算滿了就換批', () => {
    const texts = ['12345', '67890', 'x']; // 5 + 5 + 1 chars
    const batches = packChunks(texts, { maxUnits: 100, maxChars: 6 });
    // 第一批塞 '12345'(5),再塞 '67890' 會超過 6 → 換批
    expect(batches).toEqual([
      { start: 0, end: 1, chars: 5 },
      { start: 1, end: 3, chars: 6 },
    ]);
  });

  it('超長單段(> maxChars)自成一批,不被丟棄 —— 防漏譯', () => {
    const texts = ['ok', 'x'.repeat(50), 'ok2'];
    const batches = packChunks(texts, { maxUnits: 100, maxChars: 10 });
    // 中間超長段必須獨立成批;所有 index 都要被涵蓋、無遺漏
    const covered = batches.flatMap(b => Array.from({ length: b.end - b.start }, (_, i) => b.start + i));
    expect(covered).toEqual([0, 1, 2]);
    expect(batches.some(b => b.start === 1 && b.end === 2)).toBe(true);
  });

  it('空輸入 → 空批次', () => {
    expect(packChunks([], {})).toEqual([]);
  });
});

describe('禁用詞黑名單(台灣用語核心)', () => {
  it('DEFAULT_FORBIDDEN_TERMS 載入且含關鍵對照(視頻→影片、軟件→軟體)', () => {
    expect(Array.isArray(DEFAULT_FORBIDDEN_TERMS)).toBe(true);
    const map = Object.fromEntries(DEFAULT_FORBIDDEN_TERMS.map(t => [t.forbidden, t.replacement]));
    expect(map['視頻']).toBe('影片');
    expect(map['軟件']).toBe('軟體');
    expect(map['網絡']).toBe('網路');
  });

  it('buildEffectiveSystemInstruction 把禁用詞注入 system prompt', () => {
    const sys = buildEffectiveSystemInstruction(
      '你是翻譯員。',
      ['hello'],
      'hello',
      [],
      [],
      [{ forbidden: '視頻', replacement: '影片' }],
    );
    expect(sys).toContain('視頻');
    expect(sys).toContain('影片');
  });
});
