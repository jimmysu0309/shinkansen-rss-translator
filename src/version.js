// version.js — 版本號單一資料源 = package.json。
// web/server.js(前端顯示)與抓取 user-agent 字串共用,避免各處寫死版本 drift。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
).version;
