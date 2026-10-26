/**
 * 管理员退回：把一条已提交的任务置为 rejected，并冲正已计入的工作量。
 *
 * 状态跃迁、账本冲正、审计三者共用一个事务 —— 少任何一个都会留下对不上的数字或断链的追溯。
 */
import { nowMs, writeTx, type DB } from '@/lib/db';
import { newId } from '@/lib/db/id';
import { insertEntry } from '@/lib/db/repos/ledger-repo';
import { findCurrentByTask } from '@/lib/db/repos/submission-repo';
import { findById, rejectIfSubmitted, reopenIfRejected } from '@/lib/db/repos/task-repo';
import { NotFoundError, StateConflictError, ValidationError } from '@/lib/errors';
import { AUDIT_ACTIONS } from '@/lib/audit-actions';
import { MAX_REASON_LENGTH } from '@/lib/review-limits';
import { writeAudit } from './audit-service';
import type { SessionUser, TenantUser } from './auth-service';
import { requireOwnedTask } from './segment-service';

// 契约要求常量从本模块导出；实现放在 lib/review-limits，客户端表单才能不引 service 而取到同一个值
export { MAX_REASON_LENGTH };

const TASK_NOT_FOUND_MESSAGE = '任务不存在';
const REJECT_CONFLICT_MESSAGE = '任务当前状态不允许退回';
const BROKEN_SUBMISSION_MESSAGE = '这条任务缺少有效的提交记录，暂不能退回';
const EMPTY_REASON_MESSAGE = '请填写退回原因';

/**
 * 退回一条已提交的任务。
 * 状态 → rejected，并写一条 revoke 冲正（entry_date 取原提交日）。
 * 调用方必须已确认是管理员。
 */
export function rejectTask(db: DB, actor: SessionUser, taskId: string, reason: string, expectedSubmissionId?: string): void {
  const trimmed = reason.trim();
  // 按 trim 后计数：全是空格的原因等于没写，标注员退回后仍不知道该改什么
  if (trimmed.length === 0) throw new ValidationError(EMPTY_REASON_MESSAGE);
  if (trimmed.length > MAX_REASON_LENGTH) {
    throw new ValidationError(`退回原因不能超过 ${MAX_REASON_LENGTH} 字`);
  }

  writeTx(db, () => {
    // RULES：先判存在性再判状态，顺序反了「id 不存在」会被报成 409
    const task = findById(db, taskId);
    if (!task) throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);

    // 输赢只看 changes，不先查后改：并发退回或标注员恰好重新提交时，
    // 先查后改会让两个请求都通过检查，写出两条冲正，任务净额变成负数
    if (!rejectIfSubmitted(db, { taskId, reason: trimmed })) {
      throw new StateConflictError(REJECT_CONFLICT_MESSAGE);
    }

    const submission = findCurrentByTask(db, taskId);
    // 状态是 submitted 却找不到有效快照，说明数据被改坏了；抛出后上面那次状态更新一并回滚
    if (!submission) throw new StateConflictError(BROKEN_SUBMISSION_MESSAGE);
    // 审核期间若已产生新提交，回滚状态更新，防止退回未看过的新版本。
    if (expectedSubmissionId !== undefined && submission.id !== expectedSubmissionId) {
      throw new StateConflictError('提交版本已更新，请刷新后重新审核');
    }

    insertEntry(db, {
      id: newId(),
      tenantId: task.tenant_id,
      taskId,
      submissionId: submission.id,
      annotatorId: submission.annotator_id,
      // 必须是负数：schema 的 CHECK 要求 revoke 的 delta_ms < 0，写成 Math.abs 会直接撞约束
      deltaMs: -submission.total_ms,
      // 记在原提交日而非今天：退回修正的是那一天的工作量。
      // 记今天会让原日期报表永久偏多，还会在退回当天凭空出现一段负数工作量
      entryDate: submission.local_date,
      kind: 'revoke',
      createdAt: nowMs(),
    });

    // 账本管数字（记在原日期），审计管行为（记在现在）：谁在何时退回了什么
    writeAudit(db, {
      actorId: actor.id,
      actorRole: actor.role,
      tenantId: task.tenant_id,
      action: AUDIT_ACTIONS.taskReject,
      targetType: 'task',
      targetId: taskId,
      detail: {
        reason: trimmed,
        previousStatus: 'submitted',
        submissionId: submission.id,
        deltaMs: -submission.total_ms,
        entryDate: submission.local_date,
      },
    }, { strict: true });
  });
}

const REOPEN_CONFLICT_MESSAGE = '任务当前状态不允许重新打开';

/**
 * 重新打开被退回的任务。仅限原领取人。
 *
 * 只有 claimed 才能进工作台、才能再次提交，所以这是退回后唯一的出路 ——
 * 没有它，标注员能看见自己被退回的任务、也知道原因，却改不了。
 *
 * 不写账本：冲正在退回时就做过了。这里补一条 submit 等于凭空把工作量再记一遍。
 * 也不清 reject_reason：它要一直显示到下一次提交（submitIfClaimed 里才清）。
 */
export function reopenTask(db: DB, actor: TenantUser, taskId: string): void {
  writeTx(db, () => {
    // 先判归属再判状态，与其余四个动作一致：
    // 顺序反了，「别人的任务」会被报成 409，等于承认这条任务存在。
    // 归属判定只有 requireOwnedTask 一份：跨租户由它的 SQL 过滤成「查不到」，
    // 不在 JS 里再判一次租户 —— 少一处可能与 SQL 不一致的判断
    const task = requireOwnedTask(db, actor, taskId);

    // 只看 changes：并发下两个请求同时重新打开，只有一个能成
    if (!reopenIfRejected(db, { taskId, tenantId: task.tenant_id, userId: actor.id, nowMs: nowMs() })) {
      throw new StateConflictError(REOPEN_CONFLICT_MESSAGE);
    }

    writeAudit(db, {
      actorId: actor.id,
      actorRole: actor.role,
      tenantId: task.tenant_id,
      action: AUDIT_ACTIONS.taskReopen,
      targetType: 'task',
      targetId: taskId,
      // 记下退回原因与来源状态，账本上「先归零又涨上去」才解释得通
      detail: { previousStatus: 'rejected', rejectReason: task.reject_reason },
    }, { strict: true });
  });
}
