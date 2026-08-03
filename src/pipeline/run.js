// run.js — feed 處理編排器。把 fetch → 去重 upsert → 翻譯 pending → 記帳 串起來。
//
// processFeed 的 fetch / translate 都可注入(offline 可測整個編排邏輯)。
//
// 訊號層次:
//   ✓ 編排:抓取 → upsert(去重)→ 只翻 pending → markDone/markError → 記 usage
//   ✓ conditional GET:304 不重抓
//   ✓ 單篇翻譯失敗不影響其他篇(逐篇 try/catch)
//   ✗ 不驗:真實網路 / 真實 Gemini(用注入的 fake;真實走整合測試 / 部署)

import { fetchFeed as defaultFetchFeed } from './fetch-feed.js';
import { translateEntry as defaultTranslateEntry } from './translate-entry.js';
import { fetchFullText as defaultFetchFullText } from './full-text.js';
import {
  DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT, DEFAULT_FORBIDDEN_TERMS, DEFAULT_TARGET_LANGUAGE,
  DEFAULT_MAX_UNITS_PER_BATCH, DEFAULT_MAX_CHARS_PER_BATCH, DEFAULT_TEMPERATURE,
} from '../engine.js';

// 每個 feed 最多保留的文章數預設值(可在設定頁調整;0 = 不限制)
export const DEFAULT_MAX_ENTRIES_PER_FEED = 300;

// 進行中的 feed(id 集合):同一 feed 同時只允許一個 processFeed。
// 沒有這道鎖,排程觸發與手動刷新重疊時會各自讀到同一批 pending → 同批文章翻兩次(重複扣 token)。
const inFlight = new Set();

/** 此 feed 是否正在處理中(供 API 層先擋 409,避免重設狀態後才發現撞鎖) */
export function isFeedInFlight(feedId) { return inFlight.has(feedId); }

/**
 * 由全域 settings + feed 覆寫,組出翻譯一篇文章要用的 opts。
 * feed 欄位優先於全域;全域缺則用引擎預設。
 */
export function buildTranslateOpts(ctx, feed, apiKey) {
  const s = ctx.settings;
  return {
    apiKey,
    engine: feed.engine || s.get('engine', 'gemini'),
    model: feed.model || s.get('model', DEFAULT_MODEL),
    targetLanguage: feed.target_language || s.get('targetLanguage', DEFAULT_TARGET_LANGUAGE),
    systemInstruction: feed.system_prompt || s.get('systemPrompt', DEFAULT_SYSTEM_PROMPT),
    forbiddenTerms: s.get('forbiddenTerms', DEFAULT_FORBIDDEN_TERMS),
    fixedGlossary: s.get('fixedGlossary', []),
    // 批次 / 溫度:從全域 settings 帶入(先前漏傳 → 存的批次設定沒生效)
    maxUnitsPerBatch: s.get('maxUnitsPerBatch', DEFAULT_MAX_UNITS_PER_BATCH),
    maxCharsPerBatch: s.get('maxCharsPerBatch', DEFAULT_MAX_CHARS_PER_BATCH),
    temperature: s.get('temperature', DEFAULT_TEMPERATURE),
  };
}

/**
 * 處理單一 feed。
 * @param {object} ctx createDb() 回傳的 { settings, feeds, entries, usage }
 * @param {object} feed feeds 表的一列
 * @param {object} deps { apiKey, fetchFeed?, translateEntry?, now? }
 * @returns {Promise<{fetched:number, added:number, translated:number, failed:number, notModified:boolean}>}
 */
export async function processFeed(ctx, feed, deps = {}) {
  if (inFlight.has(feed.id)) {
    const err = new Error(`feed ${feed.id} 正在處理中,跳過本次(避免同批文章重複翻譯)`);
    err.code = 'FEED_IN_FLIGHT';
    throw err;
  }
  inFlight.add(feed.id);
  try {
    return await processFeedLocked(ctx, feed, deps);
  } finally {
    inFlight.delete(feed.id);
  }
}

