#!/usr/bin/env node
/**
 * 对「不变量检查器」本身做变异验证。
 *
 * 检查器全绿只说明数据干净，不说明检查器有牙。
 * 本脚本在数据库副本上故意制造各类违规，逐一确认检查器能抓到。
 *
 * 用法：npm run db:verify-checker
 * 任何一个变异没被抓到，退出码非 0。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DB = path.join(ROOT, 'data', 'app.db');
const CHECKER = path.join(ROOT, 'scripts', 'check-invariants.mjs');

if (!fs.existsSync(SRC_DB)) {
  console.error('[verify] 找不到数据库，请先 npm run db:reset');
  process.exit(1);
}

const mutations = [
  {
    name: '跨租户污染',
    expect: 'segments 的租户与所属任务一致',
    apply(db) {
      const row = db
        .prepare('SELECT s.id FROM segments s JOIN tasks t ON t.id = s.task_id LIMIT 1')
        .get();
      db.prepare("UPDATE segments SET tenant_id = 'ffffffffffffffff' WHERE id = ?").run(row.id);
    },
  },
  {
    name: '快照 total_ms 与内容不符',
    expect: '提交的 total_ms 等于快照内各段之和',
    apply(db) {
      const row = db.prepare('SELECT id, total_ms FROM submissions LIMIT 1').get();
      db.prepare('UPDATE submissions SET total_ms = ? WHERE id = ?').run(row.total_ms + 1, row.id);
    },
  },
  {
    name: '账本净额与任务状态不符',
    expect: '每个任务的账本净额与状态相符',
    apply(db) {
      const row = db.prepare("SELECT id, delta_ms FROM ledger_entries WHERE kind = 'submit' LIMIT 1").get();
      db.prepare('UPDATE ledger_entries SET delta_ms = ? WHERE id = ?').run(row.delta_ms + 5000, row.id);
    },
  },
  {
    name: '日期格式非法',
    expect: 'ledger 的 entry_date 格式合法',
    apply(db) {
      const row = db.prepare('SELECT id FROM ledger_entries LIMIT 1').get();
      db.prepare("UPDATE ledger_entries SET entry_date = '2026/10/22' WHERE id = ?").run(row.id);
    },
  },
  {
    name: '已提交任务缺少提交记录',
    expect: '已提交任务恰有一个未被取代的提交',
    apply(db) {
      // 把提交标记为已被取代，制造「submitted 但无有效提交」
      const row = db
        .prepare(
          "SELECT s.id FROM submissions s JOIN tasks t ON t.id = s.task_id WHERE t.status = 'submitted' LIMIT 1",
        )
        .get();
      db.prepare('UPDATE submissions SET superseded_by = id WHERE id = ?').run(row.id);
    },
  },
];

function freshCopy(tag) {
  const target = path.join(os.tmpdir(), `dbcheck-${tag}-${Date.now()}.db`);
  const src = new Database(SRC_DB, { readonly: true });
  src.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  src.close();
  return target;
}

function runChecker(dbPath) {
  const r = spawnSync(process.execPath, [CHECKER], {
    env: { ...process.env, DATABASE_PATH: dbPath },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// 基线：未变异时必须全绿
const baseline = freshCopy('baseline');
const base = runChecker(baseline);
fs.rmSync(baseline, { force: true });

console.log('[verify] 基线（未变异）');
const baseOk = base.code === 0;
console.log(`  ${baseOk ? 'ok ' : '!! '} 检查器在干净数据上应当全绿  — exit=${base.code}`);
if (!baseOk) console.log(base.out);

console.log('\n[verify] 变异验证');
const results = [];

for (const m of mutations) {
  const copy = freshCopy(m.name.slice(0, 6));
  try {
    const db = new Database(copy);
    m.apply(db);
    db.close();

    const r = runChecker(copy);
    const caught = r.code !== 0 && r.out.includes(m.expect);
    results.push({ name: m.name, caught, code: r.code });
    console.log(`  ${caught ? 'ok ' : '!! '} ${m.name}  →  ${m.expect}`);
    if (!caught) console.log(r.out.split('\n').filter((l) => l.includes('!!')).join('\n'));
  } finally {
    fs.rmSync(copy, { force: true });
    fs.rmSync(`${copy}-wal`, { force: true });
    fs.rmSync(`${copy}-shm`, { force: true });
  }
}

const passed = results.filter((r) => r.caught).length + (baseOk ? 1 : 0);
const total = results.length + 1;
console.log(`\n[verify] ${passed}/${total} 通过`);

if (passed !== total) {
  console.log('\n有变异未被捕获，说明对应检查形同虚设。');
  process.exit(1);
}
