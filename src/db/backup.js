// backup.js — SQLite 自動備份:better-sqlite3 的 backup API 做一致性快照(WAL 進行中也安全),
// 存 <db 目錄>/backups/<db 名>-YYYY-MM-DD.sqlite,輪替只留最新 keep 份。
//
// 訊號層次:
//   ✓ 備份檔可開、內容與來源一致;同日重跑覆蓋;輪替刪最舊
//   ✗ 不驗:排程觸發(server.js entry 的 cron)、備份檔的異地保存

import { mkdirSync, readdirSync, unlinkSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

/**
 * @param {import('better-sqlite3').Database} db 開著的 DB(createDb().db)
 * @param {string} dbPath DB 檔路徑(':memory:' 直接跳過)
 * @param {{keep?:number, now?:Date}} [opts] keep=保留份數;now 供測試注入日期
 * @returns {Promise<{path:string, removed:number}|null>} 備份檔路徑與輪替刪除數;跳過時 null
 */
export async function backupDb(db, dbPath, { keep = 7, now = new Date() } = {}) {
  if (!dbPath || dbPath === ':memory:') return null;
  const dir = join(dirname(dbPath), 'backups');
  mkdirSync(dir, { recursive: true });

  const stem = basename(dbPath, '.sqlite');
  const dest = join(dir, `${stem}-${now.toISOString().slice(0, 10)}.sqlite`);
  // 先備到 .tmp 再 rename(原子覆蓋):備份中途失敗不會弄丟已存在的當日檔
  const tmp = dest + '.tmp';
  rmSync(tmp, { force: true });
  await db.backup(tmp);
  renameSync(tmp, dest); // 同日重跑:原子覆蓋當日檔

  // 輪替:同前綴備份檔名含 ISO 日期,字典序 = 時間序,留最新 keep 份(.tmp 不含 .sqlite 結尾,不入列)
  const files = readdirSync(dir).filter((f) => f.startsWith(stem + '-') && f.endsWith('.sqlite')).sort();
  const excess = files.slice(0, Math.max(0, files.length - keep));
  for (const f of excess) unlinkSync(join(dir, f));

  return { path: dest, removed: excess.length };
}
