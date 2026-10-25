#!/usr/bin/env node
/**
 * 结构检查器：schema 该保证、但 SQLite 表达不了的那 8 条。
 *
 * 与其他检查手段的分工：
 *   - 数据库约束：防「写入时违反」，但防不了已经写进去的脏数据
 *   - 单元测试：跑在 :memory: 上，从没碰过真实库
 *   - 本脚本：对**运行中的库**做断言，包括种子数据与生产数据
 *   - invariant:check：业务不变量（账本守恒、非负、快照唯一、跨表租户…）
 *
 * 为什么业务不变量不在这里：它们要跨表算合计、要把行解释成人话，
 * 写在 SQL 脚本里就会出现「同一个口径两处各写一遍」—— 一方改了另一方不会变红。
 * 那部分以 src/lib/invariants.ts 为唯一实现，这里只留结构与格式检查，两者不重叠。
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

// ① 租户归属：任务与其领取人的租户一致。
// 片段 / 快照 / 账目的跨表租户比对在 invariant:check（那三条与它重叠，只保留一份）
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

// 快照自洽与唯一：唯一实现在 invariant:check（snapshot-total / snapshot-unique）。
//
// 这两条曾经在这里各写一份，靠注释约束「改口径要同时改两处」——
// 实际结果是变异只喂给其中一套，另一套删掉也不会变红。
// 现在 db:verify-checker 的两个快照变异都指向 business 检查器，
// 结构检查器不再重复实现；它能抓的仍是「结构与格式」这一类。

// ④ 角色与租户约束
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

// ⑤ 状态与领取人一致
add('状态与领取人字段同步', () =>
  violations(`
    SELECT id, status, claimed_by FROM tasks
     WHERE (status = 'pending' AND claimed_by IS NOT NULL)
        OR (status <> 'pending' AND claimed_by IS NULL)
     LIMIT 5`),
);

// ⑥ 日期格式与符号一致
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
console.log(`[db:check] ${DB_PATH}`);
console.log('[db:check] 结构检查；业务不变量见 npm run invariant:check\n');

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
