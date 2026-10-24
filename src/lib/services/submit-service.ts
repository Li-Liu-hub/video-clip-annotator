/**
 * 提交任务：把草稿片段固化为一次提交，同时写账本、转状态、留审计。
 *
 * 这是第一个不可逆操作，因此四写在同一个 writeTx 内 —— 少任何一个都会留下
 * 「有提交无账」「有账无提交」「任务还能改」这类需要人工对账的断链。
 */
import { randomBytes } from 'node:crypto';
import { nowMs, writeTx, type DB } from '@/lib/db';
import { insertEntry } from '@/lib/db/repos/ledger-repo';
import { listByTask } from '@/lib/db/repos/segment-repo';
import { insertSubmission, supersedeOpenByTask } from '@/lib/db/repos/submission-repo';
import { submitIfClaimed } from '@/lib/db/repos/task-repo';
import { StateConflictError } from '@/lib/errors';
import { writeAudit } from './audit-service';
import type { TenantUser } from './auth-service';
import { localDateOf } from './daily-date';
import { requireWritableTask } from './segment-service';

export type SubmitResult = {
  submissionId: string;
  totalMs: number;
  segmentCount: number;
};

const EMPTY_SEGMENTS_MESSAGE = '还没有标注任何片段';
const STATE_CONFLICT_MESSAGE = '任务当前状态不允许提交';

/** 8 字节随机数 → 16 位十六进制，与 RULES 的 id 约定一致 */
const ID_BYTES = 8;

/**
 * 提交任务。前置：本人领取、状态 claimed、至少有 1 个片段。
 * 四写入同一事务：submissions + ledger_entries + tasks.status + audit_logs。
 */
export function submitTask(db: DB, actor: TenantUser, taskId: string): SubmitResult {
  /*
   * 事务外先判归属与状态，再判片段是否为空。
   * 顺序不可颠倒：空片段是 409，而别人的任务必须是 404（RULES：先判存在性与归属，再判状态）。
   * 反过来的话，跨租户的提交请求会收到「还没有标注任何片段」，等于用 409 确认了任务存在。
   */
  requireWritableTask(db, actor, taskId);

  // 只读预检放在事务外：没标任何片段时不该为一个注定失败的提交持写锁
  const segments = listByTask(db, actor.tenantId, taskId);
  if (segments.length === 0) throw new StateConflictError(EMPTY_SEGMENTS_MESSAGE);

  /*
   * 计入的是「标了多少」，不是「视频多长」：30 分钟视频只标了 3 分钟，账上就是 3 分钟。
   * 半开区间 [start, end)，长度即差值。
   */
  const totalMs = segments.reduce((sum, segment) => sum + (segment.end_ms - segment.start_ms), 0);

  return writeTx(db, () => {
    /*
     * 锁内重判一次。BEGIN IMMEDIATE 的写锁在回调之前就拿到了，
     * 两个并发的提交请求中，第二个会在这里读到 submitted 而抛 409 —— 这就是重复提交的兜底。
     * 不返回「上次的提交」：幂等键是客户端的事，服务端只保证同一任务不会被提交两次。
     */
    const task = requireWritableTask(db, actor, taskId);

    const now = nowMs();
    // 按租户时区算「哪一天」，不按服务器：UTC 机器上晚上 8 点的提交仍算今天
    const localDate = localDateOf(now, actor.timezone);
    const submissionId = randomBytes(ID_BYTES).toString('hex');

    insertSubmission(db, {
      id: submissionId,
      taskId,
      tenantId: task.tenant_id,
      annotatorId: actor.id,
      submittedAt: now,
      localDate,
      totalMs,
      segmentCount: segments.length,
      // 存快照而非引用：退回后草稿会继续被编辑，这次提交标了什么必须永久可查。
      // 不带 id —— id 属于草稿态，固化后没有意义，留在历史里只会让人误以为还能按它回查
      segmentsJson: JSON.stringify(
        segments.map((segment) => ({
          startMs: segment.start_ms,
          endMs: segment.end_ms,
          label: segment.label,
        })),
      ),
      createdAt: now,
    });

    // 旧快照标记为已被取代。必须在 insertSubmission 之后（FK 即时校验），
    // 且在同一个事务里：漏了的话下一次退回会按旧快照的金额冲正
    supersedeOpenByTask(db, { taskId, tenantId: task.tenant_id, newId: submissionId });

    // 状态跃迁仍是单条条件 UPDATE：漏判时这里的 changes 为 0，整个事务回滚
    if (
      !submitIfClaimed(db, {
        taskId,
        tenantId: task.tenant_id,
        userId: actor.id,
        nowMs: now,
      })
    ) {
      throw new StateConflictError(STATE_CONFLICT_MESSAGE);
    }

    insertEntry(db, {
      id: randomBytes(ID_BYTES).toString('hex'),
      tenantId: task.tenant_id,
      taskId,
      submissionId,
      annotatorId: actor.id,
      // 正数=计入；账本按 entry_date 汇总，日期取提交日，之后不再换算
      deltaMs: totalMs,
      entryDate: localDate,
      kind: 'submit',
      createdAt: now,
    });

    // 严格模式：审计写失败必须让整次提交回滚，否则会出现「已入账但查不到谁提交的」
    writeAudit(
      db,
      {
        actorId: actor.id,
        actorRole: actor.role,
        tenantId: task.tenant_id,
        action: 'task.submit',
        targetType: 'task',
        targetId: taskId,
        // localDate 一并记下：事后不 join submissions 也能回答「这笔记到哪一天」
        detail: { totalMs, segmentCount: segments.length, submissionId, localDate },
      },
      { strict: true },
    );

    return { submissionId, totalMs, segmentCount: segments.length };
  });
}
