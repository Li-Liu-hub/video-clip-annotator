/**
 * I1 五组不变量：用真实写路径产数据，再验数据之间的关系。
 *
 * 「真实写路径」这条要求决定了两件事：
 *   1. 被验的业务数据（任务 / 片段 / 快照 / 账本）一律经 service 产生 ——
 *      claimTask / upsertSegment / submitTask / rejectTask / reopenTask，
 *      直接 INSERT 只能证明「我造的数据满足不变量」，证明不了「流程产出的数据满足」。
 *   2. 租户、用户、视频三类夹具仍直插：项目里没有它们的创建服务（setup.mjs 也直插），
 *      且它们不是本文件要验的对象。
 *
 * 唯一的另一处直插是「反例」：为了证明检查器真的会报，必须绕过 service 造脏数据。
 * 每处都标明「故意造脏」，并要求断言到具体 rule 与 subject —— 只断言「非空」的话，
 * 一条恒假规则也能让用例绿。
 */
import { describe, expect, it } from 'vitest';
import { createDb, type DB } from '@/lib/db';
import { createTasks, claimTask } from '@/lib/services/task-service';
import { upsertSegment } from '@/lib/services/segment-service';
import { submitTask } from '@/lib/services/submit-service';
import { rejectTask, reopenTask } from '@/lib/services/review-service';
import type { SessionUser, TenantUser } from '@/lib/services/auth-service';
import { assertInvariants, findViolations, type Violation } from '@/lib/invariants';

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbbbbbbbbbb';

const ADMIN_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
const BOB_ID = '4444444444444444';

const VIDEO_ID = 'ddddddddddddddd1';
const VIDEO_MS = 60_000;

const PASSWORD_HASH = 'scrypt$00$00';
const NOW = Date.UTC(2026, 9, 20, 2, 0);

const ADMIN: SessionUser = {
  id: ADMIN_ID,
  username: 'admin',
  displayName: '平台管理员',
  role: 'admin',
  tenantId: null,
  tenantName: null,
  timezone: 'Asia/Shanghai',
};

const ALICE: TenantUser = {
  id: ALICE_ID,
  username: 'alice',
  displayName: '林小雨',
  role: 'annotator',
  tenantId: TENANT_A,
  tenantName: 'A 空间',
  timezone: 'Asia/Shanghai',
};

/** 两段合计 6500ms：刻意不等于视频时长，用来区分「标了多少」与「视频多长」 */
const SEGMENTS = [
  { startMs: 1_000, endMs: 5_000 },
  { startMs: 10_000, endMs: 12_500 },
];
const TOTAL_MS = 6_500;

const REASON = '片段边界偏了 2 秒，请重新标注';

function fixtureDb(): DB {
  const db = createDb(':memory:');

  const insertTenant = db.prepare(
    'INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)',
  );
  insertTenant.run(TENANT_A, 'A 空间', 'Asia/Shanghai', NOW);
  insertTenant.run(TENANT_B, 'B 空间', 'Asia/Shanghai', NOW);

  const insertUser = db.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run(ADMIN_ID, null, 'admin', '平台管理员', PASSWORD_HASH, 'admin', NOW);
  insertUser.run(ALICE_ID, TENANT_A, 'alice', '林小雨', PASSWORD_HASH, 'annotator', NOW);
  insertUser.run(BOB_ID, TENANT_B, 'bob', '陈默', PASSWORD_HASH, 'annotator', NOW);

  db.prepare(
    `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
     VALUES (?, 'demo.mp4', 'demo.mp4', 1024, ?, 'video/mp4', ?, ?)`,
  ).run(VIDEO_ID, VIDEO_MS, ADMIN_ID, NOW);

  return db;
}

/** 建一条 pending 任务：走真实的 createTasks，不直插 tasks */
function newTask(db: DB, tenantId = TENANT_A): string {
  const { ids } = createTasks(db, ADMIN, {
    videoId: VIDEO_ID,
    tenantIds: [tenantId],
    title: '双臂协作 · 取杯与递送',
  });
  return ids[0];
}

