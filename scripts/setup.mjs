#!/usr/bin/env node
/**
 * 初始化脚本。
 *
 * 由 package.json 的 predev / prebuild 钩子自动触发，
 * 所以使用者只需要 `npm install && npm run dev`，不必记得先建库。
 *
 * 幂等：已有数据时直接退出。加 --reset 强制重建。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.DATABASE_PATH ?? path.join(DATA_DIR, 'app.db');
const SCHEMA_PATH = path.join(ROOT, 'src', 'lib', 'db', 'schema.sql');
const VIDEO = '/videos/demo.mp4';
const VIDEO_DURATION_MS = 40_000;

const reset = process.argv.includes('--reset');

function hashPassword(password) {
  // 与 src/lib/auth.ts 保持同一格式：scrypt$<salt>$<hash>
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

/** 与 src/lib/time.ts 中的 localDateOf 等价 */
function localDateOf(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(utcMs));
  const pick = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

const id = () => randomBytes(8).toString('hex');

if (reset && fs.existsSync(DB_PATH)) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = DB_PATH + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  console.log('[setup] 已删除旧数据库');
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const existing = db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n;
if (existing > 0 && !reset) {
  console.log('[setup] 数据库已存在，跳过初始化');
  console.log(`[setup] 数据库位置：${DB_PATH}`);
  db.close();
  process.exit(0);
}

if (!fs.existsSync(path.join(ROOT, 'public', 'videos', 'demo.mp4'))) {
  console.warn('[setup] 警告：public/videos/demo.mp4 缺失，任务里的视频将无法播放');
}

const now = Date.now();
const dayMs = 86_400_000;

const tenants = [
  { id: id(), name: '星尘机器人', tz: 'Asia/Shanghai' },
  { id: id(), name: '北风具身智能', tz: 'Asia/Shanghai' },
];

const adminId = id();
const aliceId = id();
const bobId = id();
const carolId = id();

const users = [
  { id: adminId, tenant: null, username: 'admin', name: '平台管理员', pwd: 'admin123', role: 'admin', label: '管理员 · 跨租户' },
  { id: aliceId, tenant: tenants[0].id, username: 'alice', name: '林小雨', pwd: 'demo123', role: 'annotator', label: '标注员 · 星尘' },
  { id: bobId, tenant: tenants[0].id, username: 'bob', name: '陈默', pwd: 'demo123', role: 'annotator', label: '标注员 · 星尘' },
  { id: carolId, tenant: tenants[1].id, username: 'carol', name: '周予安', pwd: 'demo123', role: 'annotator', label: '标注员 · 北风' },
];

const taskSeeds = [
  // 已完成的历史任务：为统计页造出可信的趋势
  { tenant: 0, title: '双臂协作 · 取杯与递送', assignee: aliceId, daysAgo: 5, hour: 10, status: 'submitted', segs: [[2100, 6400], [9100, 13800], [19200, 24500]] },
  { tenant: 0, title: '双臂协作 · 研磨与压粉', assignee: aliceId, daysAgo: 4, hour: 14, status: 'submitted', segs: [[1500, 5200], [7200, 11900], [15600, 20100], [24300, 28800]] },
  { tenant: 0, title: '单臂抓取 · 杯柄对齐', assignee: bobId, daysAgo: 4, hour: 16, status: 'submitted', segs: [[3400, 8100], [12400, 17200]] },
  { tenant: 0, title: '单臂抓取 · 稳定放置', assignee: bobId, daysAgo: 3, hour: 9, status: 'submitted', segs: [[1800, 7900], [11200, 18700], [21000, 27400]] },
  { tenant: 0, title: '双臂协作 · 注入热水', assignee: aliceId, daysAgo: 2, hour: 11, status: 'submitted', segs: [[2600, 6900], [8800, 14700]] },
  { tenant: 0, title: '单臂抓取 · 空杯回收', assignee: bobId, daysAgo: 1, hour: 15, status: 'submitted', segs: [[3100, 9800], [13400, 19600], [22800, 29100], [30500, 35800]] },
  { tenant: 0, title: '双臂协作 · 端到端流程', assignee: aliceId, daysAgo: 0, hour: 9, status: 'submitted', segs: [[1200, 5800], [7600, 12300]] },

  { tenant: 1, title: '推动方块 · 直线轨迹', assignee: carolId, daysAgo: 4, hour: 11, status: 'submitted', segs: [[2400, 8900], [12600, 18100]] },
  { tenant: 1, title: '推动方块 · 避障变道', assignee: carolId, daysAgo: 2, hour: 13, status: 'submitted', segs: [[1900, 7400], [10800, 16300], [20100, 25600]] },
  { tenant: 1, title: '推动方块 · 定位精度校准', assignee: carolId, daysAgo: 0, hour: 10, status: 'submitted', segs: [[2800, 9100]] },

  // 进行中 / 待领取，让标注端有活可干
  { tenant: 0, title: '双臂协作 · 倾倒与收尾', assignee: aliceId, daysAgo: 0, hour: 8, status: 'claimed', segs: [[4200, 9600]] },
  { tenant: 0, title: '单臂抓取 · 侧向接近', assignee: null, daysAgo: 0, hour: 8, status: 'pending', segs: [] },
  { tenant: 0, title: '双臂协作 · 传递与放开', assignee: null, daysAgo: 0, hour: 8, status: 'pending', segs: [] },
  { tenant: 1, title: '推动方块 · 反向推回', assignee: null, daysAgo: 0, hour: 8, status: 'pending', segs: [] },
];

