// email-web-url.js — 從 email 電子報的 HTML 找出「這一期在網站上的原文網址」。
//
// 為什麼需要:LetterFeed 把 email 轉成的 Atom entry 沒有 <link>(上游 issue #19),
// 下游只能拿到合成的內網網址(entryLink 的「來源 feed + #guid」),在 Miniflux 按 v
// 開原文會開到 letterfeed-backend 這種瀏覽器連不到的主機。能從信件內容認出原文網址的,
// 就用真的網址。
//
// 目前認得的格式:
//   Substack —— 信裡的 CTA 連結是 `https://substack.com/redirect/2/<payload>.<簽章>`,
//   payload 是 base64url 的 JSON,`e` 欄就是目的網址。Substack 自己的 CTA 會帶
//   `utm_campaign=email-*`(email-subscribe / email-half-post / email-checkout …),
//   目的網址要嘛本身就是 `/p/<slug>`,要嘛是 subscribe 頁、`next=` 參數指回 `/p/<slug>`。
//   只看 `email-*` 這組,內文裡作者引用別篇文章的連結(走 redirect/<uuid>,或 campaign 不同)不會被誤認。
//   輸出一律只留 origin + /p/<slug>,丟掉整串 query —— 那裡面有訂閱者個人 token,不能外流。
//
// 訊號層次:
//   ✓ Substack 免費名單(只有 subscribe?next=)與付費名單(有 /p/ 直連)兩種信都解得出來
//   ✓ 輸出不帶 query / token
//   ✗ 不驗:Mailchimp 等其他平台(Benedict's Newsletter 信裡沒有網頁版連結,
//     Mailchimp 封存頁也沒開,實查過 2026-10-26)—— 認不得就回 null,由呼叫端退回合成網址

const REDIRECT_RE = /https:\/\/substack\.com\/redirect\/2\/([A-Za-z0-9_-]+)\./g;
const POST_PATH_RE = /^\/p\/[^/]+\/?$/;

/**
 * @param {string|null|undefined} html email 原文 HTML
 * @returns {string|null} 原文網址;認不得回 null
 */
export function emailWebUrl(html) {
  if (!html || typeof html !== 'string') return null;
  for (const m of html.matchAll(REDIRECT_RE)) {
    const target = decodePayloadTarget(m[1]);
    if (!target) continue;
    if (!/^email-/.test(target.searchParams.get('utm_campaign') || '')) continue;
    const post = postUrl(target) || postUrl(safeUrl(target.searchParams.get('next')));
    if (post) return post;
  }
  return null;
}

function decodePayloadTarget(b64) {
  try {
    const json = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return safeUrl(json && json.e);
  } catch {
    return null;
  }
}

function safeUrl(s) {
  if (!s || typeof s !== 'string') return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

function postUrl(u) {
  if (!u || !POST_PATH_RE.test(u.pathname)) return null;
  return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
}