/** 领取 + 标注：两步都走 service */
function annotate(db: DB, taskId: string): void {
  claimTask(db, ALICE, taskId);
  for (const segment of SEGMENTS) upsertSegment(db, ALICE, taskId, segment);
}

/** 完整链路的前半段：建任务 → 领取 → 标注 → 提交，返回提交 id */
function submitNewTask(db: DB, tenantId = TENANT_A): { taskId: string; submissionId: string } {
  const taskId = newTask(db, tenantId);
  annotate(db, taskId);
  return { taskId, submissionId: submitTask(db, ALICE, taskId).submissionId };
}

/** 退回后重新打开再提交：一次完整的「打回重做」 */
function rejectAndResubmit(db: DB, taskId: string): void {
  rejectTask(db, ADMIN, taskId, REASON);
  reopenTask(db, ALICE, taskId);
  submitTask(db, ALICE, taskId);
}

function rulesOf(violations: Violation[]): string[] {
  return violations.map((violation) => violation.rule);
}

function scalar(db: DB, sql: string, ...params: string[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/** 提交日由 service 按租户时区算出，直插账本时必须取同一天，否则造出来的脏数据会串味 */
function submittedDate(db: DB, submissionId: string): string {
  return (db.prepare('SELECT local_date FROM submissions WHERE id = ?').get(submissionId) as {
    local_date: string;
  }).local_date;
}

describe('I1 五组不变量', () => {
  it('空库里没有任何违反项（检查器不会恒抛）', () => {
    expect(findViolations(createDb(':memory:'))).toEqual([]);
  });

  it('领取、标注、提交之后数据仍自洽，且账本与快照各有一条', () => {
    const db = fixtureDb();
    const { taskId } = submitNewTask(db);

    expect([
      findViolations(db).length,
      scalar(db, 'SELECT COUNT(*) AS n FROM ledger_entries WHERE task_id = ?', taskId),
      scalar(db, 'SELECT COUNT(*) AS n FROM submissions WHERE task_id = ?', taskId),
    ]).toEqual([0, 1, 1]);
  });

  it('提交后退回，净额归零不为负，不变量仍成立', () => {
    const db = fixtureDb();
    const { taskId } = submitNewTask(db);
    rejectTask(db, ADMIN, taskId, REASON);

    expect([
      findViolations(db).length,
      scalar(db, 'SELECT COALESCE(SUM(delta_ms), 0) AS n FROM ledger_entries WHERE task_id = ?', taskId),
    ]).toEqual([0, 0]);
  });

  it('退回后重新打开并再次提交，只剩一条有效快照且净额等于新提交', () => {
    const db = fixtureDb();
    const { taskId } = submitNewTask(db);
    rejectAndResubmit(db, taskId);

    expect([
      findViolations(db).length,
      scalar(
        db,
        'SELECT COUNT(*) AS n FROM submissions WHERE task_id = ? AND superseded_by IS NULL',
        taskId,
      ),
      scalar(db, 'SELECT COALESCE(SUM(delta_ms), 0) AS n FROM ledger_entries WHERE task_id = ?', taskId),
    ]).toEqual([0, 1, TOTAL_MS]);
  });

  it('净额为负时报 ledger-non-negative，并指出是哪条任务', () => {
    const db = fixtureDb();
    const { taskId, submissionId } = submitNewTask(db);

    // 故意造脏：同一份提交再冲正两次，净额变成 -6500ms（schema 的符号 CHECK 仍然满足）
    const entryDate = submittedDate(db, submissionId);
    const insertRevoke = db.prepare(
      `INSERT INTO ledger_entries (id, tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'revoke', ?)`,
    );
    insertRevoke.run('e000000000000001', TENANT_A, taskId, submissionId, ALICE_ID, -TOTAL_MS, entryDate, NOW);
    insertRevoke.run('e000000000000002', TENANT_A, taskId, submissionId, ALICE_ID, -TOTAL_MS, entryDate, NOW);

    const violations = findViolations(db);
    expect(
      violations.filter((violation) => violation.rule === 'ledger-non-negative').map((v) => v.subject),
    ).toEqual([taskId]);
  });

  it('账本是同一份提交的两倍时报 ledger-sum，而逐条同源检查不误报', () => {
    const db = fixtureDb();
    const { taskId, submissionId } = submitNewTask(db);

    // 故意造脏：再记一笔金额完全正确的 submit —— 每条都对得上快照，只有合计不对
    db.prepare(
      `INSERT INTO ledger_entries (id, tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date, kind, created_at)
       VALUES ('e000000000000003', ?, ?, ?, ?, ?, ?, 'submit', ?)`,
    ).run(TENANT_A, taskId, submissionId, ALICE_ID, TOTAL_MS, submittedDate(db, submissionId), NOW);

    // 恰好只有 ledger-sum：证明它是「按任务合计」的判断，不是逐条判断的副产物
    expect(rulesOf(findViolations(db))).toEqual(['ledger-sum']);
  });

  it('同一任务有两条未被取代的快照时报 snapshot-unique', () => {
    const db = fixtureDb();
    const taskId = newTask(db);

    // 故意造脏：直接插两条 open 快照。pending 任务没有账本，故不会牵动其他规则
    const insertSnapshot = db.prepare(
      `INSERT INTO submissions (id, task_id, tenant_id, annotator_id, submitted_at, local_date,
                                total_ms, segment_count, segments_json, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-10-20', ?, 1, '[]', ?)`,
    );
    insertSnapshot.run('c000000000000001', taskId, TENANT_A, ALICE_ID, NOW, TOTAL_MS, NOW);
    insertSnapshot.run('c000000000000002', taskId, TENANT_A, ALICE_ID, NOW, TOTAL_MS, NOW);

    expect(rulesOf(findViolations(db))).toEqual(['snapshot-unique']);
  });

  it('账本日期与快照不一致时报 ledger-snapshot-match，净额合计仍然对得上', () => {
    const db = fixtureDb();
    const { taskId } = submitNewTask(db);
    rejectAndResubmit(db, taskId);

    const revokeId = (
      db.prepare("SELECT id FROM ledger_entries WHERE task_id = ? AND kind = 'revoke'").get(taskId) as {
        id: string;
      }
    ).id;

    // 故意造脏：只改冲正条目的日期。金额不变，故 ledger-sum 不会跟着报 ——
    // 这正是「逐条同源」与「按任务合计」两条规则各自独立生效的证据
    db.prepare("UPDATE ledger_entries SET entry_date = '2020-01-01' WHERE id = ?").run(revokeId);

    expect(findViolations(db).map((violation) => [violation.rule, violation.subject, violation.detail])).toEqual([
      ['ledger-snapshot-match', revokeId, expect.stringContaining('记账日 2020-01-01')],
    ]);
  });

  it('账本金额与快照不一致时报 ledger-snapshot-match', () => {
    const db = fixtureDb();
    const { taskId, submissionId } = submitNewTask(db);

    // 故意造脏：多记 1ms
    db.prepare(
      `INSERT INTO ledger_entries (id, tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date, kind, created_at)
       VALUES ('e000000000000004', ?, ?, ?, ?, ?, ?, 'submit', ?)`,
    ).run(TENANT_A, taskId, submissionId, ALICE_ID, TOTAL_MS + 1, submittedDate(db, submissionId), NOW);

    const match = findViolations(db).filter((violation) => violation.rule === 'ledger-snapshot-match');
    expect(match.map((violation) => violation.subject)).toEqual(['e000000000000004']);
  });

  it('冲正指向不存在的快照时报 ledger-snapshot-match', () => {
    const db = fixtureDb();
    const taskId = newTask(db);

    // 故意造脏：外键此刻必须关掉，否则这条「指向不存在的快照」根本插不进去。
    // 真实缺陷正是绕过应用层写进来的，这里模拟的是那个状态
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO ledger_entries (id, tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date, kind, created_at)
       VALUES ('e000000000000005', ?, ?, 'ffffffffffffffff', ?, ?, '2026-10-20', 'revoke', ?)`,
    ).run(TENANT_A, taskId, ALICE_ID, -TOTAL_MS, NOW);
    db.pragma('foreign_keys = ON');

    const match = findViolations(db).filter((violation) => violation.rule === 'ledger-snapshot-match');
    expect(match.map((violation) => [violation.subject, violation.detail])).toEqual([
      ['e000000000000005', 'revoke：指向的提交快照不存在'],
    ]);
  });

  it('submitted 却没有领取人时报 status-claimed-pair', () => {
    const db = fixtureDb();

    // 故意造脏：schema 的 CHECK 正是要防这条，所以必须临时关掉约束才能插进去。
    // 不用「先走完提交再改」：那样这条用例会依赖提交链路是否正常，
    // 而这条规则要独立于业务路径被验证
    db.pragma('ignore_check_constraints = ON');
    db.prepare(
      `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, created_by, created_at)
       VALUES ('a000000000000009', ?, ?, '任务', 'submitted', NULL, ?, ?)`,
    ).run(TENANT_A, VIDEO_ID, ADMIN_ID, NOW);
    db.pragma('ignore_check_constraints = OFF');

    expect(rulesOf(findViolations(db))).toEqual(['status-claimed-pair']);
  });

  it('片段的租户与任务不同时报 tenant-consistency', () => {
    const db = fixtureDb();
    const taskId = newTask(db);
    annotate(db, taskId);
    const segmentId = (db.prepare('SELECT id FROM segments WHERE task_id = ? LIMIT 1').get(taskId) as {
      id: string;
    }).id;

    // 故意造脏：片段表没有租户外键，应用层也不写别人的租户 —— 只能直改
    db.prepare('UPDATE segments SET tenant_id = ? WHERE id = ?').run(TENANT_B, segmentId);

    const violations = findViolations(db);
    expect(violations.map((violation) => [violation.rule, violation.subject])).toEqual([
      ['tenant-consistency', segmentId],
    ]);
  });

  it('提交快照的租户与任务不同时报 tenant-consistency', () => {
    const db = fixtureDb();
    const { submissionId } = submitNewTask(db);

    // 故意造脏
    db.prepare('UPDATE submissions SET tenant_id = ? WHERE id = ?').run(TENANT_B, submissionId);

    expect(findViolations(db).map((violation) => [violation.rule, violation.subject])).toEqual([
      ['tenant-consistency', submissionId],
    ]);
  });

  it('账目的租户与任务不同时报 tenant-consistency', () => {
    const db = fixtureDb();
    const { taskId } = submitNewTask(db);
    const ledgerId = (db.prepare('SELECT id FROM ledger_entries WHERE task_id = ? LIMIT 1').get(taskId) as {
      id: string;
    }).id;

    // 故意造脏
    db.prepare('UPDATE ledger_entries SET tenant_id = ? WHERE id = ?').run(TENANT_B, ledgerId);

    expect(findViolations(db).map((violation) => [violation.rule, violation.subject])).toEqual([
      ['tenant-consistency', ledgerId],
    ]);
  });

  it('干净数据上 assertInvariants 不抛', () => {
    const db = fixtureDb();
    submitNewTask(db);

    expect(() => assertInvariants(db)).not.toThrow();
  });

  it('有违反时 assertInvariants 抛错，消息只带前三条', () => {
    const db = fixtureDb();

    // 三条任务各标两段，共 6 条片段；故意造脏：全部改成别的租户 → 6 条违反项
    const taskIds = [newTask(db), newTask(db), newTask(db)];
    for (const taskId of taskIds) annotate(db, taskId);
    const segmentIds = (
      db.prepare('SELECT id FROM segments ORDER BY id').all() as { id: string }[]
    ).map((row) => row.id);
    for (const taskId of taskIds) {
      db.prepare('UPDATE segments SET tenant_id = ? WHERE task_id = ?').run(TENANT_B, taskId);
    }

    // 违反项顺序由 SQL 的 ORDER BY subject 决定，故按 id 排序取前三条作为期望
    const sorted = [...segmentIds].sort();

    const reason = (() => {
      try {
        assertInvariants(db);
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();

    expect([
      reason.startsWith(`数据不变量被破坏 6 项：[tenant-consistency] ${sorted[0]}：`),
      sorted.slice(0, 3).every((id) => reason.includes(id)),
      reason.includes(sorted[5]),
    ]).toEqual([true, true, false]);
  });
});

describe('I-3 的五个合取项各自独立生效', () => {
  it('submit 账目的日期与快照明不同时报 ledger-snapshot-match', () => {
    // 删掉这条合取项，本用例必须变红。早先它没有夹具，
    // reviewer 变异后 16/16 全绿 —— 等于「只实现了金额那一半」
    const db = fixtureDb();
    const { submissionId } = submitNewTask(db);
    db.prepare("UPDATE ledger_entries SET entry_date = '2020-01-01' WHERE submission_id = ?").run(
      submissionId,
    );

    expect(rulesOf(findViolations(db))).toEqual(['ledger-snapshot-match']);
  });

  it('submit 账目与快照分属不同任务时报 ledger-snapshot-match', () => {
    const db = fixtureDb();
    const { submissionId } = submitNewTask(db);
    const other = newTask(db);
    db.prepare('UPDATE ledger_entries SET task_id = ? WHERE submission_id = ?').run(other, submissionId);

    // 账目挪走后原任务净额变 0、新任务凭空多出净额 —— 连带两条 ledger-sum，
    // 这是真实且正确的连带。排序后比：规则产出顺序取决于 Map 遍历
    expect(rulesOf(findViolations(db)).sort()).toEqual(
      ['ledger-snapshot-match', 'ledger-sum', 'ledger-sum'].sort(),
    );
  });

  it('revoke 的金额不是快照金额的相反数时报 ledger-snapshot-match', () => {
    const db = fixtureDb();
    const { taskId } = submitNewTask(db);
    rejectTask(db, ADMIN, taskId, REASON);
    db.prepare("UPDATE ledger_entries SET delta_ms = -1 WHERE kind = 'revoke' AND task_id = ?").run(taskId);

    // 冲正少冲了 6499ms，净额也不再是 0 —— 两条规则同时成立
    expect(rulesOf(findViolations(db)).sort()).toEqual(
      ['ledger-snapshot-match', 'ledger-sum'].sort(),
    );
  });

  it('rejected 的任务净额仍为正时报 ledger-sum', () => {
    // 这条守的是「无有效提交时净额必须为 0」那半条规则。
    // 退回只冲一笔，再补一笔 submit 就等于凭空多算一份工作量
    const db = fixtureDb();
    const { taskId, submissionId } = submitNewTask(db);
    rejectTask(db, ADMIN, taskId, REASON);
    // 金额必须与快照一致：这条用例只该验「净额不该为正」，
    // 金额写错会连带触发 ledger-snapshot-match，断言就不再指向单一规则
    const total = (
      db.prepare('SELECT total_ms FROM submissions WHERE id = ?').get(submissionId) as { total_ms: number }
    ).total_ms;
    db.prepare(
      `INSERT INTO ledger_entries
         (id, tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date, kind, created_at)
       VALUES ('e0000000000000f1', ?, ?, ?, ?, ?, ?, 'submit', ?)`,
    ).run(TENANT_A, taskId, submissionId, ALICE_ID, total, submittedDate(db, submissionId), NOW);

    expect(rulesOf(findViolations(db))).toEqual(['ledger-sum']);
  });

  it('pending 却带着领取人时报 status-claimed-pair', () => {
    // 另一个方向：上面那条只验了「非 pending 却没有领取人」。
    // 只测一个方向的话，把规则写成单向谓词不会有任何用例变红
    const db = fixtureDb();
    const taskId = newTask(db);

    db.pragma('ignore_check_constraints = ON');
    db.prepare('UPDATE tasks SET claimed_by = ? WHERE id = ?').run(ALICE_ID, taskId);
    db.pragma('ignore_check_constraints = OFF');

    expect(rulesOf(findViolations(db))).toEqual(['status-claimed-pair']);
  });
});
