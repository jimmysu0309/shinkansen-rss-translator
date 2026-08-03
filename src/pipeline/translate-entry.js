// translate-entry.js — 翻譯單篇文章(標題 + 內文)。
//
// 把標題與內文所有段落「合成一批」送翻(省 API 往返、共用 implicit cache),
// 回來再拆分。內文走 html-segmenter,結構/圖片/連結保留。
//
// 訊號層次:
//   ✓ 標題與內文一批翻完;段數進出相等(靠 segmenter 的不變量)
//   ✓ 回傳 usage 供上層記帳(單一資料源)
//   ✗ 不驗:全文抓取(readability)—— 見 full-text(Phase 3b)

import { segmentHtml } from './html-segmenter.js';
import { translateTexts } from '../engine.js';

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

/**
 * @param {{title?:string, contentHtml?:string}} entry
 * @param {object} opts 見 engine.buildGeminiSettings(需 apiKey)
 * @param {function} [opts._translate] 注入用(測試);預設 translateTexts
 * @returns {Promise<{titleTranslated, contentTranslated, usage, hadMismatch}>}
 */
export async function translateEntry(entry, opts = {}) {
  const translate = opts._translate || translateTexts;
  const title = entry.title || '';
  const hasTitle = !!title.trim();

  // Google 翻譯 / OpenCC 是純文字轉換,不吃 ⟦⟧ 佔位符 → 用 textnode 模式;Gemini 用 block+佔位符
  const mode = opts.engine === 'google' || opts.engine === 'opencc' ? 'textnode' : 'placeholder';
  const { texts, reassemble } = segmentHtml(entry.contentHtml || '', { mode });
  const batch = hasTitle ? [title, ...texts] : texts;

  if (batch.length === 0) {
    // 沒東西可翻(空標題 + 空內文)
    return {
      titleTranslated: entry.title ?? null,
      contentTranslated: entry.contentHtml ?? null,
      usage: { ...EMPTY_USAGE },
      hadMismatch: false,
    };
  }

  const { translations, usage, hadMismatch } = await translate(batch, opts);

  let titleTranslated = entry.title ?? null;
  let bodyTranslations = translations;
  if (hasTitle) {
    titleTranslated = translations[0];
    bodyTranslations = translations.slice(1);
  }
  const contentTranslated = reassemble(bodyTranslations);

  return { titleTranslated, contentTranslated, usage, hadMismatch };
}
