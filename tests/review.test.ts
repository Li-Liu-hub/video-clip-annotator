/**
 * D4 管理员退回：状态跃迁、账本冲正、审计三件事必须同时发生。
 *
 * 断言一律查库：service 的返回值可能对，落库仍可能不对。
 * 冲正是负值、记原提交日 —— 这两条各有一条独立用例，因为它们决定了历史报表是否可信。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as rejectPost } from '@/app/api/tasks/[id]/reject/route';
import { createDb, type DB } from '@/lib/db';
import { sumByTask } from '@/lib/db/repos/ledger-repo';
import { AppError } from '@/lib/errors';
import { getCurrentUser } from '@/lib/server/current-user';
import type { SessionUser, TenantUser } from '@/lib/services/auth-service';
import { MAX_REASON_LENGTH, rejectTask } from '@/lib/services/review-service';

// 403 / 401 / 400 用例需要伪造请求上下文；其余用例直接调 service，不经过这一层
vi.mock('@/lib/server/current-user', () => ({ getCurrentUser: vi.fn() }));

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const ADMIN_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
const VIDEO_A = 'ddddddddddddddd1';

const T_SUBMITTED = 'a000000000000001';
const T_PENDING = 'a000000000000002';
const T_CLAIMED = 'a000000000000003';
const T_REJECTED = 'a000000000000004';
/** 状态是 submitted 却没有有效提交：模拟数据被改坏 */
const T_NO_SUBMISSION = 'a000000000000005';
/** 从不写入库的 id：验证「不存在」这条分支 */
const GHOST_TASK = 'f000000000000000';

const SUB_CURRENT = 'c000000000000001';
const SUB_OLD = 'c000000000000002';

const CLAIMED_AT = 1_700_000_000_000;
/** 2026-10-20 00:30（Asia/Shanghai）：退回跑在别的日期，日期断言才有意义 */
const SUBMITTED_AT = Date.UTC(2026, 9, 19, 16, 30);
const LOCAL_DATE = '2026-10-20';
/** 被取代的旧提交：金额与日期都不同，用来证明冲正取的是当前有效那条 */
const OLD_LOCAL_DATE = '2026-10-18';
const TOTAL_MS = 600_000;
const OLD_TOTAL_MS = 900_000;

const REASON = '片段边界偏了 2 秒，请重新标注';
const PREVIOUS_REASON = '上一轮：字幕错位';

const PASSWORD_HASH = 'scrypt$00$00';

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

let db: DB;

function seed(): DB {
  const fresh = createDb(':memory:');

  fresh
    .prepare('INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)')
    .run(TENANT_A, 'A 空间', 'Asia/Shanghai', 0);

  const insertUser = fresh.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run(ADMIN_ID, null, 'admin', '平台管理员', PASSWORD_HASH, 'admin', 0);
  insertUser.run(ALICE_ID, TENANT_A, 'alice', '林小雨', PASSWORD_HASH, 'annotator', 0);

  fresh
    .prepare(
      `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'video/mp4', ?, ?)`,
    )
    .run(VIDEO_A, 'a-demo.mp4', `${VIDEO_A}.mp4`, 1024, 60_000, ADMIN_ID, 0);

  return fresh;
}

