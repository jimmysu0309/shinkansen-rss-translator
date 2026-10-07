// engine 封裝測試。
//
// 訊號層次:
//   ✓ 離線:buildGeminiSettings 把選項組成引擎期望的 settings 形狀(預設值、必填檢查)
//   ✓ 離線:引擎能在純 Node 載入(import 不炸 = shim 生效)
//   ✓ 整合(gate 在 GEMINI_API_KEY):真打 Gemini 翻一段 → 段數進出相等、譯文非空且為中文
//   ✓ 離線:engine:google 路徑用 mock fetch 餵 Google 固定回應格式 → 適配層接 vendor 正確(譯文、token 0、chars、段數)
//   ✓ live(gate 在 LIVE_GOOGLE=1,`npm run test:live`):真打 Google 非官方端點 → 端點格式沒變
//     不放進 npm test:Google 對家用 IP 間歇 429,跟程式碼無關,不該卡發版 gate
//   ✗ 不驗:HTML 切段回填(Phase 3)、OpenAI-compat 引擎
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildGeminiSettings,
  translateTexts,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_FORBIDDEN_TERMS,
  DEFAULT_FETCH_TIMEOUT_MS,
} from '../src/engine.js';

describe('buildGeminiSettings(離線)', () => {
  it('apiKey 必填,缺則丟錯', () => {
    expect(() => buildGeminiSettings({})).toThrow(/apiKey/);
  });

  it('組出引擎期望的 settings 形狀 + 預設值(段數預設 50、溫度 1、不送 tier)', () => {
    const s = buildGeminiSettings({ apiKey: 'AQ.test' });
    expect(s.apiKey).toBe('AQ.test');
    expect(s.geminiConfig.model).toBe(DEFAULT_MODEL);
    expect(s.geminiConfig.serviceTier).toBe('DEFAULT');
    expect(s.geminiConfig.systemInstruction).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(s.geminiConfig.temperature).toBe(1); // 新預設
    expect(s.maxUnitsPerBatch).toBe(50); // 新預設
    expect(typeof s.maxCharsPerBatch).toBe('number');
    expect(s.maxRetries).toBe(3);
  });

  it('選項可覆寫預設(含溫度)', () => {
    const s = buildGeminiSettings({
      apiKey: 'AQ.test',
      model: 'gemini-3-flash-preview',
      maxUnitsPerBatch: 10,
      temperature: 0.7,
      systemInstruction: 'custom',
    });
    expect(s.geminiConfig.model).toBe('gemini-3-flash-preview');
    expect(s.maxUnitsPerBatch).toBe(10);
    expect(s.geminiConfig.temperature).toBe(0.7);
    expect(s.geminiConfig.systemInstruction).toBe('custom');
  });

  it('單次請求逾時預設 60s 且可覆寫(vendor 預設 15s 對長批次不夠)', () => {
    // 驗的是 settings 形狀:fetchTimeoutMs 必須進 geminiConfig,vendor fetchWithRetry
    // 才吃得到;沒驗 vendor 實際套用逾時(那層屬 vendor,鐵律不改不測)。
    const s = buildGeminiSettings({ apiKey: 'AQ.test' });
    expect(s.geminiConfig.fetchTimeoutMs).toBe(DEFAULT_FETCH_TIMEOUT_MS);
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(60_000);
    const custom = buildGeminiSettings({ apiKey: 'AQ.test', fetchTimeoutMs: 120_000 });
    expect(custom.geminiConfig.fetchTimeoutMs).toBe(120_000);
  });

  it('預設禁用詞黑名單載入(台灣繁中核心)', () => {
    const map = Object.fromEntries(DEFAULT_FORBIDDEN_TERMS.map(t => [t.forbidden, t.replacement]));
    expect(map['視頻']).toBe('影片');
  });
});

// ─── 整合測試:真打 Gemini,只有設了 GEMINI_API_KEY 才跑 ───
// 未設 key 時 skip,不讓沒 key 的環境(CI)因此紅燈。
const apiKey = process.env.GEMINI_API_KEY;
const liveIt = apiKey ? it : it.skip;

describe('translateTexts 整合(需 GEMINI_API_KEY)', () => {
  liveIt('翻譯單段英文 → 非空中文譯文', async () => {
    const { translations } = await translateTexts(['Hello, world.'], { apiKey });
    expect(translations).toHaveLength(1);
    expect(translations[0]).toBeTruthy();
    // 含至少一個 CJK 字元
    expect(translations[0]).toMatch(/[一-鿿]/);
  }, 30_000);

  liveIt('多段翻譯:段數進出相等(防漏譯核心不變量)', async () => {
    const input = [
      'The quick brown fox jumps over the lazy dog.',
      'Artificial intelligence is transforming software development.',
      'Taiwan is an island in East Asia.',
    ];
    const { translations, hadMismatch } = await translateTexts(input, { apiKey });
    expect(translations).toHaveLength(input.length);
    translations.forEach(t => expect(t).toMatch(/[一-鿿]/));
    expect(hadMismatch).toBe(false);
  }, 30_000);

  liveIt('禁用詞生效:「software」不會被翻成「軟件」', async () => {
    const { translations } = await translateTexts(
      ['This software has excellent video quality.'],
      { apiKey },
    );
    // 台灣用語:軟體 / 影片 / 品質,不該出現軟件 / 視頻 / 質量
    expect(translations[0]).not.toMatch(/軟件|視頻|質量/);
  }, 30_000);
});

