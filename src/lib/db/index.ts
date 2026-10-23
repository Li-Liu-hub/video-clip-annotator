import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

const DB_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'app.db');

// Next.js 开发模式会反复求值模块，连接必须挂在 globalThis 上，
// 否则每次热重载都新开一个文件句柄。
const globalForDb = globalThis as unknown as { __appDb?: DB };

export function getDb(): DB {
  if (globalForDb.__appDb) return globalForDb.__appDb;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // 并发写时排队等待，而不是立刻抛 SQLITE_BUSY
  db.pragma('busy_timeout = 5000');

  globalForDb.__appDb = db;
  return db;
}

/**
 * 写事务。使用 BEGIN IMMEDIATE 立即取得写锁，
 * 使「检查约束 → 写入」在同一临界区内完成。
 */
export function writeTx<T>(fn: (db: DB) => T): T {
  const db = getDb();
  return db.transaction(fn).immediate(db);
}

export function nowMs(): number {
  return Date.now();
}