async function processFeedLocked(ctx, feed, deps) {
  const apiKey = deps.apiKey;
  const fetchImpl = deps.fetchFeed || defaultFetchFeed;
  const translateImpl = deps.translateEntry || defaultTranslateEntry;
  const fetchFullTextImpl = deps.fetchFullText || defaultFetchFullText;
  const now = deps.now || (() => Date.now());
  const log = (level, category, message, detail) =>
    ctx.logs?.append({ ts: now(), level, category, message, feedId: feed.id, detail });

  // 1. 抓取(conditional GET)
  let res;
  try {
    res = await fetchImpl(feed.source_url, { etag: feed.etag, lastModified: feed.last_modified });
  } catch (err) {
    ctx.feeds.setFetchMeta(feed.id, { checkedAt: now(), error: String(err).slice(0, 500) });
    log('error', 'fetch', `抓取失敗:${feed.title || feed.source_url}`, String(err?.message || err));
    throw err;
  }
  ctx.feeds.setFetchMeta(feed.id, {
    etag: res.etag, lastModified: res.lastModified, checkedAt: now(), error: null,
  });

  // 2. upsert(依 guid 去重),只有新條目會被建立。
  //    注意:即使 304(未更新)也要往下翻 pending —— 之前失敗 / 未翻的 backlog 必須清掉,
  //    不能因為來源沒新內容就卡住(否則 reset 成 pending 的舊文章永遠補不到)。
  let added = 0;
  if (res.notModified) {
    log('info', 'fetch', `${feed.title || feed.source_url}:未更新(304),檢查待翻 backlog`);
  } else {
    for (const it of res.items) {
      if (!it.guid) continue; // 沒 guid 無法去重,跳過(避免每次重抓都重複)
      const { inserted } = ctx.entries.upsertNew({
        feed_id: feed.id, guid: it.guid, url: it.url, title: it.title, author: it.author,
        content_html: it.contentHtml, published_at: it.published_at,
      }, now());
      if (inserted) added++;
    }
    log('info', 'fetch', `${feed.title || feed.source_url}:抓取 ${res.items.length} 篇,新增 ${added} 篇`);
  }

  // 3. 翻 pending(新條目 + 上次失敗重設的),不論 304 與否都執行
  const opts = buildTranslateOpts(ctx, feed, apiKey);
  const pending = ctx.entries.pendingByFeed(feed.id);
  let translated = 0, failed = 0;
  for (const e of pending) {
    try {
      // 抓取全文(fetch_article):翻譯前先抓整篇正文覆蓋摘要
      let contentHtml = e.content_html;
      if (feed.fetch_article && e.url) {
        try {
          const full = await fetchFullTextImpl(e.url);
          if (full) {
            contentHtml = full;
            ctx.entries.updateContent(e.id, full);
            log('info', 'fetch', `抓取全文:${e.title || '(無標題)'}`);
          } else {
            log('warn', 'fetch', `抓取全文無結果,改用原摘要:${e.title || '(無標題)'}`);
          }
        } catch (err) {
          log('warn', 'fetch', `抓取全文失敗,改用原摘要:${e.title || '(無標題)'}`, String(err?.message || err));
        }
      }
      const r = await translateImpl({ title: e.title, contentHtml }, opts);
      // 段數曾對不上(引擎已自動補救,該段退回原文)→ 留 warn 供追查漏譯
      if (r.hadMismatch) log('warn', 'translate', `譯文段數曾不符,部分段落退回原文:${e.title || '(無標題)'}`);
      ctx.entries.markDone(e.id, {
        titleTranslated: r.titleTranslated,
        contentTranslated: r.contentTranslated,
        tokensIn: r.usage?.inputTokens || 0,
        tokensOut: r.usage?.outputTokens || 0,
        translatedAt: now(),
      });
      const usageModel = { google: 'google-translate', opencc: 'opencc-s2twp' }[opts.engine] || opts.model;
      ctx.usage.log({ ts: now(), feedId: feed.id, entryId: e.id, model: usageModel, usage: r.usage || {} });
      log('info', 'translate', `已翻譯:${e.title || '(無標題)'}`,
        `模型 ${usageModel}｜in ${r.usage?.inputTokens || 0} out ${r.usage?.outputTokens || 0}`);
      translated++;
    } catch (err) {
      ctx.entries.markError(e.id, err);
      log('error', 'translate', `翻譯失敗:${e.title || '(無標題)'}`, String(err?.message || err));
      failed++;
    }
  }

  // 4. 清舊文章:只留最新 N 篇(304 沒新文章,跳過;N=0 不限制)。
  //    保留數取 max(N, 本次抓到篇數):若來源 XML 本身列出超過 N 篇,砍掉的下次抓取
  //    會被當新文章重插 → 重翻 → 再砍,token 無限燒;永不刪「來源還在列的文章」即可斷這個迴圈。
  let pruned = 0;
  const capRaw = deps.maxEntriesPerFeed ?? ctx.settings.get('maxEntriesPerFeed', DEFAULT_MAX_ENTRIES_PER_FEED);
  const cap = Number(capRaw);
  if (!res.notModified && Number.isFinite(cap) && cap > 0) {
    pruned = ctx.entries.pruneByFeed(feed.id, Math.max(cap, res.items.length));
    if (pruned) log('info', 'system', `清理舊文章:${feed.title || feed.source_url} 刪除 ${pruned} 篇(保留最新 ${cap} 篇)`);
  }

  return { fetched: res.items.length, added, translated, failed, pruned, notModified: !!res.notModified };
}

/**
 * 依保留天數清掉舊 log。
 * @param {object} ctx
 * @param {number} retentionDays 保留天數(<=0 視為不清)
 * @param {number} [nowMs] 現在時間(測試可注入)
 * @returns {number} 刪除筆數
 */
export function pruneLogs(ctx, retentionDays, nowMs = Date.now()) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = nowMs - days * 86400_000;
  return ctx.logs.pruneBefore(cutoff);
}

/** 處理所有啟用中的 feed。回傳每個 feed 的結果。 */
export async function processAllFeeds(ctx, deps = {}) {
  const feeds = ctx.feeds.list({ enabledOnly: true });
  const results = [];
  for (const feed of feeds) {
    if (isFeedInFlight(feed.id)) { results.push({ feedId: feed.id, skipped: true }); continue; }
    try {
      results.push({ feedId: feed.id, ...(await processFeed(ctx, feed, deps)) });
    } catch (err) {
      results.push({ feedId: feed.id, error: String(err) });
    }
  }
  return results;
}