const insertTenant = db.prepare('INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)');
const insertUser = db.prepare(
  'INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
const insertTask = db.prepare(
  `INSERT INTO tasks (id, tenant_id, title, description, video_path, video_duration_ms, status, assignee_id, claimed_at, first_submitted_at, created_by, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insertSegment = db.prepare(
  'INSERT INTO segments (id, task_id, tenant_id, start_ms, end_ms, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
const insertSubmission = db.prepare(
  `INSERT INTO submissions (id, task_id, tenant_id, annotator_id, submitted_at, local_date, total_ms, segment_count, segments_json, superseded_by, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
);
const insertLedger = db.prepare(
  `INSERT INTO ledger_entries (id, tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date, kind, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'submit', ?)`,
);

const seed = db.transaction(() => {
  for (const t of tenants) insertTenant.run(t.id, t.name, t.tz, now);
  for (const u of users) {
    insertUser.run(u.id, u.tenant, u.username, u.name, hashPassword(u.pwd), u.role, now);
  }

  for (const spec of taskSeeds) {
    const tenant = tenants[spec.tenant];
    const taskId = id();
    const createdAt = now - spec.daysAgo * dayMs - 3_600_000;
    const claimedAt = spec.status === 'pending' ? null : createdAt + 60_000;
    const total = spec.segs.reduce((sum, [s, e]) => sum + (e - s), 0);

    // 让提交时刻落在当天的指定小时上（按 UTC 近似，演示数据无需精确对齐时区）
    const submittedTs =
      spec.status === 'submitted'
        ? Math.min(Date.now(), now - spec.daysAgo * dayMs + (spec.hour - new Date().getUTCHours()) * 3_600_000)
        : null;

    insertTask.run(
      taskId,
      tenant.id,
      spec.title,
      '从示教视频中标出机器人完成该子任务的有效片段。',
      VIDEO,
      VIDEO_DURATION_MS,
      spec.status,
      spec.assignee,
      claimedAt,
      submittedTs,
      adminId,
      createdAt,
    );

    for (const [start, end] of spec.segs) {
      insertSegment.run(id(), taskId, tenant.id, start, end, '有效操作', createdAt + 120_000);
    }

    if (spec.status === 'submitted' && submittedTs && spec.assignee) {
      const submissionId = id();
      const localDate = localDateOf(submittedTs, tenant.tz);

      insertSubmission.run(
        submissionId,
        taskId,
        tenant.id,
        spec.assignee,
        submittedTs,
        localDate,
        total,
        spec.segs.length,
        JSON.stringify(spec.segs.map(([s, e]) => ({ startMs: s, endMs: e, label: '有效操作' }))),
        submittedTs,
      );

      insertLedger.run(id(), tenant.id, taskId, submissionId, spec.assignee, total, localDate, submittedTs);
    }
  }
});

seed();

const counts = {
  租户: db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n,
  用户: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  任务: db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
  已提交: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'submitted'").get().n,
  账本记录: db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get().n,
};

db.close();

console.log('[setup] 数据库初始化完成');
console.log(`[setup] 位置：${DB_PATH}`);
for (const [k, v] of Object.entries(counts)) console.log(`[setup]   ${k}: ${v}`);
console.log('[setup] 演示账号：admin/admin123（管理员） alice/demo123（标注员）');
