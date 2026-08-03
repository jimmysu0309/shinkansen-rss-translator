// pricing.js — 用 Shinkansen 的計價表把 token 用量換算成美元。
//
// 用 vendor 的 model-pricing.js(單一資料源:模型單價跟著 Shinkansen 更新)。
// Google MT 引擎免費 → 成本 0。
//
// 成本公式(對齊 Shinkansen 慣例):cached token 打折 cachedDiscount。
//   nonCached = input - cached
//   inputCost = (nonCached + cached * (1 - cachedDiscount)) / 1e6 * inputPerMTok
//   outputCost = output / 1e6 * outputPerMTok

import {
  getPricingForModel, MODEL_PRICING as VENDOR_MODEL_PRICING, DEFAULT_GEMINI_CACHED_DISCOUNT,
} from '../vendor/shinkansen/shinkansen/lib/model-pricing.js';

// vendor 計價表(2026-07 校準)之外的本地補充,不動 vendor 檔(鐵律 §2)。
// 3.5-flash-lite / 3.6-flash 已由 vendor v2.0.64 收錄,本地 entry 已刪(vendor 為準)。
// gemini-3.5-flash:vendor 已下架,但本專案的費用是「讀取時查表重算」(非上游的寫入時定價),
// 歷史 usage 紀錄若有此模型,沒有這條會歸零 → 保留末代單價。
export const EXTRA_MODEL_PRICING = {
  'gemini-3.5-flash': { inputPerMTok: 1.50, outputPerMTok: 9.00, cachedDiscount: DEFAULT_GEMINI_CACHED_DISCOUNT },
};

// 對外的完整計價表(前端計價面板 / 費用計算共用同一份)
export const MODEL_PRICING = { ...VENDOR_MODEL_PRICING, ...EXTRA_MODEL_PRICING };

// 查單價:先走 vendor(含使用者 override 的逐欄 fallback);vendor 查無內建才補查本地表。
// override 有填 input+output 時 vendor 路徑已涵蓋(不需內建 entry),
// 走到本地表時只需再套 override 的 cachedDiscount。
function pricingFor(model, settings) {
  const p = getPricingForModel(model, settings);
  if (p) return p;
  const extra = EXTRA_MODEL_PRICING[model];
  if (!extra) return null;
  const oDisc = Number(settings?.modelPricingOverrides?.[model]?.cachedDiscount);
  return {
    ...extra,
    cachedDiscount: (Number.isFinite(oDisc) && oDisc >= 0 && oDisc <= 1) ? oDisc : extra.cachedDiscount,
  };
}

/**
 * @param {string} model
 * @param {{input_tokens?, output_tokens?, cached_tokens?, inputTokens?, outputTokens?, cachedTokens?}} usage
 * @param {object|null} [pricingSettings] { modelPricingOverrides: { [model]: {inputPerMTok, outputPerMTok} } }
 * @returns {number} USD(查無單價回 0)
 */
export function costForUsage(model, usage = {}, pricingSettings = null) {
  const p = pricingFor(model, pricingSettings);
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
