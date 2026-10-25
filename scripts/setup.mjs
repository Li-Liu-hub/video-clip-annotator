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

// 视频素材在任何模式下都要复制：任务始终插入并引用它。
// 早先只在演示模式复制，默认库能登录、能看到任务，但一点播放就 404 ——
// 「数据全量、只随机口令」这个取舍里，视频属于数据，不属于口令。
const demoLogin = process.env.DEMO_LOGIN === '1';
const copiedVideo = path.join(VIDEO_DIR, VIDEO_FILE);
// 视频随仓库分发，这里复制到运行时目录，避免和静态资源混淆
fs.mkdirSync(VIDEO_DIR, { recursive: true });
if (fs.existsSync(VIDEO_SRC)) {
  fs.copyFileSync(VIDEO_SRC, copiedVideo);
} else {
  console.warn(`[setup] 警告：${VIDEO_SRC} 缺失，任务里的视频将无法播放`);
}

const { counts, sharedPassword } = seedDatabase(db, {
  videoSize: fs.existsSync(copiedVideo) ? fs.statSync(copiedVideo).size : 1,
  demoLogin,
});

db.close();

console.log('[setup] 数据库初始化完成');
console.log(`[setup] ${DB_PATH}`);
for (const [k, v] of Object.entries(counts)) console.log(`[setup]   ${k}: ${v}`);
// 只在这里出现一次：本行之后口令没有任何副本（不写文件、不进 README）。
// 忘了就 --reset 重建，或先用它登录再走改密接口。
if (sharedPassword) {
  // 四个账号共用这个口令：管理员与三位标注员。丢失只能 --reset 或走改密接口
  console.log(`[setup] 初始口令（只显示这一次，四个账号共用）：${sharedPassword}`);
  console.log('[setup] 想用文档里的固定演示口令：DEMO_LOGIN=1 node scripts/setup.mjs --reset');
  
} else {
  console.log('[setup] 演示模式：admin/admin123（管理员） alice|bob|carol / demo123（标注员）');
  console.log('[setup] 警告：演示账号是固定口令，禁止用于任何真实环境');
}
