/**
 * 不变量检查的只读取数。
 *
 * 为什么单独成一层：RULES 规定 SQL 只出现在 repos 层，检查器不是例外 ——
 * 把六条规则写成 repo 函数后，src/lib/invariants.ts 只负责「把行解释成违反项」，
 * 判断与取数分开，改规则时不会顺手改错另一条。
 *
 * 为什么这里的 SQL 不带 tenant_id 谓词：不变量检查要跨全部租户扫，
 * tenant_id 在这些查询里是**被测对象**而不是访问范围。加谓词就永远查不出
 * 「这一行的租户与任务不一致」—— 那正是要抓的东西。故每条都标 audit-ignore。
 */
import type { DB } from '@/lib/db';
import type { TaskStatus } from './task-repo';

/** 账本净额与「当前有效提交」对不上的任务。 */
export type TaskBalanceRow = {
  task_id: string;
  status: TaskStatus;
  net: number;
  expected: number;
};

/** 净额为负的任务。 */
export type NegativeNetRow = { task_id: string; net: number };

/** 同一任务下存在多条未被取代的快照。ids 是逗号分隔的快照 id，便于直接去库里查。 */
export type MultiOpenSnapshotRow = { task_id: string; open_count: number; ids: string };

/**
 * 账本条目与其指向的快照对不上。
 * 快照侧字段可空：账目指向的快照不存在时 LEFT JOIN 出全 NULL。
 */
export type LedgerSnapshotRow = {
  id: string;
  kind: 'submit' | 'revoke';
  delta_ms: number;
  entry_date: string;
  task_id: string;
  snapshot_id: string | null;
  snapshot_total_ms: number | null;
  snapshot_local_date: string | null;
  snapshot_task_id: string | null;
};

/** 状态与领取人不同步的任务。 */
export type ClaimedPairRow = { id: string; status: TaskStatus; claimed_by: string | null };

/** 租户与所属任务不一致的行。relation 用领域名，报告里直接可读。 */
export type TenantMismatchRow = {
  relation: 'segments' | 'submissions' | 'ledger';
  subject: string;
  row_tenant: string;
  task_tenant: string;
  task_id: string;
};

/** 快照金额核对的取数：segments_json 原样取出，在 TS 侧解析（SQL 里没有可靠的 JSON 求和回退）。 */
export type SnapshotTotalRow = { id: string; total_ms: number; segments_json: string };

/**
 * 净额与当前有效提交对不上。
 *
 * 不写 `net = SUM(delta_ms)` 那种式子：两边同一个表达式，恒真，永远不报。
 * 可被证伪的口径是「净额 = 当前有效提交的金额；没有有效提交时必须为 0」——
 * 它同时能抓到「计入的是旧快照的金额」「状态已退回但没冲正」。
 */
export function listTaskBalanceMismatches(db: DB): TaskBalanceRow[] {
  // audit-ignore: 不变量检查跨全部租户，租户不是访问范围
  return db
    .prepare(
      `WITH net AS (
         SELECT task_id, SUM(delta_ms) AS net FROM ledger_entries GROUP BY task_id
       ),
       open_sub AS (
         SELECT task_id, SUM(total_ms) AS total
           FROM submissions WHERE superseded_by IS NULL GROUP BY task_id
       )
       SELECT t.id     AS task_id,
              t.status AS status,
              COALESCE(net.net, 0) AS net,
              CASE WHEN t.status = 'submitted'
                   THEN COALESCE(open_sub.total, 0) ELSE 0 END AS expected
         FROM tasks t
         LEFT JOIN net      ON net.task_id = t.id
         LEFT JOIN open_sub ON open_sub.task_id = t.id
        WHERE COALESCE(net.net, 0) <> CASE WHEN t.status = 'submitted'
                                           THEN COALESCE(open_sub.total, 0) ELSE 0 END
        ORDER BY t.id`,
    )
    .all() as TaskBalanceRow[];
}

/** 净额为负：冲正超过了已计入的量，属缺陷而非业务状态。 */
export function listNegativeNets(db: DB): NegativeNetRow[] {
  // audit-ignore: 不变量检查跨全部租户，租户不是访问范围
  return db
    .prepare(
      `SELECT task_id, SUM(delta_ms) AS net
         FROM ledger_entries
        GROUP BY task_id
       HAVING SUM(delta_ms) < 0
        ORDER BY task_id`,
    )
    .all() as NegativeNetRow[];
}

/**
 * 有效快照数量不对的任务。
 *
 * 两种情况都要报，早先只判了 `> 1`：
 *
 * - `submitted` 的任务必须有**恰好一条**有效快照。等于 0 意味着「提交了但没有存档」，
 *   账本上却有金额 —— `db:check` 的旧实现抓到过这种，合并时不能只留 `> 1` 那半。
 * - 任何任务都不该有**多于一条**有效快照（提交两次而旧快照没被标记 superseded）。
 *
 * 一条 SQL 覆盖两者：submitted 要求 `= 1`，其余要求 `<= 1`。
 * 写成一个 HAVING 而不是两条规则，是因为它们回答的是同一个问题：
 * 「这个任务的有效快照数对吗」。
 */
