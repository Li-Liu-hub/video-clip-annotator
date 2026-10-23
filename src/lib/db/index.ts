import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

const SCHEMA_PATH = path.join(process.cwd(), 'src', 'lib', 'db', 'schema.sql');
const DB_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'app.db');

function applyPragmas(db: DB): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // 并发写时排队等待，而不是立刻抛 SQLITE_BUSY
  db.pragma('busy_timeout = 5000');
}

export function loadSchema(): string {
  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error(`找不到 schema.sql：${SCHEMA_PATH}`);
  }
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

/**
 * 工厂：建一个全新的库并应用 schema。测试传 ':memory:' 即可获得完全隔离的实例。
 *
 * 注意这是「建」，不是「打开」。schema.sql 里没有 IF NOT EXISTS，
 * 对已存在的库重复调用会报错 —— 这是刻意的，避免旧表结构被静默沿用。
 */
export function createDb(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  applyPragmas(db);
  db.exec(loadSchema());
  return db;
}

// Next.js 开发模式会反复求值模块，连接必须挂在 globalThis 上，
// 否则每次热重载都新开一个文件句柄。
const globalForDb = globalThis as unknown as { __appDb?: DB };

/**
 * 单例：生产用。库必须已由 scripts/setup.mjs 初始化过。
 */
export function getDb(): DB {
  if (globalForDb.__appDb) return globalForDb.__appDb;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  applyPragmas(db);

  globalForDb.__appDb = db;
  return db;
}

/**
 * 写事务。BEGIN IMMEDIATE 立即取写锁，
 * 让「检查约束 → 写入」在同一临界区内完成。
 *
 * db 显式传入，测试才能用各自的内存库。
 */
export function writeTx<T>(db: DB, fn: (tx: DB) => T): T {
  const wrapped = db.transaction(() => fn(db));
  return wrapped.immediate();
}

export function nowMs(): number {
  return Date.now();
}
