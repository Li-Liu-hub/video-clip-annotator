/**
 * ledger_entries 表：只追加的账本写入与单任务净额。
 *
 * 没有 update / delete —— 账本一旦写入就是统计的唯一依据，
 * 修正只能靠再记一条反向条目，历史日期因此永远不会被改写。
 */
import type { DB } from '@/lib/db';

export type LedgerEntryInsert = {
  id: string;
  tenantId: string;
  taskId: string;
  submissionId: string;
  annotatorId: string;
  /** 正=计入，负=冲正。符号必须与 kind 一致，schema 的 CHECK 会拒。 */
  deltaMs: number;
  /** 计入哪一天（YYYY-MM-DD）。冲正取原提交日，不是退回当天。 */
  entryDate: string;
  kind: 'submit' | 'revoke';
  createdAt: number;
};

/** 写账本条目。 */
export function insertEntry(db: DB, entry: LedgerEntryInsert): void {
  db.prepare(
    `INSERT INTO ledger_entries (id, tenant_id, task_id, submission_id, annotator_id,
                                 delta_ms, entry_date, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.tenantId,
    entry.taskId,
    entry.submissionId,
    entry.annotatorId,
    entry.deltaMs,
    entry.entryDate,
    entry.kind,
    entry.createdAt,
  );
}

/** 某任务的账本净额（毫秒）。退回成功后应为 0，是与提交快照对账的最小口径。 */
export function sumByTask(db: DB, taskId: string): number {
  // audit-ignore: 按 task_id 求净额，只用于核对单条任务，不产生跨租户统计
  const row = db
    .prepare('SELECT COALESCE(SUM(delta_ms), 0) AS total FROM ledger_entries WHERE task_id = ?')
    .get(taskId) as { total: number };
  return row.total;
}