export function listTasksWithBadOpenSnapshotCount(db: DB): MultiOpenSnapshotRow[] {
  // audit-ignore: 不变量检查跨全部租户，租户不是访问范围
  return db
    .prepare(
      `SELECT t.id AS task_id, COUNT(s.id) AS open_count, GROUP_CONCAT(s.id) AS ids
         FROM tasks t
         LEFT JOIN submissions s ON s.task_id = t.id AND s.superseded_by IS NULL
        GROUP BY t.id, t.status
       HAVING (t.status = 'submitted' AND COUNT(s.id) <> 1)
           OR COUNT(s.id) > 1
        ORDER BY t.id`,
    )
    .all() as MultiOpenSnapshotRow[];
}

/**
 * 账本与快照不同源。
 *
 * submit：金额、日期、任务三者都要与快照一致。
 * revoke：指向的快照必须存在，且金额互为相反数、日期仍是原提交日、任务一致。
 * 两条合在一条 SQL 里，是为了让「漏掉 revoke」这种改法能立刻被 diff 看出来。
 */
export function listLedgerSnapshotMismatches(db: DB): LedgerSnapshotRow[] {
  // audit-ignore: 不变量检查跨全部租户，租户不是访问范围
  return db
    .prepare(
      `SELECT l.id           AS id,
              l.kind         AS kind,
              l.delta_ms     AS delta_ms,
              l.entry_date   AS entry_date,
              l.task_id      AS task_id,
              s.id           AS snapshot_id,
              s.total_ms     AS snapshot_total_ms,
              s.local_date   AS snapshot_local_date,
              s.task_id      AS snapshot_task_id
         FROM ledger_entries l
         LEFT JOIN submissions s ON s.id = l.submission_id
        WHERE (l.kind = 'submit' AND (
                 s.id IS NULL
                 OR s.total_ms   <> l.delta_ms
                 OR s.local_date <> l.entry_date
                 OR s.task_id    <> l.task_id))
           OR (l.kind = 'revoke' AND (
                 s.id IS NULL
                 OR -l.delta_ms  <> s.total_ms
                 OR s.local_date <> l.entry_date
                 OR s.task_id    <> l.task_id))
        ORDER BY l.id`,
    )
    .all() as LedgerSnapshotRow[];
}

/**
 * 状态与领取人必须同时成立。
 *
 * 写成 `(status = 'pending') <> (claimed_by IS NULL)` 而不是两段 OR：
 * 一段表达式天然覆盖「pending 却有领取人」与「非 pending 却没有领取人」两种，
 * 加状态时不会漏掉新状态的分支。
 */
export function listClaimedPairMismatches(db: DB): ClaimedPairRow[] {
  // audit-ignore: 不变量检查跨全部租户，租户不是访问范围
  return db
    .prepare(
      `SELECT id, status, claimed_by
         FROM tasks
        WHERE (status = 'pending') <> (claimed_by IS NULL)
        ORDER BY id`,
    )
    .all() as ClaimedPairRow[];
}

/** 片段 / 提交快照 / 账目三处的租户与所属任务不一致。 */
export function listTenantMismatches(db: DB): TenantMismatchRow[] {
  // audit-ignore: 不变量检查跨全部租户，不一致本身就是被测对象
  return db
    .prepare(
      `SELECT 'segments' AS relation, s.id AS subject, s.tenant_id AS row_tenant,
              t.tenant_id AS task_tenant, s.task_id AS task_id
         FROM segments s JOIN tasks t ON t.id = s.task_id
        WHERE s.tenant_id <> t.tenant_id
        UNION ALL
       SELECT 'submissions', s.id, s.tenant_id, t.tenant_id, s.task_id
         FROM submissions s JOIN tasks t ON t.id = s.task_id
        WHERE s.tenant_id <> t.tenant_id
        UNION ALL
       SELECT 'ledger', l.id, l.tenant_id, t.tenant_id, l.task_id
         FROM ledger_entries l JOIN tasks t ON t.id = l.task_id
        WHERE l.tenant_id <> t.tenant_id
        ORDER BY relation, subject`,
    )
    .all() as TenantMismatchRow[];
}

/**
 * 所有快照的金额与内容，供「快照自洽」核对。
 *
 * 求和放在 TS 侧而不是 SQL：segments_json 可能被写坏成非 JSON，
 * 那样 json_each 会直接抛错，把「一条坏数据」变成「整个检查器崩掉」；
 * 而 TS 侧能把它报成一条违反项。含已被取代的历史快照 —— 退回冲正按它们的金额算。
 */
export function listSnapshotTotals(db: DB): SnapshotTotalRow[] {
  // audit-ignore: 不变量检查跨全部租户，租户不是访问范围
  return db
    .prepare('SELECT id, total_ms, segments_json FROM submissions ORDER BY id')
    .all() as SnapshotTotalRow[];
}
