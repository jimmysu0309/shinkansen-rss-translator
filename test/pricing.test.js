// pricing 測試(離線)。
//
// 訊號層次:
//   ✓ 已知模型的成本換算(對齊 vendor model-pricing 單價)
//   ✓ cached token 打折
//   ✓ 查無單價 / Google 引擎 → 0
//   ✗ 不驗:單價本身是否最新(那由 vendor model-pricing 維護)
import { describe, it, expect } from 'vitest';
import { costForUsage, formatUsd, MODEL_PRICING, EXTRA_MODEL_PRICING } from '../src/pricing.js';

describe('costForUsage', () => {
  it('gemini-3.1-flash-lite:input 0.25 / output 1.50 per Mtok', () => {
    // 1M input + 1M output = 0.25 + 1.50 = 1.75
    const c = costForUsage('gemini-3.1-flash-lite', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(c).toBeCloseTo(1.75, 6);
  });

  it('cached token 打折(cachedDiscount 0.90 → cached 只算 10%)', () => {
    // input 1M 全 cached:(0 + 1M*0.1)/1M*0.25 = 0.025
    const c = costForUsage('gemini-3.1-flash-lite', { input_tokens: 1_000_000, cached_tokens: 1_000_000, output_tokens: 0 });
    expect(c).toBeCloseTo(0.025, 6);
  });

  it('支援 camelCase usage 形狀', () => {
    const c = costForUsage('gemini-3.1-flash-lite', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(c).toBeCloseTo(0.25, 6);
  });

  it('未知模型 / Google 引擎 → 0', () => {
    expect(costForUsage('google-translate', { input_tokens: 999 })).toBe(0);
    expect(costForUsage('unknown-model', { output_tokens: 999 })).toBe(0);
    expect(costForUsage(null, {})).toBe(0);
  });

  it('gemini-3.6-flash(vendor v2.0.64 起收錄):1.50/7.50', () => {
    const c = costForUsage('gemini-3.6-flash', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(c).toBeCloseTo(9.0, 6);
  });

  it('gemini-3.5-flash-lite:0.30/2.50,官方無 context caching → cached 不打折', () => {
    const c = costForUsage('gemini-3.5-flash-lite', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(c).toBeCloseTo(2.8, 6);
    // cachedDiscount 0:全 cached 也照全價 0.30 計,不虛報折扣
    const cached = costForUsage('gemini-3.5-flash-lite', { input_tokens: 1_000_000, cached_tokens: 1_000_000 });
    expect(cached).toBeCloseTo(0.30, 6);
  });

  it('gemini-3.5-flash(vendor 已下架)保留歷史計價:1.50/9.00,舊用量紀錄費用不歸零', () => {
    const c = costForUsage('gemini-3.5-flash', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(c).toBeCloseTo(10.5, 6);
  });

  it('本地補充模型也吃計價覆蓋', () => {
    const ps = { modelPricingOverrides: { 'gemini-3.5-flash': { inputPerMTok: 1, outputPerMTok: 2 } } };
    const c = costForUsage('gemini-3.5-flash', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, ps);
    expect(c).toBeCloseTo(3, 6);
  });

  it('MODEL_PRICING 合併 vendor + 本地:兩邊的模型都在(前端計價面板用同一份)', () => {
    expect(MODEL_PRICING['gemini-3.1-flash-lite']).toBeTruthy();  // vendor
    for (const id of Object.keys(EXTRA_MODEL_PRICING)) expect(MODEL_PRICING[id]).toBeTruthy(); // 本地
  });

  it('計價覆蓋:自訂單價優先於內建', () => {
    const ps = { modelPricingOverrides: { 'gemini-3.1-flash-lite': { inputPerMTok: 10, outputPerMTok: 20 } } };
    // 1M input + 1M output = 10 + 20 = 30
    const c = costForUsage('gemini-3.1-flash-lite', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, ps);
    expect(c).toBeCloseTo(30, 6);
  });
});

describe('formatUsd', () => {
  it('0 → $0;小額顯示到 4 位', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.0001234)).toBe('$0.0001');
    expect(formatUsd(0.123)).toBe('$0.123');
    expect(formatUsd(1.5)).toBe('$1.50');
  });
});
