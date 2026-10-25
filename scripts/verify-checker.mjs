#!/usr/bin/env node
/**
 * 对「不变量检查器」本身做变异验证。
 *
 * 检查器全绿只说明数据干净，不说明检查器有牙。
 * 本脚本在数据库副本上故意制造各类违规，逐一确认**指定的那个**检查器能抓到：
 *   - structure：scripts/check-invariants.mjs（db:check，结构检查）
 *   - business ：scripts/invariant-check.mjs（invariant:check，业务不变量）
 *
 * 为什么变异要指定检查器：两套检查器分工不同，业务不变量只有 invariant.ts 一份实现。
 * 若变异仍只喂给旧套，就等于「合并之后新套没有任何变异验证」——
 * 把某条规则删掉不会有任何用例变红。
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

const CHECKERS = {
  structure: { script: path.join(ROOT, 'scripts', 'check-invariants.mjs'), label: 'db:check' },
  business: { script: path.join(ROOT, 'scripts', 'invariant-check.mjs'), label: 'invariant:check' },
};

if (!fs.existsSync(SRC_DB)) {
  console.error('[verify] 找不到数据库，请先 npm run db:reset');
  process.exit(1);
}

const mutations = [
  {
    name: '跨租户污染（片段）',
    checker: 'business',
    expect: '[tenant-consistency]',
    apply(db) {
      const row = db
        .prepare('SELECT s.id FROM segments s JOIN tasks t ON t.id = s.task_id LIMIT 1')
        .get();
      db.prepare("UPDATE segments SET tenant_id = 'ffffffffffffffff' WHERE id = ?").run(row.id);
    },
  },
  {
    name: '账本净额与任务状态不符',
    checker: 'business',
    expect: '[ledger-sum]',
    apply(db) {
      const row = db.prepare("SELECT id, delta_ms FROM ledger_entries WHERE kind = 'submit' LIMIT 1").get();
      db.prepare('UPDATE ledger_entries SET delta_ms = ? WHERE id = ?').run(row.delta_ms + 5000, row.id);
    },
  },
  {
    name: '净额被冲成负数',
    checker: 'business',
    expect: '[ledger-non-negative]',
    apply(db) {
      const row = db
        .prepare(
          "SELECT tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date FROM ledger_entries WHERE kind = 'submit' LIMIT 1",
        )
        .get();
      db.prepare(
        `INSERT INTO ledger_entries
           (id, tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date, kind, created_at)
         VALUES ('eeeeeeeeeeeeeee1', ?, ?, ?, ?, ?, ?, 'revoke', ?)`,
      ).run(
        row.tenant_id,
        row.task_id,
        row.submission_id,
        row.annotator_id,
        // 冲掉两倍：净额变成 -delta，符号 CHECK 仍然满足
        -row.delta_ms * 2,
        row.entry_date,
        Date.now(),
      );
    },
  },
  {
    name: '同一任务两条有效快照',
    checker: 'business',
    expect: '[snapshot-unique]',
    apply(db) {
      const row = db.prepare('SELECT * FROM submissions WHERE superseded_by IS NULL LIMIT 1').get();
      db.prepare(
        `INSERT INTO submissions
           (id, task_id, tenant_id, annotator_id, submitted_at, local_date, total_ms,
            segment_count, segments_json, superseded_by, created_at)
         VALUES ('ccccccccccccccc1', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        row.task_id,
        row.tenant_id,
        row.annotator_id,
        row.submitted_at,
        row.local_date,
        row.total_ms,
        row.segment_count,
        row.segments_json,
        row.created_at,
      );
    },
  },
  {
    name: '快照 total_ms 与内容不符',
    checker: 'structure',
    expect: '提交的 total_ms 等于快照内各段之和',
    apply(db) {
      const row = db.prepare('SELECT id, total_ms FROM submissions LIMIT 1').get();
      db.prepare('UPDATE submissions SET total_ms = ? WHERE id = ?').run(row.total_ms + 1, row.id);
    },
  },
  {
    name: '日期格式非法',
    checker: 'structure',
    expect: 'ledger 的 entry_date 格式合法',
    apply(db) {
      const row = db.prepare('SELECT id FROM ledger_entries LIMIT 1').get();
      db.prepare("UPDATE ledger_entries SET entry_date = '2026/10/22' WHERE id = ?").run(row.id);
    },
  },
  {
    name: '已提交任务缺少提交记录',
    checker: 'structure',
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

function runChecker(kind, dbPath) {
  const r = spawnSync(process.execPath, [CHECKERS[kind].script], {
    env: { ...process.env, DATABASE_PATH: dbPath },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// 基线：两套检查器在未变异时都必须全绿
let passed = 0;
const total = Object.keys(CHECKERS).length + mutations.length;

for (const [kind, checker] of Object.entries(CHECKERS)) {
  const copy = freshCopy(`baseline-${kind}`);
  const result = runChecker(kind, copy);
  fs.rmSync(copy, { force: true });

  const ok = result.code === 0;
  console.log(`[verify] 基线（未变异）· ${checker.label}`);
  console.log(`  ${ok ? 'ok ' : '!! '} 检查器在干净数据上应当全绿  — exit=${result.code}`);
  if (!ok) console.log(result.out);
  if (ok) passed += 1;
}

console.log('\n[verify] 变异验证');
for (const m of mutations) {
  const copy = freshCopy(m.name.slice(0, 6));
  try {
    const db = new Database(copy);
    m.apply(db);
    db.close();

    const result = runChecker(m.checker, copy);
    const caught = result.code !== 0 && result.out.includes(m.expect);
    console.log(
      `  ${caught ? 'ok ' : '!! '} ${m.name}  →  ${CHECKERS[m.checker].label} · ${m.expect}`,
    );
    if (!caught) console.log(result.out.split('\n').filter((l) => l.includes('!!')).join('\n'));
    if (caught) passed += 1;
  } finally {
    fs.rmSync(copy, { force: true });
    fs.rmSync(`${copy}-wal`, { force: true });
    fs.rmSync(`${copy}-shm`, { force: true });
  }
}

console.log(`\n[verify] ${passed}/${total} 通过`);

if (passed !== total) {
  console.log('\n有变异未被捕获，说明对应检查形同虚设。');
  process.exit(1);
}
