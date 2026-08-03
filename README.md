# 🚄 Shinkansen RSS Translator

把任何 RSS/Atom feed **翻成道地台灣繁體中文**，再輸出成新的 feed 給閱讀器（Miniflux、Readwise Reader…）訂閱。

翻譯引擎直接沿用瀏覽器擴充功能 **[Shinkansen](https://github.com/jimmysu0309/shinkansen)** 的 `lib/`（以 git submodule 釘版本引用，不改邏輯），因此繼承它調校過的台灣繁中 prompt、禁用詞黑名單、抗漏譯的分段對映與 token 計價。外面包一層 Node 伺服器負責抓取、去重、排程、輸出與 web 介面。

---

## 為什麼做這個

自架的 RSS 翻譯方案（如 rssbox / RSS Translator）常有兩個大問題：

1. **翻譯品質難控、常漏譯** — 根因多在切段 / segment 對映的實作。
2. **用量難追蹤** — 沒有像樣的 token / 費用紀錄。

本專案用 Shinkansen 驗證過的引擎（`translateBatch` 帶序號標記 + retry + 段數對映）從源頭解決漏譯，並內建用量與費用統計。切段時**只翻文字，元素以佔位符原樣保留**（整段送翻、語序自然），所以圖片、連結、粗體等 HTML 結構完整保留。

## 功能特色

- **三引擎**：Gemini（AI 翻譯、品質最佳、需 API 金鑰）＋ Google 翻譯（免費 & 不需金鑰）＋ **OpenCC 簡轉繁**（免費、零失真——本機字典 `cn→twp` 含台灣慣用詞，簡中 feed 免 token，整份 HTML 直轉連 code / 圖片 alt / 作者名都繁化）。可全域或逐 feed 選。
- **道地台灣繁中**：內建 Shinkansen 的系統 prompt ＋ 25 條中國用語黑名單（視頻→影片、軟件→軟體…），可在介面編輯。
- **防漏譯**：段數進出相等的不變量 ＋ 序號標記；結構、圖片、連結保留。
- **web 介面**：新增 / 管理 feed、全域設定、用量儀表板、翻譯紀錄，全部在瀏覽器完成。
- **OPML 匯入 / 匯出**：批次搬入來源、批次輸出譯後 feed 給 Miniflux 訂閱。
- **用量統計**：費用（USD，可自訂各模型單價）、token、快取命中率、每日費用圖、逐 feed 與逐筆明細、CSV 匯出、一鍵清除。
- **翻譯紀錄（Log）**：抓取 / 翻譯 / 錯誤事件紀錄，可依等級 / 類別 / **時間範圍（從/到精確到分 ＋ 日/週/月快捷）**過濾、**關鍵字搜尋**（訊息 / 細節 / feed 標題）、CSV 匯出（套用同一組過濾）、設定保留天數（預設 7 天）、一鍵清除。
- **失敗透明化**：feed 卡片的「N 失敗」badge 可點開，逐篇列出失敗文章的日期、標題與完整錯誤訊息；每條可「清除」放棄翻譯（RSS 改出原文、不再重試）。
- **全文抓取**：RSS 只給摘要的 feed，可逐 feed 開啟「抓取全文」（Readability 抽正文、相對網址轉絕對）再翻譯。
- **排程**：cron 定期自動處理所有啟用中的 feed。
- **conditional GET**：etag / last-modified，未更新不重抓；XML 解析失敗（上游偶發截斷回應）自動隔 3 秒重抓一次。
- **登入密碼**：`.env` 設 `AUTH_PASSWORD` 即啟用（Basic Auth，含防暴力嘗試鎖定）；譯後 RSS 保持免認證。
- **自我維護**：每 feed 文章上限（預設 300，可調）自動清舊文章、log 保留天數、每日自動備份 DB（輪替 7 份）、容器 log 輪替。

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
  db/                  SQLite schema + DAO(settings/feeds/entries/usage/logs)+ 自動備份
  web/                 Fastify server + public/(單頁分頁式介面)
  server.js            進入點(開 DB、載 .env、排程、listen)
vendor/shinkansen/     Shinkansen 引擎(git submodule)
test/                  vitest(233 tests)
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
cp .env.example .env      # 設 PORT / 初始更新頻率 / 登入密碼(選填);金鑰在 web 介面填

# 4. 啟動
npm start
#   → http://localhost:8088
```

打開瀏覽器到 `http://localhost:8088`，先到「設定」分頁填入 **Gemini API 金鑰**（按「測試」驗證），再到「Feeds」分頁貼 RSS 網址新增、刷新即開始翻譯。用免費的 Google 翻譯或 OpenCC 簡轉繁引擎則不需金鑰。

跑測試：

```bash
npm test          # 233 tests;有設 GEMINI_API_KEY 才會跑真打 API 的整合測試
```

---

## 部署指南

### 最簡單：請 Claude Code 幫你部署（推薦）

把這個專案網址交給 [Claude Code](https://claude.com/claude-code)（或其他 coding agent），請它「看這個專案，幫我部署」。它會讀 README 與 `docker-compose.yml`，幫你建立 `.env`、建置並啟動容器、把服務跑起來，並引導你到「設定」頁填 Gemini 金鑰、新增第一個 feed；日後要更新也可以請它 `git pull` 重新部署。

想自己動手的話，以下是手動步驟。

### 手動 A：一般 Docker 主機

```bash
cp .env.example .env      # 只設埠 / 初始頻率
docker compose up -d --build
```

- 啟動後開 web 介面到「設定」頁填 **Gemini 金鑰**（按「測試」驗證）。
- Web 介面：`http://<主機>:8448`（compose 綁 `127.0.0.1:8448`；要對外請自行加反向代理 / Tailscale）
- 資料庫：持久化在 `./data`（掛載進容器 `/app/data`）
- 改埠：在 `.env` 加 `WEB_PORT=xxxx`

### 手動 B：併入現有 Miniflux 堆疊（選配）

若你已有一套 Miniflux 跑在 Docker，想讓 Miniflux 直接用內部網路抓譯後 feed：疊加 `docker-compose.miniflux.yml`，把本服務接上 Miniflux 所在的外部網路（預設 `miniflux_default`）：

```bash
docker compose -f docker-compose.yml -f docker-compose.miniflux.yml up -d --build
```

之後 Miniflux 容器即可用內部 DNS 訂閱（需 Miniflux 開 `FETCHER_ALLOW_PRIVATE_NETWORKS=1`）：

```
http://shinkansen-rss:8088/rss/<feedId>
```

> 在 `.env` 設 `AUTH_PASSWORD` 可為介面與 API 加上登入密碼（HTTP Basic Auth，帳號隨意）；譯後 RSS（`/rss/…`）一律免認證，閱讀器才抓得到。沒設密碼時建議只綁 `127.0.0.1`，對外存取用反向代理 / Tailscale / VPN 限制。

---

## 設定說明

### 環境變數（`.env`，可選）

| 變數 | 說明 | 預設 |
|---|---|---|
| `PORT` | 容器內監聽埠 | 8088 |
| `POLL_CRON` | **首次啟動**的預設更新頻率（DB 未設過時採用；之後以設定頁為準） | `*/15 * * * *` |
| `DB_PATH` | SQLite 路徑 | `data/shinkansen-feed.sqlite` |
| `AUTH_PASSWORD` | 介面與 API 的登入密碼（Basic Auth，帳號隨意）；不設 = 不認證 | （無） |

> **Gemini 金鑰不再放 `.env`**。一律在 web 介面「設定」頁輸入，存在伺服器本機 SQLite（不外洩到瀏覽器、不進 git）。

### web「設定」分頁

- **API 金鑰**：在此輸入 + 「測試」按鈕（打 Gemini models 清單驗證）。**這是唯一設定金鑰的地方**。
- **預設引擎 / 模型**：Gemini（Lite 3.1 / Flash Lite 3.5 / Flash preview / Flash 3.6）、Google 翻譯或 OpenCC 簡轉繁；可逐 feed 覆寫。
- **更新頻率**：多久自動抓取+翻譯所有 feed（每 5 分～每 6 小時 / 關閉），改完即時生效。
- **每批段數 / 字元上限**：分批翻譯的門檻（段數預設 50）。
- **Gemini Temperature**：0 最穩定、越高越有創意（預設 1）。
- **紀錄保留天數**：log 保留幾天（預設 7）。
- **每 feed 文章上限**：每個 feed 最多保留幾篇文章（預設 300，**0** = 不限制），超過自動清掉最舊的。
- **系統 prompt**：翻譯風格指令（預設台灣繁中 prompt，可改）。
- **禁用詞黑名單**：`中國用語=台灣用語`，譯文一律不用左欄。
- **模型計價**：各模型每 1M tokens 的自訂單價（空白 = 用內建價），用於費用統計。
- **匯出 / 匯入備份**：下載完整備份 JSON——全部設定 ＋ feeds（不含金鑰）；匯入時設定走白名單、feeds 依來源網址 upsert（已存在則更新設定、不動文章），換機搬遷免重填。也相容舊版「匯出設定」檔。

---

## 使用

- **新增 feed**：Feeds 分頁貼網址 →（可先按「測試」確認抓得到）→「新增 Feed」。
- **翻譯**：按 feed 卡片「刷新」，或等排程自動跑（頻率在設定頁調）。
- **編輯 feed**：卡片「編輯」可改**來源網址**（換網址自動清 etag 快取）/ 標題 / 引擎 / 模型 / 抓全文（不做分類——feed 分類請在 Miniflux 匯入後自行整理）。
- **啟用 / 停用**：卡片右上的開關一鍵停用（排程略過、卡片變淡；RSS 輸出仍可讀）／重新啟用。
- **逐 feed 覆寫**：新增或編輯時可指定引擎 / 模型 / 是否抓全文。
- **查失敗原因**：點卡片上的「**N 失敗**」badge 展開失敗清單（日期、標題連回原文、完整錯誤訊息）；每條可「**清除**」放棄翻譯（該篇 RSS 改出原文、不再重試）。
- **重翻失敗**：某 feed 有翻譯失敗的文章時，卡片會出現「**重翻**」按鈕，一鍵把失敗的重設並再翻一次。
- **全部重譯**：編輯面板的「**全部重譯**」把該 feed 所有文章（含已翻）重翻一次——改模型 / prompt / 抓全文設定後套用（會重新花 token）。
- **用量**：費用、token、快取命中率、每日圖、逐 feed 統計、逐筆明細（**每頁 50 筆分頁**）、「重新整理」、CSV 匯出、清除。
- **紀錄**：抓取 / 翻譯 / 錯誤事件，可依等級 / 類別 / 時間範圍（從/到 ＋ 日/週/月快捷 ＋「現在時間」）過濾、關鍵字搜尋、**每頁 50 筆分頁**、CSV 匯出（套用同一組過濾）、清除、設定保留天數。

---

## 備份

資料全在 SQLite 單檔（`data/` 下）。**服務每天 04:00 會自動備份**到 `data/backups/`（輪替保留最新 7 份，一致性快照、不用停機）。

要手動備份或搬到異地，複製備份檔即可：

```bash
cp data/backups/shinkansen-feed-<日期>.sqlite  <備份位置>
# 或停機複製主檔:
docker compose stop app
cp data/shinkansen-feed.sqlite  <備份位置>
docker compose start app
```


## 授權

本專案採用 [Elastic License 2.0 (ELv2)](LICENSE) 授權（比照翻譯引擎來源 [Shinkansen](https://github.com/jimmysu0309/shinkansen)）。

白話來說：你可以自由查看原始碼、學習、修改、自己架來用，但**不能把本服務（或改寫版本）包成託管/管理式服務拿去賣**。完整條款請見 [LICENSE](LICENSE) 檔案。
