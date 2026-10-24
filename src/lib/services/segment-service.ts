/**
 * 片段工作区：列出、新增/替换、删除。
 *
 * 单条片段的校验不另写规则，而是把「候选集整体」交给 normalizeSegments ——
 * 长度、范围、整数、重叠四组规则因此只有一处实现。
 */
import { randomBytes } from 'node:crypto';
import { nowMs, writeTx, type DB } from '@/lib/db';
import {
  deleteById,
  insertSegment,
  listByTask,
  type SegmentRecord,
} from '@/lib/db/repos/segment-repo';
import { findByIdForTenant, type TaskRow } from '@/lib/db/repos/task-repo';
import { NotFoundError, OverlapError, StateConflictError, ValidationError } from '@/lib/errors';
import type { Interval } from '@/lib/interval';
import {
  MAX_SEGMENTS,
  MIN_SEGMENT_MS,
  normalizeSegments,
  type SegmentIssue,
} from '@/lib/segment-interval';
import type { TenantUser } from './auth-service';

export type SegmentRow = { id: string; startMs: number; endMs: number; label: string | null };

export type UpsertSegmentInput = {
  startMs: number;
  endMs: number;
  /** 原片段 id：给了就是替换，没给就是纯新增。 */
  replaces?: string | null;
};

const TASK_NOT_FOUND_MESSAGE = '任务不存在';
const TASK_STATE_CONFLICT_MESSAGE = '任务当前状态不允许修改片段';
const REPLACE_TARGET_MISSING_MESSAGE = '要替换的片段不存在';
const SEGMENT_MISSING_MESSAGE = '片段不存在';
const OVERLAP_MESSAGE = '这个片段与已标注的区间重叠';

/** 8 字节随机数 → 16 位十六进制，与 RULES 的 id 约定一致 */
const SEGMENT_ID_BYTES = 8;

function toSegmentRow(record: SegmentRecord): SegmentRow {
  return {
    id: record.id,
    startMs: record.start_ms,
    endMs: record.end_ms,
    label: record.label,
  };
}

/** 把 normalizeSegments 的问题码翻成用户看得懂的话。不含表名、SQL 与下标。 */
function issueMessage(issue: SegmentIssue): string {
  switch (issue.code) {
    case 'empty':
      return '没有可保存的片段';
    case 'too-many':
      return `单个任务的片段不能超过 ${MAX_SEGMENTS} 段`;
    case 'invalid-duration':
      return '视频时长异常，暂时无法保存片段';
    case 'not-finite':
    case 'not-integer':
      return '片段边界必须是整数毫秒';
    case 'negative':
      return '片段起点不能为负数';
    case 'reversed':
      return '片段结束时间必须晚于开始时间';
    case 'out-of-range':
      return '片段超出了视频时长';
    case 'too-short':
      return `片段不能短于 ${MIN_SEGMENT_MS} 毫秒`;
    case 'overlap':
      return OVERLAP_MESSAGE;
  }
}

/**
 * 把预检结果翻成领域错误。重叠单独给 OverlapError（409），
 * 其余一律 ValidationError（400）：前端按 code 区分「拖歪了」与「拖到别人身上」。
 */
function throwIssue(issue: SegmentIssue, conflict?: Interval): never {
  if (issue.code === 'overlap') throw new OverlapError(conflict, OVERLAP_MESSAGE);
  throw new ValidationError(issueMessage(issue));
}

/**
 * 纯归属：租户 + 是否本人领取，不满足都抛 404。**不判状态** —— 状态各有各的出口。
 *
 * 同租户同事的任务也用 404 而不是 403：403 等于承认这条任务存在，
 * 同事的任务清单会因此可被枚举。顺序按 RULES：先判存在性与归属，再判状态。
 *
 * 归属谓词只有这一份。读、写两个入口都经它，避免「一处改了另一处没改」。
 */
function requireOwnedTask(db: DB, actor: TenantUser, taskId: string): TaskRow {
  const task = findByIdForTenant(db, taskId, actor.tenantId);
  if (!task) throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
  if (task.claimed_by !== actor.id) throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
  return task;
}

/**
 * 可读：归属成立 + 状态在白名单里。读路径用它，于是已提交的任务仍可读。
 *
 * rejected 按「不存在」处理：退回后任务已回到池子，claimed_by 只是历史残留，
 * 打开它看到的是过期数据 —— 与 getWorkTask 的拒绝理由同一条。
 * 用白名单而非「排除 rejected」：将来加第五个状态时，这里默认放行会出问题。
 */