/** pending 行不能带 claimed_by（schema 的 CHECK），故与其余状态分成两个写入函数。 */
function addPending(id: string): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, created_by, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, 0)`,
  ).run(id, TENANT_A, VIDEO_A, `任务 ${id.slice(-1)}`, ADMIN_ID);
}

function addOwned(
  id: string,
  status: 'claimed' | 'submitted' | 'rejected',
  rejectReason: string | null = null,
): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, claimed_at,
                        reject_reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(id, TENANT_A, VIDEO_A, `任务 ${id.slice(-1)}`, status, ALICE_ID, CLAIMED_AT, rejectReason, ADMIN_ID);
}

function addSubmission(args: {
  id: string;
  taskId: string;
  totalMs: number;
  localDate: string;
  supersededBy: string | null;
}): void {
  db.prepare(
    `INSERT INTO submissions (id, task_id, tenant_id, annotator_id, submitted_at, local_date,
                              total_ms, segment_count, segments_json, superseded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)`,
  ).run(
    args.id,
    args.taskId,
    TENANT_A,
    ALICE_ID,
    SUBMITTED_AT,
    args.localDate,
    args.totalMs,
    JSON.stringify([{ startMs: 0, endMs: args.totalMs }]),
    args.supersededBy,
  );
}

function addLedger(args: {
  id: string;
  taskId: string;
  submissionId: string;
  deltaMs: number;
  entryDate: string;
  kind: 'submit' | 'revoke';
}): void {
  db.prepare(
    `INSERT INTO ledger_entries (id, tenant_id, task_id, submission_id, annotator_id,
                                 delta_ms, entry_date, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    args.id,
    TENANT_A,
    args.taskId,
    args.submissionId,
    ALICE_ID,
    args.deltaMs,
    args.entryDate,
    args.kind,
  );
}

function seedTasks(): void {
  addPending(T_PENDING);
  addOwned(T_CLAIMED, 'claimed');
  addOwned(T_REJECTED, 'rejected', PREVIOUS_REASON);
  addOwned(T_SUBMITTED, 'submitted');
  addOwned(T_NO_SUBMISSION, 'submitted');

  // 当前有效提交 + 一条被它取代的旧提交：superseded_by 必须先插被指向的行（外键即时校验）
  addSubmission({ id: SUB_CURRENT, taskId: T_SUBMITTED, totalMs: TOTAL_MS, localDate: LOCAL_DATE, supersededBy: null });
  addSubmission({ id: SUB_OLD, taskId: T_SUBMITTED, totalMs: OLD_TOTAL_MS, localDate: OLD_LOCAL_DATE, supersededBy: SUB_CURRENT });

  addLedger({
    id: 'e000000000000001',
    taskId: T_SUBMITTED,
    submissionId: SUB_CURRENT,
    deltaMs: TOTAL_MS,
    entryDate: LOCAL_DATE,
    kind: 'submit',
  });
}

type TaskState = { status: string; reject_reason: string | null };

/** 直接查表：断言的是库里的状态，不是 service 的返回值。 */
function stateOf(taskId: string): TaskState {
  return db.prepare('SELECT status, reject_reason FROM tasks WHERE id = ?').get(taskId) as TaskState;
}

type RevokeRow = { delta_ms: number; entry_date: string; kind: string; submission_id: string };

function revokeOf(taskId: string): RevokeRow | undefined {
  return db
    .prepare(
      `SELECT delta_ms, entry_date, kind, submission_id
         FROM ledger_entries WHERE task_id = ? AND kind = 'revoke'`,
    )
    .get(taskId) as RevokeRow | undefined;
}

function countLedger(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number };
  return row.n;
}

function countAudit(action: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?').get(action) as {
    n: number;
  };
  return row.n;
}

function countAllAudit(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number };
  return row.n;
}

/** 把「抛错」与「返回」压成同一个可断言的字面量，避免两者被同一个 it 混过去。 */
function capture(fn: () => unknown): { threw: string; status: number } {
  try {
    fn();
    return { threw: 'none', status: 0 };
  } catch (err) {
    if (err instanceof AppError) return { threw: err.name, status: err.status };
    return { threw: err instanceof Error ? err.name : 'non-error', status: 0 };
  }
}

/** 吞掉预期内的异常：抛错本身由相邻用例断言，这里只关心库是否被改动。 */
function swallow(fn: () => void): void {
  try {
    fn();
  } catch {
    // 预期抛错，见相邻用例
  }
}

