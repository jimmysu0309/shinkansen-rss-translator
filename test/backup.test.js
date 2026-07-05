// DB 自動備份測試(用系統暫存目錄的真實 SQLite 檔,測完目錄即棄)。
//
// 訊號層次:
//   ✓ 備份檔可開、內容與來源一致
//   ✓ 輪替只留 keep 份(刪最舊);:memory: 跳過
//   ✗ 不驗:每日排程觸發(server.js entry 的 cron)、異地保存
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createDb } from '../src/db/index.js';
import { backupDb } from '../src/db/backup.js';

describe('backupDb', () => {
  it(':memory: 直接跳過回 null', async () => {
    const ctx = createDb(':memory:');
    expect(await backupDb(ctx.db, ':memory:')).toBe(null);
  });

  it('備份檔可開且內容一致;輪替只留 keep 份(刪最舊)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skf-backup-'));
    const dbPath = join(dir, 'test.sqlite');
    const ctx = createDb(dbPath);
    ctx.settings.set('model', 'm1');

    let last;
    for (const day of ['2026-07-01', '2026-07-02', '2026-07-03']) {
      last = await backupDb(ctx.db, dbPath, { keep: 2, now: new Date(`${day}T04:00:00Z`) });
    }
    expect(last.removed).toBe(1); // 第三份時刪掉最舊那份
    expect(readdirSync(join(dir, 'backups')).sort()).toEqual([
      'test-2026-07-02.sqlite', 'test-2026-07-03.sqlite',
    ]);

    const bak = new Database(last.path, { readonly: true });
    const row = bak.prepare("SELECT value FROM settings WHERE key = 'model'").get();
    expect(JSON.parse(row.value)).toBe('m1');
    bak.close();
    ctx.db.close();
  });

  it('同日重跑覆蓋當日檔,不累積', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skf-backup-'));
    const dbPath = join(dir, 'test.sqlite');
    const ctx = createDb(dbPath);
    const now = new Date('2026-07-05T04:00:00Z');
    await backupDb(ctx.db, dbPath, { now });
    const again = await backupDb(ctx.db, dbPath, { now });
    expect(again.removed).toBe(0);
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
    ctx.db.close();
  });
});
