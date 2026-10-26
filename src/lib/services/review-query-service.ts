/** 管理员审核读取：按提交版本读取冻结片段，避免退回后的草稿污染历史。 */
import { withBasePath } from '@/lib/base-path';
import type { DB } from '@/lib/db';
import { listForReview } from '@/lib/db/repos/submission-repo';
import { findById } from '@/lib/db/repos/task-repo';
import { ForbiddenError, NotFoundError, StateConflictError } from '@/lib/errors';
import type { SessionUser } from './auth-service';

export type ReviewSegment = { startMs: number; endMs: number; label: string | null };
export type ReviewSubmission = {
  id: string;
  displayName: string;
  submittedAt: number;
  date: string;
  totalMs: number;
  segments: ReviewSegment[];
};
export type TaskReview = {
  taskId: string;
  title: string;
  tenantName: string;
  status: string;
  rejectReason: string | null;
  videoFilename: string;
  durationMs: number;
  streamUrl: string;
  submissions: ReviewSubmission[];
};

/** 数据异常时明确报错，不能把损坏的提交伪装成没有片段。 */
function parseSegments(json: string): ReviewSegment[] {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new StateConflictError('提交片段记录无法读取，请联系管理员'); }
  if (!Array.isArray(value) || value.length === 0) throw new StateConflictError('提交片段记录为空，请联系管理员');
  const segments: ReviewSegment[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) throw new StateConflictError('提交片段记录不完整，请联系管理员');
    const { startMs, endMs, label } = item as Record<string, unknown>;
    if (typeof startMs !== 'number' || typeof endMs !== 'number' || !Number.isInteger(startMs) ||
        !Number.isInteger(endMs) || startMs < 0 || endMs <= startMs ||
        (label !== undefined && label !== null && typeof label !== 'string')) {
      throw new StateConflictError('提交片段记录不完整，请联系管理员');
    }
    segments.push({ startMs, endMs, label: typeof label === 'string' ? label : null });
  }
  return segments.sort((a, b) => a.startMs - b.startMs);
}

/** 先检查管理员角色；标注员不能借任务 ID 读取其他人的提交。 */
export function getTaskReview(db: DB, actor: SessionUser, taskId: string): TaskReview {
  if (actor.role !== 'admin') throw new ForbiddenError();
  const task = findById(db, taskId);
  if (!task) throw new NotFoundError('任务不存在');
  return {
    taskId, title: task.title, tenantName: task.tenant_name, status: task.status,
    rejectReason: task.reject_reason, videoFilename: task.video_filename, durationMs: task.estimated_ms,
    streamUrl: withBasePath(`/api/videos/${task.video_id}/stream`),
    submissions: listForReview(db, task.tenant_id, taskId).map((row) => ({
      id: row.id, displayName: row.display_name, submittedAt: row.submitted_at,
      date: row.local_date, totalMs: row.total_ms, segments: parseSegments(row.segments_json),
    })),
  };
}
