// pricing.js — 用 Shinkansen 的計價表把 token 用量換算成美元。
//
// 用 vendor 的 model-pricing.js(單一資料源:模型單價跟著 Shinkansen 更新)。
// Google MT 引擎免費 → 成本 0。
//
// 成本公式(對齊 Shinkansen 慣例):cached token 打折 cachedDiscount。
//   nonCached = input - cached
//   inputCost = (nonCached + cached * (1 - cachedDiscount)) / 1e6 * inputPerMTok
//   outputCost = output / 1e6 * outputPerMTok

import { getPricingForModel, MODEL_PRICING } from '../vendor/shinkansen/shinkansen/lib/model-pricing.js';

export { MODEL_PRICING };

/**
 * @param {string} model
 * @param {{input_tokens?, output_tokens?, cached_tokens?, inputTokens?, outputTokens?, cachedTokens?}} usage
 * @param {object|null} [pricingSettings] { modelPricingOverrides: { [model]: {inputPerMTok, outputPerMTok} } }
 * @returns {number} USD(查無單價回 0)
 */
export function costForUsage(model, usage = {}, pricingSettings = null) {
  const p = getPricingForModel(model, pricingSettings);
  if (!p) return 0;
  const input = usage.input_tokens ?? usage.inputTokens ?? 0;
  const output = usage.output_tokens ?? usage.outputTokens ?? 0;
  const cached = usage.cached_tokens ?? usage.cachedTokens ?? 0;
  const nonCached = Math.max(0, input - cached);
  const inputCost = (nonCached + cached * (1 - p.cachedDiscount)) / 1e6 * p.inputPerMTok;
  const outputCost = output / 1e6 * p.outputPerMTok;
  return inputCost + outputCost;
}

/** 格式化美元(小額顯示到 4 位)。 */
export function formatUsd(n) {
  n = Number(n) || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 1) return '$' + n.toFixed(3);
  return '$' + n.toFixed(2);
}
