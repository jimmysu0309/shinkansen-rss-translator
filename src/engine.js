// engine.js — Shinkansen 翻譯引擎在 Node 的封裝入口。
//
// 職責:
//   1. 先安裝 browser-shim(import 順序在引擎之前),讓引擎的 chrome.storage 呼叫在 Node 不炸。
//   2. 提供 buildGeminiSettings():把易讀的選項組成引擎 translateBatch 期望的 settings 形狀(純函式,可離線測)。
//   3. 提供 translateTexts():餵字串陣列 → 回譯文陣列,薄封裝 translateBatch。
//
// 鐵律:vendor 引擎邏輯不改;這裡只做「餵料 + 預設值」。
//
// ⚠️ import 順序關鍵:browser-shim 必須在引擎相關 import 之前,先把 globalThis.chrome 裝好。
import './engine-adapters/browser-shim.js';

import { translateBatch } from '../vendor/shinkansen/shinkansen/lib/gemini.js';
import { translateGoogleBatch } from '../vendor/shinkansen/shinkansen/lib/google-translate.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_FORBIDDEN_TERMS,
  isPromptUnchangedFromDefault,
} from '../vendor/shinkansen/shinkansen/lib/storage.js';
import {
  DEFAULT_CHARS_PER_BATCH,
} from '../vendor/shinkansen/shinkansen/lib/constants.js';

export { DEFAULT_SYSTEM_PROMPT, DEFAULT_FORBIDDEN_TERMS, isPromptUnchangedFromDefault };

// 預設模型 = gemini-3.1-flash-lite(對應現有 rssbox 的 Lite profile,便宜、品質夠)。
// 引擎的 pickThinkingConfig 是為 gemini-3 系列的 thinkingLevel API 設計,故用 gemini-3;
// 舊模型(gemini-2.5)不吃 thinkingLevel 會回「Thinking level is not supported」。
// 正式模型選擇(Lite / Flash=gemini-3-flash-preview)由 Phase 5 web 介面逐 feed 設定。
export const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
export const DEFAULT_TARGET_LANGUAGE = 'zh-TW';
// 每批段數上限預設 50(feed 文章通常多段,調高可減少 API 往返;vendor 內建值為 20)。
export const DEFAULT_MAX_UNITS_PER_BATCH = 50;
export const DEFAULT_MAX_CHARS_PER_BATCH = DEFAULT_CHARS_PER_BATCH;
export const DEFAULT_TEMPERATURE = 1;

// 支援的翻譯引擎(前端下拉用)
export const ENGINES = [
  { id: 'gemini', label: 'Gemini（AI 翻譯，品質最佳，需 API key）' },
  { id: 'google', label: 'Google 翻譯（免費、快，不需 key、品質普通）' },
];

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

/**
 * 把易讀選項組成 Gemini 引擎 translateBatch 期望的 settings 物件。純函式,不打 API,可離線測。
 * 註:service tier 一律 'DEFAULT'(不送該欄位),不再開放設定。
 *
 * @param {object} opts
 * @param {string} opts.apiKey           Gemini API key(必填)
 * @param {string} [opts.model]          模型 id
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxOutputTokens]
 * @param {string} [opts.systemInstruction] 基礎 system prompt(預設台灣繁中 prompt)
 * @param {number} [opts.maxUnitsPerBatch]  每批段數上限
 * @param {number} [opts.maxCharsPerBatch]  每批字元上限
 * @param {number} [opts.maxRetries]        網路錯誤重試次數
 * @returns {object} settings(給 translateBatch)
 */
export function buildGeminiSettings(opts = {}) {
  if (!opts.apiKey) throw new Error('buildGeminiSettings: apiKey 必填');
  return {
    apiKey: opts.apiKey,
    geminiConfig: {
      model: opts.model || DEFAULT_MODEL,
      serviceTier: 'DEFAULT', // 固定不送 service tier
      temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
      topP: opts.topP,
      topK: opts.topK,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
      systemInstruction: opts.systemInstruction || DEFAULT_SYSTEM_PROMPT,
    },
    maxUnitsPerBatch: opts.maxUnitsPerBatch ?? DEFAULT_MAX_UNITS_PER_BATCH,
    maxCharsPerBatch: opts.maxCharsPerBatch ?? DEFAULT_MAX_CHARS_PER_BATCH,
    maxRetries: opts.maxRetries ?? 3,
  };
}

/**
 * 翻譯一組文字段落。依 opts.engine 分派到 Gemini 或 Google 翻譯。
 * 回傳形狀統一:{ translations, usage, hadMismatch }。
 *   - gemini:usage 帶真實 token 數
 *   - google:免費,usage token 皆 0,附 chars 供參考
 *
 * @param {string[]} texts
 * @param {object} opts  engine('gemini'|'google')、targetLanguage、及 buildGeminiSettings 各欄位
 * @returns {Promise<{translations:string[], usage:object, hadMismatch:boolean}>}
 */
export async function translateTexts(texts, opts = {}) {
  const engine = opts.engine || 'gemini';

  if (engine === 'google') {
    const target = opts.targetLanguage || DEFAULT_TARGET_LANGUAGE;
    const { translations, chars } = await translateGoogleBatch(texts, target);
    return { translations, usage: { ...EMPTY_USAGE, chars }, hadMismatch: false };
  }

  // 預設:Gemini
  const settings = buildGeminiSettings(opts);
  const glossary = []; // 自動擷取術語表:尚未啟用
  const fixedGlossary = opts.fixedGlossary || [];
  const forbiddenTerms = opts.forbiddenTerms || DEFAULT_FORBIDDEN_TERMS;
  return translateBatch(texts, settings, glossary, fixedGlossary, forbiddenTerms);
}
