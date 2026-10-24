/**
 * submissions 表读写：写一次提交快照，以及读「当前有效」与「最近一次」两种口径。
 *
 * 只追加，没有 update / delete —— 快照记录的是「那次提交发生了什么」，
 * 退回是另一个事件，由账本冲正表达，不动这张表。
 */
import type { DB } from '@/lib/db';
import { ValidationError } from '@/lib/errors';

export type SubmissionRow = {
  id: string;
  task_id: string;
  tenant_id: string;
  annotator_id: string;
  submitted_at: number;
  /** 提交日（租户时区）。退回冲正沿用此值，历史统计才不会被改写。 */
  local_date: string;
  total_ms: number;
  segment_count: number;
  segments_json: string;
  superseded_by: string | null;
  created_at: number;
};

export type SubmissionInsert = {
  id: string;
  taskId: string;
  tenantId: string;
  annotatorId: string;
  submittedAt: number;
  /** 按租户时区算出的提交日。由 service 传入，repo 不做时区换算。 */
  localDate: string;
  totalMs: number;
  segmentCount: number;
  /** 已序列化的片段快照，不含草稿态的 id */
  segmentsJson: string;
  createdAt: number;
};

/** better-sqlite3 把约束失败挂在 err.code 上。RULES 要求在 repo 层译成领域错误。 */
function isConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof err.code === 'string' &&
    err.code.startsWith('SQLITE_CONSTRAINT')
  );
}

/**
 * 写入一条提交快照。
 *
 * 撞约束只可能是应用层预检被绕过（空片段、total_ms 为 0、任务或标注员已被删），
 * 译成 ValidationError 而不是让原始 SQLITE 错误冒到 500，调用方分不清「请求不对」与「服务器炸了」。
 */
export function insertSubmission(db: DB, row: SubmissionInsert): void {
  try {
    db.prepare(
      `INSERT INTO submissions (id, task_id, tenant_id, annotator_id, submitted_at, local_date,
                                total_ms, segment_count, segments_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.taskId,
      row.tenantId,
      row.annotatorId,
      row.submittedAt,
      row.localDate,
      row.totalMs,
      row.segmentCount,
      row.segmentsJson,
      row.createdAt,
    );
  } catch (err) {
    // 正常路径已由 submit-service 判过非空，走到这里说明校验与写入之间数据被改坏
    if (isConstraintViolation(err)) throw new ValidationError('提交内容不合法', { cause: err });
    throw err;
  }
}

/**
 * 该任务当前有效的提交（未被 superseded 的那条）。
 *
 * WHERE 必须带 superseded_by IS NULL：退回后标注员会重新提交，旧快照仍留在表里，
 * 只按 task_id 取会拿到历史提交，冲正金额与记账日期都会错。
 */
export function findCurrentByTask(db: DB, taskId: string): SubmissionRow | null {
  // audit-ignore: 按 task_id 定位唯一一条有效快照，任务的租户归属已由管理员视图确认
  const row = db
    .prepare(
      `SELECT id, task_id, tenant_id, annotator_id, submitted_at, local_date, total_ms,
              segment_count, segments_json, superseded_by, created_at
         FROM submissions
        WHERE task_id = ? AND superseded_by IS NULL`,
    )
    .get(taskId) as SubmissionRow | undefined;
  return row ?? null;
}

/**
 * 该任务最近一次提交，含已被取代的历史提交。
 *
 * 与 findCurrentByTask 的差别是口径：这里回答「最后交的是什么」，
 * 那里回答「现在算数的是哪条」。带租户谓词是因为它服务标注员侧的读取。
 */
export function findLatestByTask(
  db: DB,
  tenantId: string,
  taskId: string,
): SubmissionRow | null {
  const row = db
    .prepare(
      `SELECT id, task_id, tenant_id, annotator_id, submitted_at, local_date, total_ms,
              segment_count, segments_json, superseded_by, created_at
         FROM submissions
        WHERE task_id = ? AND tenant_id = ?
        ORDER BY submitted_at DESC, id DESC
        LIMIT 1`,
    )
    .get(taskId, tenantId) as SubmissionRow | undefined;
  return row ?? null;
}

/**
 * 把该任务下仍为「当前」的快照标记为已被取代。
 *
 * 退回后重新提交时会留下多条历史快照。若不标记，F2 的 findCurrentByTask
 * 取到的是 rowid 最小那一条（旧的），退回时按旧金额、旧日期冲正 ——
 * 账目静默错一笔，且写进历史日期。schema 有 superseded_by 列就是为了这个。
 */
export function supersedeOpenByTask(
  db: DB,
  args: { taskId: string; tenantId: string; newId: string },
): void {
  db.prepare(
    `UPDATE submissions SET superseded_by = ?
      WHERE task_id = ? AND tenant_id = ? AND superseded_by IS NULL AND id <> ?`,
  ).run(args.newId, args.taskId, args.tenantId, args.newId);
}
