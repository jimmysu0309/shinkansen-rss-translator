// run.js — feed 處理編排器。把 fetch → 去重 upsert → 翻譯 pending → 記帳 串起來。
//
// processFeed 的 fetch / translate 都可注入(offline 可測整個編排邏輯)。
//
// 訊號層次:
//   ✓ 編排:抓取 → upsert(去重)→ 只翻 pending → markDone/markError → 記 usage
//   ✓ conditional GET:304 不重抓
//   ✓ 單篇翻譯失敗不影響其他篇(逐篇 try/catch)
//   ✓ 全文抓取失敗:先用摘要翻出去 → 後續刷新補抓 → 上限 MAX_FULL_TEXT_ATTEMPTS 次後放棄
//   ✓ 花費保險絲:同一篇 24h 內重翻次數上限、每日 token 預算(超過留 pending)
//   ✓ 翻譯失敗:退避後自動重試 → 上限 MAX_TRANSLATE_ATTEMPTS 次後留在 error 等人工
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

// 單篇全文抓取的總嘗試次數上限(第一次 + 之後刷新補抓)。超過就認定該網址抓不到,
// 永久留摘要,不再每輪重抓 —— 否則抓不到的文章會被反覆重抓 + 重譯,燒 token。
export const MAX_FULL_TEXT_ATTEMPTS = 3;

// 翻譯失敗的自動重試。失敗原因多半是暫時性的(Google Translate 429 限流、Gemini 額度 / 逾時、網路),
// 但 error 狀態以前只能手動按「重翻」→ 暫時性失敗變成永久漏譯(2026-09:9to5Mac 38% 文章卡在 429)。
//   - MAX_TRANSLATE_ATTEMPTS:單篇總嘗試次數(第一次 + 自動重試)。用完就留在 error 等人工處理,
//     不無限重試 —— 會吃 token 才失敗的錯誤(如長文逾時)最壞成本 = 單篇成本 × 此值。
//   - TRANSLATE_RETRY_BACKOFF_MS[n-1]:第 n 次失敗後至少隔多久才重試。限流常持續數小時,
//     每 15 分鐘連打只會把額度用完又延長封鎖;拉長間隔,總涵蓋約 17 小時。
//   - MAX_ERROR_RETRIES_PER_RUN:每輪每 feed 最多重試幾篇。積壓的失敗文章一次全打 = 對免費端點
//     的請求爆量,正好觸發限流;分批慢慢消化。
export const MAX_TRANSLATE_ATTEMPTS = 5;
export const TRANSLATE_RETRY_BACKOFF_MS = [10 * 60_000, 60 * 60_000, 4 * 3600_000, 12 * 3600_000];
export const MAX_ERROR_RETRIES_PER_RUN = 3;

// ── 兩道花費保險絲 ──
// 2026-09 事故的教訓:每一次翻譯「單看」都成功,所以 log 零 warn,最後是 Google 端的 spend cap 才停下來。
// 個別 bug 修掉之後,仍需要不依賴「知道 bug 長怎樣」的通用防線:
//   (1) 重翻保險絲:同一篇(feed + guid 或 url)在 RETRANSLATE_WINDOW_MS 內最多成功翻
//       MAX_TRANSLATIONS_PER_ARTICLE 次。正常上限是 2(摘要先翻 + 補抓全文後重翻),第 3 次留作餘裕;
//       再多就是某種迴圈 → 拒翻並記 error。手動「重翻 / 全部重譯」會清帳本,不受限。
//       最壞情況因此是「每篇每 24 小時 3 次」,而不是每 15 分鐘 1 次(96 次 / 天)。
//   (2) 每日 token 預算:過去 24 小時(滾動視窗,免時區問題)input + output token 達設定值就停翻
//       會花 token 的引擎;文章留在 pending(不是 error),視窗空出來自動續翻。0 = 不限制。
export const MAX_TRANSLATIONS_PER_ARTICLE = 3;
export const RETRANSLATE_WINDOW_MS = 24 * 3600_000;
export const DEFAULT_DAILY_TOKEN_BUDGET = 0;
const FREE_ENGINES = new Set(['google', 'opencc']); // 不花 token,不受預算限制

