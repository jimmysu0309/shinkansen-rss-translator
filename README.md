# 🚄 Shinkansen RSS Translator

把任何 RSS/Atom feed **翻成道地台灣繁體中文**,再輸出成新的 feed 給你的閱讀器（Miniflux、Readwise Reader…）訂閱。

翻譯引擎直接沿用瀏覽器擴充功能 **[Shinkansen](https://github.com/jimmysu0309/shinkansen)** 的 `lib/`（以 git submodule 釘版本引用，不改一行邏輯），因此享有它調校過的台灣繁中 prompt、禁用詞黑名單、抗漏譯的分段對映與 token 計價。外面包一層 Node 伺服器負責抓取、去重、排程、輸出與 web 介面。

---

## 為什麼做這個

自架的 RSS 翻譯方案（如 rssbox / RSS Translator）常有兩個痛點：

1. **翻譯品質難控、常漏譯** — 根因多在切段 / segment 對映的實作，把好 prompt 貼進去也救不了。
2. **用量難追蹤** — 沒有像樣的 token / 費用紀錄。

本專案用 Shinkansen 證明過的引擎（`translateBatch` 帶序號標記 + retry + 段數對映）從源頭解決漏譯，並內建用量與費用統計。此外，**只替換文字節點、不動元素**，所以圖片、連結、粗體等 HTML 結構 100% 保留。

## 功能特色

- **雙引擎**：Gemini（AI 翻譯、品質最佳、需 API 金鑰）＋ Google 翻譯（免費、快、不需金鑰）。可全域或逐 feed 選。
- **道地台灣繁中**：內建 Shinkansen 的系統 prompt ＋ 25 條中國用語黑名單（視頻→影片、軟件→軟體…），可在介面編輯。
- **防漏譯**：段數進出相等的不變量 ＋ 序號標記；結構、圖片、連結保留。
- **web 介面**：新增 / 管理 feed、全域設定、用量儀表板、翻譯紀錄，全部在瀏覽器完成。
- **OPML 匯入 / 匯出**：批次搬入來源、批次輸出譯後 feed 給 Miniflux 訂閱。
- **用量統計**：費用（USD，可自訂各模型單價）、token、快取命中率、每日費用圖、逐 feed 與逐筆明細、CSV 匯出、一鍵清除。
- **翻譯紀錄（Log）**：抓取 / 翻譯 / 錯誤事件紀錄，可依等級 / 類別過濾、CSV 匯出、設定保留天數（預設 7 天）、一鍵清除。
- **排程**：cron 定期自動處理所有啟用中的 feed。
- **conditional GET**：etag / last-modified，未更新不重抓。

## 架構

```
 RSS 來源 ──▶ 抓取(etag)──▶ 去重(GUID)──▶ HTML 切段 ──▶ 翻譯引擎 ──▶ 回填 ──▶ SQLite
                                                    │(Shinkansen lib/,submodule)   │
                                                    └─ 記 token 用量 ──────────────┤
                                                                                   ▼
                                          Miniflux ◀── /rss/<id> Atom 輸出 ◀──── web 伺服器 + 介面
```

- 語言 / 執行環境：Node 20+（ESM）
- Web：Fastify　｜　DB：better-sqlite3（單檔）　｜　全文抽取：linkedom　｜　排程：node-cron
- 翻譯引擎：`vendor/shinkansen/shinkansen/lib/`（git submodule，釘 commit）

## 目錄結構

```
src/
  engine.js            引擎封裝(去瀏覽器化 + 餵料 + 引擎分派)
  engine-adapters/     browser-shim(Node 版 chrome.storage 相容層)
  pipeline/            抓取 / 切段回填 / 單篇翻譯 / 編排 / RSS 輸出 / OPML
  db/                  SQLite schema + DAO(settings/feeds/entries/usage/logs)
  web/                 Fastify server + public/(單頁分頁式介面)
  server.js            進入點(開 DB、載 .env、排程、listen)
vendor/shinkansen/     Shinkansen 引擎(git submodule)
test/                  vitest(112 tests)
```

---

## 快速開始（本機）

需求：Node 20+、git。

```bash
# 1. 取得程式碼(含 submodule 引擎)
git clone --recurse-submodules <repo-url> shinkansen-rss
cd shinkansen-rss
# 若已 clone 但沒帶 submodule:
git submodule update --init

# 2. 安裝依賴
npm install

# 3. 基礎設定(可選)
cp .env.example .env      # 只設 PORT / 初始更新頻率;金鑰在 web 介面填

# 4. 啟動
npm start
#   → http://localhost:8088
```

打開瀏覽器到 `http://localhost:8088`，先到「設定」分頁填入 **Gemini API 金鑰**(按「測試」驗證),再到「Feeds」分頁貼 RSS 網址新增、刷新即開始翻譯。用免費 Google 翻譯引擎則不需金鑰。

跑測試：

```bash
npm test          # 112 tests;有設 GEMINI_API_KEY 才會跑真打 API 的整合測試
```

---

## 部署指南（Docker）

### A. 一般 Docker 主機

```bash
cp .env.example .env      # 只設埠 / 初始頻率
docker compose up -d --build
```

- 啟動後開 web 介面到「設定」頁填 **Gemini 金鑰**(按「測試」驗證)。
- Web 介面：`http://<主機>:8448`（compose 綁 `127.0.0.1:8448`；要對外請自行加反向代理 / Tailscale）
- 資料庫：持久化在 `./data`（掛載進容器 `/app/data`）
- 改埠：在 `.env` 加 `WEB_PORT=xxxx`

### B. 部署到 afu（併入既有 Miniflux 堆疊）

afu 上其他 RSS 服務都採「獨立 compose project、綁 127.0.0.1、併入 `miniflux_default` 網路、對外走 Tailscale Serve」的模式，本服務照辦。

**1. 放置程式碼**（例：`C:\miniflux\shinkansen-rss\`）

連 submodule 一起帶過去。可在本機打包後傳，或在 afu 上 clone：

```bash
git clone --recurse-submodules <repo-url> C:\miniflux\shinkansen-rss
```

**2. 基礎設定**

```
copy .env.example .env
# 只設 PORT / 初始更新頻率;Gemini 金鑰啟動後在 web 介面「設定」頁填
```

**3. 建置並啟動（併入 Miniflux 網路）**

```bash
cd C:\miniflux\shinkansen-rss
docker compose -f docker-compose.yml -f docker-compose.afu.yml up -d --build
```

`docker-compose.afu.yml` 會把容器接上 `miniflux_default`，於是 Miniflux 容器能用內部 DNS 抓譯後 feed：

```
http://shinkansen-rss:8088/rss/<feedId>
```

> SSH 下若 `docker` 卡在 credential helper，見專案 memory「Windows Docker SSH 憑證繞過」的 no-op 繞法。

**4. Web 介面對外（Tailscale Serve）**

比照其他服務，挑一個未使用的埠（例 8448）：

```bash
tailscale serve --bg --https=8448 http://127.0.0.1:8448
# 之後即可 https://afu.<tailnet>.ts.net:8448 存取(僅 tailnet 內)
# 關閉:tailscale serve --https=8448 off
```

> **存取保護**：介面本身不設密碼，靠「只綁 127.0.0.1 ＋ Tailscale」限制在 tailnet 內。

**5. 接進 Miniflux**

- 逐條：在 web 介面每個 feed 卡片「複製」RSS 網址，貼進 Miniflux 訂閱。
  - 內部抓取用 `http://shinkansen-rss:8088/rss/<id>`（穩、不經 Tailscale）。
- 批次:用「匯出 OPML」下載，於 Miniflux「匯入 OPML」一次訂閱全部（xmlUrl 已是譯後網址）。

**更新版本**

```bash
git pull && git submodule update --init
docker compose -f docker-compose.yml -f docker-compose.afu.yml up -d --build
```

---

## 設定說明

### 環境變數（`.env`，可選）

| 變數 | 說明 | 預設 |
|---|---|---|
| `PORT` | 容器內監聽埠 | 8088 |
| `POLL_CRON` | **首次啟動**的預設更新頻率(DB 未設過時採用;之後以設定頁為準) | `*/15 * * * *` |
| `DB_PATH` | SQLite 路徑 | `data/shinkansen-feed.sqlite` |

> **Gemini 金鑰不再放 `.env`**。一律在 web 介面「設定」頁輸入,存在伺服器本機 SQLite(不外洩到瀏覽器、不進 git)。

### web「設定」分頁

- **API 金鑰**：在此輸入 + 「測試」按鈕（打 Gemini models 清單驗證）。**這是唯一設定金鑰的地方**。
- **預設引擎 / 模型**：Gemini（Lite / Flash）或 Google 翻譯;可逐 feed 覆寫。
- **更新頻率**：多久自動抓取+翻譯所有 feed(每 5 分～每 6 小時 / 關閉),改完即時生效。
- **每批段數 / 字元上限**：分批翻譯的門檻（段數預設 50）。
- **Gemini Temperature**：0 最穩定、越高越有創意（預設 1）。
- **紀錄保留天數**：log 保留幾天（預設 7）。
- **系統 prompt**：翻譯風格指令（預設台灣繁中 prompt，可改）。
- **禁用詞黑名單**：`中國用語=台灣用語`，譯文一律不用左欄。
- **模型計價**：各模型每 1M tokens 的自訂單價（空白 = 用內建價），用於費用統計。
- **匯出設定**：下載設定 JSON 備份（不含金鑰）。

---

## 使用

- **新增 feed**：Feeds 分頁貼網址 →（可先按「測試」確認抓得到）→「新增 Feed」。
- **翻譯**：按 feed 卡片「刷新」，或等排程自動跑（頻率在設定頁調）。
- **編輯 feed**：卡片「編輯」可改標題 / 分類 / 引擎 / 模型 / 抓全文 / 啟用。
- **逐 feed 覆寫**：新增或編輯時可指定引擎 / 模型 / 是否抓全文。
- **重翻失敗**：某 feed 有翻譯失敗的文章時，卡片會出現「**重翻**」按鈕，一鍵把失敗的重設並再翻一次。
- **用量**：費用、token、快取命中率、每日圖、逐 feed 統計、逐筆明細（**每頁 50 筆分頁**）、「重新整理」、CSV 匯出、清除。
- **紀錄**：抓取 / 翻譯 / 錯誤事件，可依等級 / 類別過濾、**每頁 50 筆分頁**、CSV 匯出、清除、設定保留天數。

---

## 備份

資料全在 SQLite 單檔（`data/` 下）。停容器或直接複製該檔即可備份：

```bash
docker compose stop app
cp data/shinkansen-feed.sqlite  <備份位置>
docker compose start app
```

（afu 上可把 `data/` 併進現有 RSS 堆疊的備份 zip。）

## 疑難排解

| 症狀 | 可能原因 / 解法 |
|---|---|
| 譯文漏段 | 理論上被段數不變量擋住;若仍發生請開 issue 附來源 HTML |
| Gemini 回「Thinking level is not supported」 | 用了舊模型;請用 gemini-3 系列（介面預設 Lite） |
| Miniflux 抓不到內部 feed | 確認容器有併入 `miniflux_default`（用 afu 疊加 compose） |
| `docker` 在 SSH 下卡住 | credential helper 問題,見 memory 的 no-op 繞法 |
| better-sqlite3 編譯失敗 | Dockerfile builder 階段已裝 python3/make/g++;本機請確認有編譯工具 |

## 開發

```bash
npm run dev            # 檔案變動自動重啟
npm test               # vitest
npm run translate -- "Hello, world."   # CLI 冒煙翻譯
```

**專案鐵律**：每個功能都要有 test case；vendor 引擎（submodule）只去瀏覽器化、不改邏輯；HTML 切段回填的段數進出必須相等。詳見 `CLAUDE.md`。

**更新引擎**：更新 submodule 指向的 commit，再人工同步 `src/engine-adapters/` 的適配層。

## 授權

本專案採用 [Elastic License 2.0 (ELv2)](LICENSE) 授權(比照翻譯引擎來源 [Shinkansen](https://github.com/jimmysu0309/shinkansen))。

白話來說:你可以自由查看原始碼、學習、修改、自己架來用,但**不能把本服務(或改寫版本)包成託管/管理式服務拿去賣**。完整條款請見 [LICENSE](LICENSE) 檔案。
