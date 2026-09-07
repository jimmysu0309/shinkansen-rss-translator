// version.js — 版本號單一資料源 = package.json。
// web/server.js(前端顯示)與抓取 user-agent 字串共用,避免各處寫死版本 drift。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
).version;

// 抓取用 User-Agent(feed 與全文抓取共用,單一資料源)。
// 2026-09-07:Autocar(CloudFront + AWS WAF)對純自訂 UA 一律回 202 挑戰頁(空 body,
// x-amzn-waf-action: challenge),下游才報「Unable to parse XML」。實測帶 Mozilla/5.0 前綴的
// 慣例爬蟲格式(同 Googlebot 寫法)即放行,且仍誠實標示本程式身分,不假冒瀏覽器。
export const USER_AGENT = `Mozilla/5.0 (compatible; Shinkansen-Feed/${APP_VERSION}; +RSS translator)`;