/** 每日 token 預算現況(pipeline 判斷與 API / UI 顯示共用這一份) */
export function getTokenBudgetStatus(ctx, nowMs = Date.now()) {
  const raw = Number(ctx.settings.get('dailyTokenBudget', DEFAULT_DAILY_TOKEN_BUDGET));
  const budget = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const st = ctx.usage.getStats({ from: nowMs - RETRANSLATE_WINDOW_MS });
  const used = (st.input_tokens || 0) + (st.output_tokens || 0);
  return { budget, used, exceeded: budget > 0 && used >= budget };
}

/** 這篇失敗文章的退避時間到了沒(translation_failed_at 為 null = 升級前的舊 error,立即可試) */
export function isTranslateRetryDue(entry, nowMs) {
  if (entry.translation_failed_at == null) return true;
  const i = Math.min(Math.max(entry.translation_retries, 1), TRANSLATE_RETRY_BACKOFF_MS.length) - 1;
  return nowMs - entry.translation_failed_at >= TRANSLATE_RETRY_BACKOFF_MS[i];
}

// 進行中的 feed(id 集合):同一 feed 同時只允許一個 processFeed。
// 沒有這道鎖,排程觸發與手動刷新重疊時會各自讀到同一批 pending → 同批文章翻兩次(重複扣 token)。
const inFlight = new Set();

/** 此 feed 是否正在處理中(供 API 層先擋 409,避免重設狀態後才發現撞鎖) */
export function isFeedInFlight(feedId) { return inFlight.has(feedId); }

// 每個 feed 最近一次處理結果(掛在 ctx 上:同 DB 同一份,測試各自隔離)。
// 背景執行(202)後前端輪詢完成時,靠這個拿到「新增/翻譯/失敗」數字顯示 toast。
function lastRunMap(ctx) { return (ctx._lastRun ??= new Map()); }

/** 最近一次處理結果:{ finishedAt, fetched, added, translated, failed, ... } 或 { finishedAt, error };沒跑過為 null */
export function getLastRun(ctx, feedId) { return lastRunMap(ctx).get(feedId) ?? null; }

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
  const now = deps.now || (() => Date.now());
  try {
    const result = await processFeedLocked(ctx, feed, deps);
    lastRunMap(ctx).set(feed.id, { finishedAt: now(), ...result });
    return result;
  } catch (err) {
    lastRunMap(ctx).set(feed.id, { finishedAt: now(), error: String(err?.message || err) });
    throw err;
  } finally {
    inFlight.delete(feed.id);
  }
}

