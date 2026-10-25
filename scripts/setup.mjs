#!/usr/bin/env node
/**
 * 初始化脚本：建表 + 灌种子数据。
 *
 * 由 package.json 的 predev / prebuild 钩子自动触发，
 * 使用者只需要 `npm install && npm run dev`，不必记得先建库。
 *
 * 幂等：表已存在时直接退出。加 --reset 强制重建。
 * 种子本身在 scripts/seed.mjs：invariant-check --temp 也要用同一份，不复制。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { seedDatabase } from './seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const DB_PATH = process.env.DATABASE_PATH ?? path.join(DATA_DIR, 'app.db');
const SCHEMA_PATH = path.join(ROOT, 'src', 'lib', 'db', 'schema.sql');
/**
 * 种子视频取自真实机器人示教数据（LeRobot，Hugging Face 公开数据集）：
 * ALOHA 双臂做咖啡 30 秒片段，H.264 640×480，2 MB。
 *
 * 素材放 fixtures/ 而非 public/：public 下任何人知道路径就能下载，
 * 与「视频必须过鉴权路由」的设计冲突。
 */
const VIDEO_SRC = path.join(ROOT, 'fixtures', 'videos', 'aloha-coffee.mp4');
const VIDEO_FILE = 'aloha-coffee.mp4';

const reset = process.argv.includes('--reset');

if (reset) {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  if (fs.existsSync(VIDEO_DIR)) fs.rmSync(VIDEO_DIR, { recursive: true });
  console.log('[setup] 已清除旧数据库与视频目录');
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const initialized = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenants'")
  .get();

if (initialized && !reset) {
  console.log('[setup] 数据库已初始化，跳过');
  console.log(`[setup] 位置：${DB_PATH}`);
  db.close();
  process.exit(0);
}

db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// 视频随仓库分发，这里复制到运行时目录，避免和静态资源混淆
fs.mkdirSync(VIDEO_DIR, { recursive: true });
if (fs.existsSync(VIDEO_SRC)) {
  fs.copyFileSync(VIDEO_SRC, path.join(VIDEO_DIR, VIDEO_FILE));
} else {
  console.warn(`[setup] 警告：${VIDEO_SRC} 缺失，任务里的视频将无法播放`);
}

const copiedVideo = path.join(VIDEO_DIR, VIDEO_FILE);
const counts = seedDatabase(db, {
  videoSize: fs.existsSync(copiedVideo) ? fs.statSync(copiedVideo).size : 1,
});

db.close();

console.log('[setup] 数据库初始化完成');
console.log(`[setup] ${DB_PATH}`);
for (const [k, v] of Object.entries(counts)) console.log(`[setup]   ${k}: ${v}`);
console.log('[setup] 账号：admin/admin123（管理员） alice|bob|carol / demo123（标注员）');
