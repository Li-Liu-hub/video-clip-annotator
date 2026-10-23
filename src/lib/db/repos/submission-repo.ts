/**
 * submissions 表读取：定位任务「当前有效」的提交快照，供退回时取冲正金额与提交日。
 *
 * 只读 —— 提交动作（E3）尚未实现，写入入口等到那一步再加。
 */
import type { DB } from '@/lib/db';

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
