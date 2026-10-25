#!/usr/bin/env node
/**
 * 五组不变量检查器（I1 的判定 + I2 的两处接入）。
 *
 * 两种模式：
 *   默认      读 data/app.db。开发者与运维用，回答「现在这个库还自洽吗」。
 *   --temp    建一个一次性内存库 → 灌种子 → 跑完整业务链路 → 检查。
 *             确定性、不碰磁盘，因此可以挂进 pretest。
 *
 * 为什么 --temp 不用 `setup.mjs --reset`：那会重建 data/app.db 与 data/videos，
 * 把开发者手上的数据清空。pretest 是每次 npm test 都要跑的，不能有这种副作用。
 *
 * 为什么脚本里要自己装载 TS：
 *   业务链路必须经 claimTask / submitTask / rejectTask 等 service，否则验的还是
 *   「手写 SQL 造的数据对不对」。项目没有 tsx / ts-node 依赖，而 typescript 已随
 *   devDependencies 装在本地；用它做一次 transpile 比新增一个运行器依赖更可控。
 *   这段桥接只服务本脚本，不进 src，也不改变业务代码的任何行为。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { seedDatabase } from './seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const SCHEMA_PATH = path.join(SRC, 'lib', 'db', 'schema.sql');
const DB_PATH = process.env.DATABASE_PATH ?? path.join(ROOT, 'data', 'app.db');
const TEMP_MODE = process.argv.includes('--temp');
/** 控制台最多列这么多条：几十条违反刷屏后反而看不到第一条 */
const MAX_REPORTED = 10;

const require = createRequire(import.meta.url);
const Module = require('node:module');

// 让 require 认 .ts：读源码 → 去类型 → 以 CJS 编译。只做类型剥离，不做类型检查
// （类型检查有 `npx tsc --noEmit` 这一道，重复做只会让脚本变慢）。
require.extensions['.ts'] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  module._compile(output, filename);
};

// tsc 只剥类型，不会重写 `@/` 别名（那是打包器的职责）。这里补上同一张映射表，
// 使脚本加载的模块与 Next 构建时解析到的是同一批文件。
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  const mapped = request.startsWith('@/') ? path.join(SRC, request.slice(2)) : request;
  return resolveFilename.call(this, mapped, parent, isMain, options);
};

const { findViolations } = require('@/lib/invariants');

/** 报告开头的一行规模：数字不对说明查错了库，比任何断言都先暴露问题 */
function overview(db) {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    tasks: count('tasks'),
    ledger: count('ledger_entries'),
    snapshots: count('submissions'),
  };
}

function report(db, label) {
  const counts = overview(db);
  console.log(`[invariant] ${label}`);
  console.log(
    `[invariant] 检查 ${counts.tasks} 个任务、${counts.ledger} 条账目、${counts.snapshots} 条快照`,
  );

  const violations = findViolations(db);
  if (violations.length === 0) {
    console.log('[invariant] 0 项违反');
    return true;
  }

  for (const violation of violations.slice(0, MAX_REPORTED)) {
    console.log(`  !! [${violation.rule}] ${violation.subject} — ${violation.detail}`);
  }
  if (violations.length > MAX_REPORTED) {
    console.log(`  … 另有 ${violations.length - MAX_REPORTED} 项未列出`);
  }
  console.log(`[invariant] ${violations.length} 项违反`);
  return false;
}

/** 从库里读一个身份，字段与 service 的 SessionUser / TenantUser 对齐 */
function loadActor(db, username) {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.tenant_id,
              t.name AS tenant_name, t.timezone
         FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE u.username = ?`,
    )
    .get(username);
  if (!row) throw new Error(`种子数据缺少账号 ${username}`);

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    // 管理员不属于租户，但 service 的签名要求有时区；取默认值
    timezone: row.timezone ?? 'Asia/Shanghai',
  };
}

/**
 * 一次性库：种子 + 真实业务链路。
 *
 * 链路刻意覆盖「提交 → 退回 → 重新打开 → 再提交」，因为账本最容易在这条路上失衡：
 * 退回要写一笔负数且记原提交日，重提要接过一条新快照并取代旧的。
 */
function buildTempDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  seedDatabase(db, { videoSize: 1 });

  const { createTasks, claimTask } = require('@/lib/services/task-service');
  const { upsertSegment } = require('@/lib/services/segment-service');
  const { submitTask } = require('@/lib/services/submit-service');
  const { rejectTask, reopenTask } = require('@/lib/services/review-service');

  const admin = loadActor(db, 'admin');
  const alice = loadActor(db, 'alice');
  const video = db.prepare('SELECT id FROM videos LIMIT 1').get();

  const { ids } = createTasks(db, admin, {
    videoId: video.id,
    tenantIds: [alice.tenantId],
    title: '不变量临时链路',
  });
  const [taskId] = ids;

  claimTask(db, alice, taskId);
  upsertSegment(db, alice, taskId, { startMs: 1_000, endMs: 5_000 });
  upsertSegment(db, alice, taskId, { startMs: 9_000, endMs: 12_000 });
  submitTask(db, alice, taskId);
  rejectTask(db, admin, taskId, '临时链路：退回以验证冲正');
  reopenTask(db, alice, taskId);
  submitTask(db, alice, taskId);

  return db;
}

if (TEMP_MODE) {
  const db = buildTempDb();
  const ok = report(
    db,
    '临时库：种子 + 领取 → 标注 → 提交 → 退回 → 重新打开 → 再提交',
  );
  db.close();
  process.exit(ok ? 0 : 1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`[invariant] 找不到数据库：${DB_PATH}`);
  console.error('[invariant] 先运行 node scripts/setup.mjs --reset');
  process.exit(1);
}

// 只读打开：检查器不改数据，能被误写成修复器才是最坏的结局
const db = new Database(DB_PATH, { readonly: true });
const ok = report(db, DB_PATH);
db.close();
process.exit(ok ? 0 : 1);