function rejectRequest(body: unknown): Request {
  return new Request(`http://localhost/api/tasks/${T_SUBMITTED}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const REJECT_CONTEXT = { params: Promise.resolve({ id: T_SUBMITTED }) };

beforeEach(() => {
  db = seed();
  seedTasks();
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

describe('退回成功', () => {
  it('退回已提交任务后状态变为 rejected', () => {
    rejectTask(db, ADMIN, T_SUBMITTED, REASON);
    expect(stateOf(T_SUBMITTED).status).toBe('rejected');
  });

  it('退回原因写入 reject_reason', () => {
    rejectTask(db, ADMIN, T_SUBMITTED, REASON);
    expect(stateOf(T_SUBMITTED).reject_reason).toBe(REASON);
  });

  it('原因两端的空白被裁掉后再落库', () => {
    rejectTask(db, ADMIN, T_SUBMITTED, `  ${REASON}  `);
    expect(stateOf(T_SUBMITTED).reject_reason).toBe(REASON);
  });

  it('恰好写一条 revoke 类型的账本条目', () => {
    rejectTask(db, ADMIN, T_SUBMITTED, REASON);
    expect(revokeOf(T_SUBMITTED)?.kind).toBe('revoke');
  });

  it('冲正金额是当前有效提交 total_ms 的相反数', () => {
    rejectTask(db, ADMIN, T_SUBMITTED, REASON);
    expect(revokeOf(T_SUBMITTED)?.delta_ms).toBe(-TOTAL_MS);
  });

  it('冲正指向当前有效提交，而不是被取代的那条', () => {
    rejectTask(db, ADMIN, T_SUBMITTED, REASON);
    expect(revokeOf(T_SUBMITTED)?.submission_id).toBe(SUB_CURRENT);
  });

  it('冲正的 entry_date 等于原提交的 local_date，而不是退回当天', () => {
    /*
     * 这条单独成例：冲正记在哪一天是 D4 最核心的判断。
     * 记今天会让 2026-10-20 的报表永久偏多，还会在退回当天凭空出现负数工作量 ——
     * 前者正是项目要消灭的「数字对不上」，所以只能记原提交日。
     */
    rejectTask(db, ADMIN, T_SUBMITTED, REASON);
    expect(revokeOf(T_SUBMITTED)?.entry_date).toBe(LOCAL_DATE);
  });

  it('退回后该任务的账本净额归零', () => {
    rejectTask(db, ADMIN, T_SUBMITTED, REASON);
    expect(sumByTask(db, T_SUBMITTED)).toBe(0);
  });

  it('退回 200 字的原因仍能成功', () => {
    rejectTask(db, ADMIN, T_SUBMITTED, 'a'.repeat(MAX_REASON_LENGTH));
    expect(stateOf(T_SUBMITTED).status).toBe('rejected');
  });
});

describe('状态冲突', () => {
  it('退回 pending 任务抛 StateConflictError', () => {
    expect(capture(() => rejectTask(db, ADMIN, T_PENDING, REASON))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('退回 claimed 任务抛 StateConflictError', () => {
    expect(capture(() => rejectTask(db, ADMIN, T_CLAIMED, REASON))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('退回 rejected 任务抛 StateConflictError', () => {
    expect(capture(() => rejectTask(db, ADMIN, T_REJECTED, REASON))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('退回 pending / claimed / rejected 三次失败后账本行数不变', () => {
    const before = countLedger();
    swallow(() => rejectTask(db, ADMIN, T_PENDING, REASON));
    swallow(() => rejectTask(db, ADMIN, T_CLAIMED, REASON));
    swallow(() => rejectTask(db, ADMIN, T_REJECTED, REASON));
    expect(countLedger()).toBe(before);
  });

  it('退回 pending 任务失败后状态仍是 pending', () => {
    swallow(() => rejectTask(db, ADMIN, T_PENDING, REASON));
    expect(stateOf(T_PENDING).status).toBe('pending');
  });

  it('退回不存在的任务抛 NotFoundError', () => {
    expect(capture(() => rejectTask(db, ADMIN, GHOST_TASK, REASON))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });

  it('任务状态是 submitted 但找不到有效提交时抛 StateConflictError', () => {
    expect(capture(() => rejectTask(db, ADMIN, T_NO_SUBMISSION, REASON))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('找不到有效提交时状态回滚为 submitted，不留下半次退回', () => {
    swallow(() => rejectTask(db, ADMIN, T_NO_SUBMISSION, REASON));
    expect(stateOf(T_NO_SUBMISSION).status).toBe('submitted');
  });
});

describe('原因校验', () => {
  it('原因为空抛 ValidationError', () => {
    expect(capture(() => rejectTask(db, ADMIN, T_SUBMITTED, ''))).toEqual({
      threw: 'ValidationError',
      status: 400,
    });
  });

  it('原因全是空白抛 ValidationError', () => {
    expect(capture(() => rejectTask(db, ADMIN, T_SUBMITTED, '   '))).toEqual({
      threw: 'ValidationError',
      status: 400,
    });
  });

  it('原因超过 200 字抛 ValidationError', () => {
    expect(capture(() => rejectTask(db, ADMIN, T_SUBMITTED, 'a'.repeat(MAX_REASON_LENGTH + 1)))).toEqual({
      threw: 'ValidationError',
      status: 400,
    });
  });

  it('校验失败后状态与原因都不变', () => {
    swallow(() => rejectTask(db, ADMIN, T_SUBMITTED, ''));
    expect(stateOf(T_SUBMITTED)).toEqual({ status: 'submitted', reject_reason: null });
  });

  it('校验失败后账本行数不变', () => {
    const before = countLedger();
    swallow(() => rejectTask(db, ADMIN, T_SUBMITTED, 'a'.repeat(MAX_REASON_LENGTH + 1)));
    expect(countLedger()).toBe(before);
  });
});

describe('审计', () => {
  it('退回成功写一条 task.reject 审计并指向该任务', () => {
    rejectTask(db, ADMIN, T_SUBMITTED, REASON);
    const row = db
      .prepare(`SELECT target_id FROM audit_logs WHERE action = 'task.reject'`)
      .get() as { target_id: string };
    expect(row.target_id).toBe(T_SUBMITTED);
  });

  it('审计的 detail 里带上退回原因', () => {
    rejectTask(db, ADMIN, T_SUBMITTED, REASON);
    const row = db
      .prepare(`SELECT detail FROM audit_logs WHERE action = 'task.reject'`)
      .get() as { detail: string };
    expect((JSON.parse(row.detail) as { reason: string }).reason).toBe(REASON);
  });

  it('状态冲突时不写审计', () => {
    const before = countAllAudit();
    swallow(() => rejectTask(db, ADMIN, T_PENDING, REASON));
    expect(countAllAudit()).toBe(before);
  });

  it('原因校验失败时不写审计', () => {
    const before = countAllAudit();
    swallow(() => rejectTask(db, ADMIN, T_SUBMITTED, ''));
    expect(countAllAudit()).toBe(before);
  });

  it('退回成功后只有一条 task.reject 审计，没有重复', () => {
    rejectTask(db, ADMIN, T_SUBMITTED, REASON);
    expect(countAudit('task.reject')).toBe(1);
  });
});

describe('API 权限与请求体', () => {
  it('标注员调用 reject 返回 403', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ALICE);
    const res = await rejectPost(rejectRequest({ reason: REASON }), REJECT_CONTEXT);
    expect(res.status).toBe(403);
  });

  it('标注员调用 reject 的错误码是 FORBIDDEN', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ALICE);
    const res = await rejectPost(rejectRequest({ reason: REASON }), REJECT_CONTEXT);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('标注员被拒后任务仍是 submitted', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ALICE);
    await rejectPost(rejectRequest({ reason: REASON }), REJECT_CONTEXT);
    expect(stateOf(T_SUBMITTED).status).toBe('submitted');
  });

  it('未登录调用 reject 返回 401', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await rejectPost(rejectRequest({ reason: REASON }), REJECT_CONTEXT);
    expect(res.status).toBe(401);
  });

  it('请求体缺少 reason 字段返回 400', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await rejectPost(rejectRequest({}), REJECT_CONTEXT);
    expect(res.status).toBe(400);
  });

  it('reason 不是字符串返回 400', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await rejectPost(rejectRequest({ reason: 42 }), REJECT_CONTEXT);
    expect(res.status).toBe(400);
  });
});