// Google 翻譯引擎(免費,不需 key)。
// 離線層:把 global fetch 換成回傳 Google 端點的固定回應格式 [[[譯文, 原文], ...]],
// 驗的是「engine.js 把 engine:google 接到 vendor translateGoogleBatch 的方式正確」。
// vendor 會把多段用 SEP 串成一個請求,mock 直接把 q 參數原樣回傳、換成對應中文,保住段數。
describe('Google 翻譯引擎(離線 mock fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const CANNED = { 'Hello, world.': '你好,世界。', 'Good morning.': '早安。' };

  function mockGoogleFetch() {
    return vi.fn(async (url) => {
      const u = new URL(url);
      expect(u.hostname).toBe('translate.googleapis.com');
      expect(u.searchParams.get('tl')).toBeTruthy();
      // q 是整組用 SEP 串起來的原文;逐段換成罐頭中文,SEP 原樣保留
      const q = u.searchParams.get('q');
      const SEP = '\n\u2063\u2063\u2063\n'; // 與 vendor google-translate.js 的 SEP 相同
      const translated = q.split(SEP).map(seg => CANNED[seg] ?? seg).join(SEP);
      return { ok: true, status: 200, json: async () => [[[translated, q]]] };
    });
  }

  it('engine:google → 中文譯文,usage token 皆 0、附 chars,fetch 打 Google 端點', async () => {
    const fetchMock = mockGoogleFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { translations, usage, hadMismatch } = await translateTexts(['Hello, world.'], { engine: 'google' });
    expect(translations).toEqual(['你好,世界。']);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.chars).toBeGreaterThan(0);
    expect(hadMismatch).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('多段:段數進出相等', async () => {
    vi.stubGlobal('fetch', mockGoogleFetch());
    const input = ['Hello, world.', 'Good morning.'];
    const { translations } = await translateTexts(input, { engine: 'google' });
    expect(translations).toHaveLength(input.length);
    translations.forEach(t => expect(t).toMatch(/[一-鿿]/));
  });

  it('端點回非 2xx → 丟出含狀態碼的錯誤(不靜默退回原文)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => null })));
    await expect(translateTexts(['Hello, world.'], { engine: 'google' })).rejects.toThrow(/429/);
  });
});

// live 層:真打 Google 非官方端點,只驗「端點回應格式沒變」。gate 在 LIVE_GOOGLE=1(`npm run test:live`),
// 不跟 GEMINI_API_KEY 綁:家用 IP 會被 Google 間歇 429,不能讓它卡 npm test / 發版 gate。
const liveGoogleIt = process.env.LIVE_GOOGLE ? it : it.skip;
describe('Google 翻譯引擎(live,需 LIVE_GOOGLE=1)', () => {
  liveGoogleIt('engine:google → 中文譯文,usage token 皆 0、附 chars', async () => {
    const { translations, usage } = await translateTexts(['Hello, world.'], { engine: 'google' });
    expect(translations).toHaveLength(1);
    expect(translations[0]).toMatch(/[一-鿿]/);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.chars).toBeGreaterThan(0);
  }, 30_000);
});

// OpenCC 簡轉繁引擎:本機字典轉換,完全離線、確定性 → 不需任何 gate。
// 驗:轉換正確(含台灣慣用詞)、段數進出相等、usage token 皆 0。
// 不驗:HTML 切段回填(見 pipeline.test.js 的 translateEntry 離線整合)。
describe('OpenCC 簡轉繁引擎(離線)', () => {
  it('engine:opencc → s2twp 轉換(繁體 + 台灣詞),usage token 皆 0', async () => {
    const { translations, usage, hadMismatch } = await translateTexts(
      ['软件优化网络', '云计算和视频数据'],
      { engine: 'opencc' },
    );
    expect(translations).toEqual(['軟體最佳化網路', '雲端計算和影片資料']);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.chars).toBeGreaterThan(0);
    expect(hadMismatch).toBe(false);
  });

  it('段數進出相等,空字串/繁體/英文原樣通過', async () => {
    const input = ['', '已經是繁體', 'English only', '简体字'];
    const { translations } = await translateTexts(input, { engine: 'opencc' });
    expect(translations).toHaveLength(input.length);
    expect(translations[0]).toBe('');
    expect(translations[1]).toBe('已經是繁體');
    expect(translations[2]).toBe('English only');
    expect(translations[3]).toBe('簡體字');
  });

  it('不需 API key(缺 apiKey 不會 throw)', async () => {
    const { translations } = await translateTexts(['测试'], { engine: 'opencc' });
    expect(translations).toEqual(['測試']);
  });
});