// 補抓失敗:計數 +1;用完次數就記一筆「放棄」讓 log 看得出來,之後不再補抓。
function giveUpOrRetryLater(ctx, log, entry, err) {
  const { full_text_retries: n } = ctx.entries.bumpFullTextFailure(entry.id);
  const detail = err ? String(err?.message || err) : null;
  if (n >= MAX_FULL_TEXT_ATTEMPTS) {
    log('warn', 'fetch', `補抓全文連續失敗 ${n} 次,放棄改用摘要:${entry.title || '(無標題)'}`, detail);
  } else {
    log('warn', 'fetch', `補抓全文失敗(第 ${n} 次),下次刷新再試:${entry.title || '(無標題)'}`, detail);
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
    err.logged = true; // 已記 log;背景執行的外層 catch 看到此旗標就不重複記
    throw err;
  }
  ctx.feeds.setFetchMeta(feed.id, {
    etag: res.etag, lastModified: res.lastModified, checkedAt: now(), error: null,
  });
  // 標題回填:新增 feed 沒填標題時,首次抓到來源標題就補上(卡片 / RSS 輸出不再顯示裸網址)
  if (!feed.title && res.title) {
    ctx.feeds.update(feed.id, { title: res.title });
    feed = { ...feed, title: res.title }; // 後續 log 用新標題
  }

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
        image_url: it.image_url, content_html: it.contentHtml, published_at: it.published_at,
      }, now());
      if (inserted) added++;
    }
    log('info', 'fetch', `${feed.title || feed.source_url}:抓取 ${res.items.length} 篇,新增 ${added} 篇`);
  }

  // 2.5 補抓上次全文失敗的文章(不論 304 與否都跑)。
  //     抓全文失敗時當下仍用摘要翻譯輸出(讀者不會空等),但那篇會永久停在摘要 —— 這裡在後續
  //     刷新時補抓,成功就覆蓋原文並重設 pending 重譯。累計 MAX_FULL_TEXT_ATTEMPTS 次失敗後放棄,
  //     否則永遠抓不到的網址每 15 分鐘重抓一次沒完沒了。
  const refetched = new Set(); // 本輪已在這裡抓過全文的 entry id → 步驟 3 不再重抓
  if (feed.fetch_article) {
    for (const e of ctx.entries.fullTextRetryable(feed.id, MAX_FULL_TEXT_ATTEMPTS)) {
      try {
        const full = await fetchFullTextImpl(e.url);
        if (full) {
          ctx.entries.updateContent(e.id, full);
          ctx.entries.clearFullTextFailure(e.id);
          ctx.entries.resetToPending(e.id);
          refetched.add(e.id);
          log('info', 'fetch', `補抓全文成功,重新翻譯:${e.title || '(無標題)'}`);
        } else {
          giveUpOrRetryLater(ctx, log, e, null);
        }
      } catch (err) {
        giveUpOrRetryLater(ctx, log, e, err);
      }
    }
  }

  // 2.7 失敗文章自動重試:退避時間已到、次數未滿的 error 重設回 pending,交給步驟 3 一起翻。
  //     用 resetToPending(不歸零失敗次數)—— 歸零是手動「重翻」的語意。
  const dueRetries = ctx.entries.errorRetryCandidates(feed.id, MAX_TRANSLATE_ATTEMPTS)
    .filter((e) => isTranslateRetryDue(e, now()))
    .slice(0, MAX_ERROR_RETRIES_PER_RUN);
  for (const e of dueRetries) ctx.entries.resetToPending(e.id);
  if (dueRetries.length) log('info', 'translate', `自動重試先前翻譯失敗的 ${dueRetries.length} 篇`);

  // 3. 翻 pending(新條目 + 失敗重設的 + 2.5 補抓成功的 + 2.7 自動重試的),不論 304 與否都執行
  const opts = buildTranslateOpts(ctx, feed, apiKey);
  const pending = ctx.entries.pendingByFeed(feed.id);
  let translated = 0, failed = 0, budgetSkipped = 0;
  for (const [idx, e] of pending.entries()) {
    // 保險絲 (2) 每日 token 預算:逐篇檢查(本輪前面幾篇翻完可能剛好用完)。超過就整批停,文章留 pending。
    if (!FREE_ENGINES.has(opts.engine)) {
      const b = getTokenBudgetStatus(ctx, now());
      if (b.exceeded) {
        budgetSkipped = pending.length - idx;
        log('error', 'translate',
          `已達每日 token 預算,暫停翻譯 ${budgetSkipped} 篇(保持待翻,額度恢復後自動續翻):${feed.title || feed.source_url}`,
          `過去 24 小時已用 ${b.used} / 預算 ${b.budget}`);
        break;
      }
    }
    // 保險絲 (1) 重翻:同一篇近期已成功翻過太多次 → 拒翻(在抓全文之前擋,連抓取都省)
    const recent = ctx.ledger.countSince({ feedId: feed.id, guid: e.guid, url: e.url, since: now() - RETRANSLATE_WINDOW_MS });
    if (recent >= MAX_TRANSLATIONS_PER_ARTICLE) {
      const msg = `重翻保險絲:這篇 24 小時內已成功翻譯 ${recent} 次,拒絕再翻(疑似重翻迴圈;確定要翻請按「重翻」)`;
      ctx.entries.markError(e.id, msg, now());
      log('error', 'translate', `${msg}:${e.title || '(無標題)'}`, `guid ${e.guid}`);
      failed++;
      continue;
    }
    // 用量表的 model 欄位:免費引擎記固定字串,Gemini 記實際模型(成功與失敗記帳共用)
    const usageModel = { google: 'google-translate', opencc: 'opencc-s2twp' }[opts.engine] || opts.model;
    try {
      // 抓取全文(fetch_article):翻譯前先抓整篇正文覆蓋摘要
      let contentHtml = e.content_html;
      if (feed.fetch_article && e.url && !refetched.has(e.id)) {
        try {
          const full = await fetchFullTextImpl(e.url);
          if (full) {
            contentHtml = full;
            ctx.entries.updateContent(e.id, full);
            if (e.full_text_retries) ctx.entries.clearFullTextFailure(e.id);
            log('info', 'fetch', `抓取全文:${e.title || '(無標題)'}`);
          } else {
            // 先用摘要翻出去,計數 +1 → 下次刷新由步驟 2.5 補抓
            ctx.entries.bumpFullTextFailure(e.id);
            log('warn', 'fetch', `抓取全文無結果,先用原摘要(下次刷新補抓):${e.title || '(無標題)'}`);
          }
        } catch (err) {
          ctx.entries.bumpFullTextFailure(e.id);
          log('warn', 'fetch', `抓取全文失敗,先用原摘要(下次刷新補抓):${e.title || '(無標題)'}`, String(err?.message || err));
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
      ctx.usage.log({ ts: now(), feedId: feed.id, entryId: e.id, model: usageModel, usage: r.usage || {} });
      ctx.ledger.record({ feedId: feed.id, guid: e.guid, url: e.url, ts: now() });
      log('info', 'translate', `已翻譯:${e.title || '(無標題)'}`,
        `模型 ${usageModel}｜in ${r.usage?.inputTokens || 0} out ${r.usage?.outputTokens || 0}`);
      translated++;
    } catch (err) {
      // 失敗也要記帳:引擎慣例是把「丟錯前已付費的 token」掛在 err.usage(多批中途炸掉的前幾批、
      // 模型拒絕 / 空回應時已算進的 input + thinking token、逐段重翻途中失敗的累計)。不記的話
      // 每日 token 預算與費用統計都會少算,限流迴圈燒掉的錢完全看不到。
      const burned = err?.usage;
      if (burned && ((burned.inputTokens || 0) + (burned.outputTokens || 0)) > 0) {
        ctx.usage.log({ ts: now(), feedId: feed.id, entryId: e.id, model: usageModel, usage: burned });
      }
      const failedEntry = ctx.entries.markError(e.id, err, now());
      const gaveUp = failedEntry.translation_retries >= MAX_TRANSLATE_ATTEMPTS;
      log('error', 'translate',
        `翻譯失敗(第 ${failedEntry.translation_retries} 次,${gaveUp ? '已達上限不再自動重試' : '稍後自動重試'}):${e.title || '(無標題)'}`,
        String(err?.message || err));
      failed++;
    }
  }

  // 4. 清舊文章:只留最新 N 篇(304 沒新文章,跳過;N=0 不限制)。
  //    砍掉「來源還在列的文章」下次抓取會被當新文章重插 → 重翻 → 再砍,token 無限燒。
  //    兩道防線:(a) 保留數取 max(N, 本次抓到篇數) —— 來源 XML 列出超過 N 篇時不超砍;
  //    (b) 本次列出的 guid 明確傳給 prune 保護 —— (a) 只保證「篇數」不保證「是那幾篇」,
  //    精選類 feed 重新列出舊日期文章時,日期排序會把它擠出 keep 之外。
  let pruned = 0;
  // 上限來源優先序:測試注入 → 該 feed 自訂(feeds.max_entries,null = 繼承)→ 全域設定 → 內建預設
  const capRaw = deps.maxEntriesPerFeed ?? feed.max_entries
    ?? ctx.settings.get('maxEntriesPerFeed', DEFAULT_MAX_ENTRIES_PER_FEED);
  const cap = Number(capRaw);
  if (!res.notModified && Number.isFinite(cap) && cap > 0) {
    const listedGuids = res.items.map((it) => it.guid).filter(Boolean);
    pruned = ctx.entries.pruneByFeed(feed.id, Math.max(cap, res.items.length), listedGuids);
    if (pruned) log('info', 'system', `清理舊文章:${feed.title || feed.source_url} 刪除 ${pruned} 篇(保留最新 ${cap} 篇)`);
  }

  return { fetched: res.items.length, added, translated, failed, pruned, budgetSkipped, notModified: !!res.notModified };
}

/**
 * 依保留天數清掉舊 log。
 * @param {object} ctx
 * @param {number} retentionDays 保留天數(<=0 視為不清)
 * @param {number} [nowMs] 現在時間(測試可注入)
 * @returns {number} 刪除筆數
 */
export function pruneLogs(ctx, retentionDays, nowMs = Date.now()) {
  ctx.ledger?.pruneBefore(nowMs - 2 * RETRANSLATE_WINDOW_MS); // 帳本只需涵蓋保險絲視窗;固定留 2 倍,與 log 保留天數無關
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
