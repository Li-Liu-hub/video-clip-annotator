#!/usr/bin/env node
/**
 * 不变量检查器。
 *
 * 与其他检查手段的分工：
 *   - 数据库约束：防「写入时违反」，但防不了已经写进去的脏数据
 *   - 单元测试：跑在 :memory: 上，从没碰过真实库
 *   - 本脚本：对**运行中的库**做断言，包括种子数据与生产数据
 *
 * 用法：npm run db:check
 * 退出码非 0 表示存在违反。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DATABASE_PATH ?? path.join(ROOT, 'data', 'app.db');

const db = new Database(DB_PATH, { readonly: true });
db.pragma('foreign_keys = ON');

const checks = [];
const add = (name, fn) => checks.push({ name, fn });

/** 返回违规样本，空数组表示通过 */
function violations(sql, params = []) {
  return db.prepare(sql).all(...params);
}

// ① 无跨租户污染
add('segments 的租户与所属任务一致', () =>
  violations(`
    SELECT s.id, s.tenant_id, t.tenant_id AS task_tenant
      FROM segments s JOIN tasks t ON t.id = s.task_id
     WHERE s.tenant_id <> t.tenant_id
     LIMIT 5`),
);

add('submissions 的租户与所属任务一致', () =>
  violations(`
    SELECT s.id FROM submissions s JOIN tasks t ON t.id = s.task_id
     WHERE s.tenant_id <> t.tenant_id LIMIT 5`),
);

add('ledger 的租户与提交记录一致', () =>
  violations(`
    SELECT l.id FROM ledger_entries l JOIN submissions s ON s.id = l.submission_id
     WHERE l.tenant_id <> s.tenant_id LIMIT 5`),
);

add('task 的租户与其领取人所属租户一致', () =>
  violations(`
    SELECT t.id FROM tasks t JOIN users u ON u.id = t.claimed_by
     WHERE t.claimed_by IS NOT NULL AND u.tenant_id <> t.tenant_id LIMIT 5`),
);

// ② 同任务内无重叠
add('同一任务内不存在重叠区间', () =>
  violations(`
    SELECT a.task_id, a.start_ms, a.end_ms, b.start_ms AS b_start, b.end_ms AS b_end
      FROM segments a JOIN segments b
        ON a.task_id = b.task_id AND a.id < b.id
     WHERE a.start_ms < b.end_ms AND a.end_ms > b.start_ms
     LIMIT 5`),
);

// ③ 每条账本都能追溯
add('每条账本都有对应的提交记录', () =>
  violations(`
    SELECT l.id FROM ledger_entries l
     LEFT JOIN submissions s ON s.id = l.submission_id
     WHERE s.id IS NULL LIMIT 5`),
);

// ④ 账本与快照守恒（按任务）
add('每个任务的账本净额与状态相符', () =>
  violations(`
    WITH net AS (
      SELECT task_id, SUM(delta_ms) AS delta FROM ledger_entries GROUP BY task_id
    ),
    current_sub AS (
      SELECT task_id, total_ms FROM submissions WHERE superseded_by IS NULL
    )
    SELECT t.id, t.status, COALESCE(net.delta, 0) AS ledger_net,
           COALESCE(current_sub.total_ms, 0) AS current_total
      FROM tasks t
      LEFT JOIN net         ON net.task_id = t.id
      LEFT JOIN current_sub ON current_sub.task_id = t.id
     WHERE (t.status = 'submitted' AND COALESCE(net.delta, 0) <> COALESCE(current_sub.total_ms, 0))
        OR (t.status <> 'submitted' AND COALESCE(net.delta, 0) <> 0)
     LIMIT 5`),
);

// ⑤ 快照内容与 total_ms 自洽
add('提交的 total_ms 等于快照内各段之和', () => {
  const rows = db.prepare('SELECT id, total_ms, segments_json FROM submissions').all();
  const bad = [];
  for (const r of rows) {
    let segs;
    try {
      segs = JSON.parse(r.segments_json);
    } catch {
      bad.push({ id: r.id, reason: 'JSON 无法解析' });
      continue;
    }
    const sum = segs.reduce((acc, s) => acc + (s.endMs - s.startMs), 0);
    if (sum !== r.total_ms) bad.push({ id: r.id, expect: sum, actual: r.total_ms });
    if (segs.length === 0) bad.push({ id: r.id, reason: '空快照' });
  }
  return bad.slice(0, 5);
});

// ⑥ 已提交任务恰有一个有效提交
add('已提交任务恰有一个未被取代的提交', () =>
  violations(`
    SELECT t.id, COUNT(s.id) AS n
      FROM tasks t LEFT JOIN submissions s
        ON s.task_id = t.id AND s.superseded_by IS NULL
     WHERE t.status = 'submitted'
     GROUP BY t.id HAVING n <> 1
     LIMIT 5`),
);

// ⑦ 角色与租户约束
add('管理员不属于租户、标注员必须有租户', () =>
  violations(`
    SELECT id, role, tenant_id FROM users
     WHERE (role = 'admin' AND tenant_id IS NOT NULL)
        OR (role = 'annotator' AND tenant_id IS NULL)
        OR (role NOT IN ('admin', 'annotator'))
     LIMIT 5`),
);

add('每个标注员独占一个租户', () =>
  violations(`
    SELECT tenant_id, COUNT(*) AS n FROM users
     WHERE role = 'annotator' AND tenant_id IS NOT NULL
     GROUP BY tenant_id HAVING n > 1 LIMIT 5`),
);

// ⑧ 状态与领取人一致
add('状态与领取人字段同步', () =>
  violations(`
    SELECT id, status, claimed_by FROM tasks
     WHERE (status = 'pending' AND claimed_by IS NOT NULL)
        OR (status <> 'pending' AND claimed_by IS NULL)
     LIMIT 5`),
);

// ⑨ 日期格式与逻辑一致
add('ledger 的 entry_date 格式合法', () =>
  violations(`
    SELECT id, entry_date FROM ledger_entries
     WHERE entry_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
     LIMIT 5`),
);

add('ledger 的符号与类型一致', () =>
  violations(`
    SELECT id, kind, delta_ms FROM ledger_entries
     WHERE (kind = 'submit' AND delta_ms <= 0) OR (kind = 'revoke' AND delta_ms >= 0)
     LIMIT 5`),
);

// ── 执行 ──────────────────────────────────────
let failed = 0;
console.log(`[db:check] ${DB_PATH}\n`);

for (const { name, fn } of checks) {
  let bad;
  try {
    bad = fn();
  } catch (err) {
    console.log(`  !!  ${name}`);
    console.log(`      执行出错：${err.message}`);
    failed += 1;
    continue;
  }
  if (bad.length === 0) {
    console.log(`  ok  ${name}`);
  } else {
    console.log(`  !!  ${name}  (${bad.length} 条违规)`);
    for (const row of bad) console.log(`      ${JSON.stringify(row)}`);
    failed += 1;
  }
}

const total = checks.length;
console.log(`\n[db:check] ${total - failed}/${total} 项通过`);
db.close();
process.exit(failed === 0 ? 0 : 1);