function requireReadableTask(db: DB, actor: TenantUser, taskId: string): TaskRow {
  const task = requireOwnedTask(db, actor, taskId);
  if (task.status !== 'claimed' && task.status !== 'submitted') {
    throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
  }
  return task;
}

/** 归属 + 状态必须是 claimed。写路径用它：已提交 / 已退回的任务改删片段是 409，不是 404。 */
function requireWritableTask(db: DB, actor: TenantUser, taskId: string): TaskRow {
  // 委托 owned 而非 readable：rejected 的归属是成立的（claimed_by 仍是本人），
  // 它的问题是状态不允许改 —— 那是 409 该说的话，不是 404
  const task = requireOwnedTask(db, actor, taskId);
  if (task.status !== 'claimed') {
    throw new StateConflictError(TASK_STATE_CONFLICT_MESSAGE);
  }
  return task;
}

/** 列出任务的片段，按 startMs 升序。已提交的任务也能列：那是只读回顾的前提。 */
export function listSegments(db: DB, actor: TenantUser, taskId: string): SegmentRow[] {
  requireReadableTask(db, actor, taskId);
  return listByTask(db, actor.tenantId, taskId).map(toSegmentRow);
}

/**
 * 新增或替换一个片段。replaces 为原片段 id 时执行「先删后插」，否则纯新增。
 * 任何校验失败都抛错，不做部分写入。
 *
 * 预检与插入必须在同一个 writeTx 内：分开做的话两个并发请求都会通过预检、
 * 各自插入，合起来就是重叠。BEGIN IMMEDIATE 取的写锁让「读候选集 → 写」成为临界区。
 */
export function upsertSegment(
  db: DB,
  actor: TenantUser,
  taskId: string,
  input: UpsertSegmentInput,
): SegmentRow {
  return writeTx(db, () => {
    const task = requireWritableTask(db, actor, taskId);
    const existing = listByTask(db, actor.tenantId, taskId).map(toSegmentRow);

    // replaces 必须指向本任务的片段：不校验的话，传别人的片段 id 能删掉别人的数据。
    // 只有 null / undefined 算「未指定」——空串若也当未指定，会静默降级成新增：
    // 请求方以为替换成功（拿到新 id），实际旧片段还在，库里多出一条。
    const replaces = input.replaces ?? null;
    const target = replaces === null ? null : existing.find((row) => row.id === replaces);
    if (replaces !== null && !target) throw new NotFoundError(REPLACE_TARGET_MISSING_MESSAGE);

    // 候选集 = 去掉被替换项后的现有片段 + 新片段，整体过一遍 normalizeSegments
    const candidates: Interval[] = [
      ...existing
        .filter((row) => row.id !== replaces)
        .map(({ startMs, endMs }) => ({ startMs, endMs })),
      { startMs: input.startMs, endMs: input.endMs },
    ];
    const result = normalizeSegments(candidates, task.estimated_ms);
    if (!result.ok) {
      throwIssue(result.issue, result.issue.code === 'overlap' ? candidates[result.issue.index] : undefined);
    }

    // 替换用「先删后插」而不是 UPDATE：拖动任一端都可能同时改两端，
    // UPDATE 要判断改的是哪端才决定重叠检查的排除项，删+插天然覆盖所有情况。
    // 代价是片段 id 会变，前端必须按返回值更新选中项。
    if (target) deleteById(db, actor.tenantId, taskId, target.id);

    const row: SegmentRow = {
      id: randomBytes(SEGMENT_ID_BYTES).toString('hex'),
      startMs: input.startMs,
      endMs: input.endMs,
      label: null,
    };
    // 插入若被触发器拒绝（并发写入抢在前面），异常穿出 writeTx，上面那次删除一并回滚
    insertSegment(db, {
      id: row.id,
      taskId,
      tenantId: actor.tenantId,
      startMs: row.startMs,
      endMs: row.endMs,
      label: row.label,
      createdAt: nowMs(),
    });
    return row;
  });
}

/** 删除片段。不属于该任务（含别人的任务）一律 404。 */
export function deleteSegment(db: DB, actor: TenantUser, taskId: string, segmentId: string): void {
  writeTx(db, () => {
    requireWritableTask(db, actor, taskId);
    // 命中与否由 WHERE 判定：先查后删在并发下两人都会通过检查
    if (!deleteById(db, actor.tenantId, taskId, segmentId)) {
      throw new NotFoundError(SEGMENT_MISSING_MESSAGE);
    }
  });
}
