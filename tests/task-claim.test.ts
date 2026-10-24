/**
 * D3 领取与归还：并发输赢、跨租户 404、归还越权、审计只在成功路径。
 *
 * 并发用「A 先领成功、B 再领同一条」模拟。两次调用在时间上一前一后，
 * 但判定路径与真实并发一致 —— 输的一方拿到 changes = 0。
 * 断言一律查库：service 返回值可能对，落库仍可能不对。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as claimPost } from '@/app/api/tasks/[id]/claim/route';
import { POST as releasePost } from '@/app/api/tasks/[id]/release/route';
import { createDb, type DB } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { getCurrentUser } from '@/lib/server/current-user';
import type { SessionUser, TenantUser } from '@/lib/services/auth-service';
import { claimTask, releaseTask } from '@/lib/services/task-service';

// 403 用例需要伪造请求上下文；其余用例直接调 service，不经过这一层
vi.mock('@/lib/server/current-user', () => ({ getCurrentUser: vi.fn() }));

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbbbbbbbbbb';

const ADMIN_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
/** 同租户同事：schema 的唯一索引不允许，本场景为验证并发输赢而造（见 seed 注释） */
const BOB_ID = '3333333333333333';
const CAROL_ID = '4444444444444444';

const VIDEO_A = 'ddddddddddddddd1';
const VIDEO_B = 'ddddddddddddddd2';

const T_PENDING = 'a000000000000001';
const T_CLAIMED_ALICE = 'a000000000000002';
const T_SUBMITTED_ALICE = 'a000000000000003';
const T_PENDING_B = 'b000000000000001';
/** 从不写入库的 id：验证「不存在」这条分支 */
const GHOST_TASK = 'f000000000000000';

const CLAIMED_AT = 1_700_000_000_000;
const PASSWORD_HASH = 'scrypt$00$00';

const ALICE: TenantUser = {
  id: ALICE_ID,
  username: 'alice',
  displayName: '林小雨',
  role: 'annotator',
  tenantId: TENANT_A,
  tenantName: 'A 空间',
  timezone: 'Asia/Shanghai',
};

const BOB: TenantUser = {
  id: BOB_ID,
  username: 'bob',
  displayName: '陈默',
  role: 'annotator',
  tenantId: TENANT_A,
  tenantName: 'A 空间',
  timezone: 'Asia/Shanghai',
};

/** 其他租户的标注员：用来确认「领取别人的任务」不会成功 */
const CAROL: TenantUser = {
  id: CAROL_ID,
  username: 'carol',
  displayName: '宋清',
  role: 'annotator',
  tenantId: TENANT_B,
  tenantName: 'B 空间',
  timezone: 'Asia/Shanghai',
};

const ADMIN: SessionUser = {
  id: ADMIN_ID,
  username: 'admin',
  displayName: '平台管理员',
  role: 'admin',
  tenantId: null,
  tenantName: null,
  timezone: 'Asia/Shanghai',
};

let db: DB;

function seed(): DB {
  const fresh = createDb(':memory:');

  // 「一个租户只有一个标注员」的唯一索引与「同租户同事」场景互斥。
  // 移除它而非放弃该场景：并发输赢只能同租户内发生，这条用例是 D3 的核心。
  fresh.exec('DROP INDEX idx_one_annotator_per_tenant');

  const insertTenant = fresh.prepare(
    'INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)',
  );
  insertTenant.run(TENANT_A, 'A 空间', 'Asia/Shanghai', 0);
  insertTenant.run(TENANT_B, 'B 空间', 'Asia/Shanghai', 0);

  const insertUser = fresh.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run(ADMIN_ID, null, 'admin', '平台管理员', PASSWORD_HASH, 'admin', 0);
  insertUser.run(ALICE_ID, TENANT_A, 'alice', '林小雨', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(BOB_ID, TENANT_A, 'bob', '陈默', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(CAROL_ID, TENANT_B, 'carol', '宋清', PASSWORD_HASH, 'annotator', 0);

  const insertVideo = fresh.prepare(
    `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'video/mp4', ?, ?)`,
  );
  insertVideo.run(VIDEO_A, 'a-demo.mp4', `${VIDEO_A}.mp4`, 1024, 60_000, ADMIN_ID, 0);
  insertVideo.run(VIDEO_B, 'b-demo.mp4', `${VIDEO_B}.mp4`, 1024, 30_000, ADMIN_ID, 0);

  return fresh;
}

/** pending 行不能带 claimed_by（schema 的 CHECK），故与已领取的行分成两个写入函数。 */
function addPending(id: string, tenantId: string, videoId: string): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, created_by, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, 0)`,
  ).run(id, tenantId, videoId, `任务 ${id.slice(-1)}`, ADMIN_ID);
}

function addOwned(
  id: string,
  tenantId: string,
  videoId: string,
  claimedBy: string,
  status: 'claimed' | 'submitted',
): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, claimed_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(id, tenantId, videoId, `任务 ${id.slice(-1)}`, status, claimedBy, CLAIMED_AT, ADMIN_ID);
}

function seedTasks(): void {
  addPending(T_PENDING, TENANT_A, VIDEO_A);
  addOwned(T_CLAIMED_ALICE, TENANT_A, VIDEO_A, ALICE_ID, 'claimed');
  addOwned(T_SUBMITTED_ALICE, TENANT_A, VIDEO_A, ALICE_ID, 'submitted');
  addPending(T_PENDING_B, TENANT_B, VIDEO_B);
}

type TaskState = { status: string; claimed_by: string | null; claimed_at: number | null };

/** 直接查表：断言的是库里的状态，不是 service 的返回值。 */
function stateOf(taskId: string): TaskState {
  return db
    .prepare('SELECT status, claimed_by, claimed_at FROM tasks WHERE id = ?')
    .get(taskId) as TaskState;
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

function taskRequest(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'POST' });
}

const CLAIM_CONTEXT = { params: Promise.resolve({ id: T_PENDING }) };

beforeEach(() => {
  db = seed();
  seedTasks();
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

describe('领取成功', () => {
  it('领取本租户待领取任务后状态变为 claimed', () => {
    claimTask(db, ALICE, T_PENDING);
    expect(stateOf(T_PENDING).status).toBe('claimed');
  });

  it('领取后 claimed_by 是领取人自己', () => {
    claimTask(db, ALICE, T_PENDING);
    expect(stateOf(T_PENDING).claimed_by).toBe(ALICE_ID);
  });

  it('领取后 claimed_at 有值', () => {
    claimTask(db, ALICE, T_PENDING);
    expect(stateOf(T_PENDING).claimed_at).not.toBeNull();
  });

  it('领取返回的行是更新后的行', () => {
    const task = claimTask(db, ALICE, T_PENDING);
    expect({ status: task.status, claimedBy: task.claimed_by }).toEqual({
      status: 'claimed',
      claimedBy: ALICE_ID,
    });
  });
});

describe('并发输赢', () => {
  it('A 先领成功后，B 领取同一条任务抛 StateConflictError', () => {
    claimTask(db, ALICE, T_PENDING);
    expect(capture(() => claimTask(db, BOB, T_PENDING))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('B 领取失败后任务仍归 A，claimed_by 没有被改写', () => {
    claimTask(db, ALICE, T_PENDING);
    swallow(() => claimTask(db, BOB, T_PENDING));
    expect(stateOf(T_PENDING).claimed_by).toBe(ALICE_ID);
  });

  it('B 领取失败后状态仍是 claimed，没有被降级', () => {
    claimTask(db, ALICE, T_PENDING);
    swallow(() => claimTask(db, BOB, T_PENDING));
    expect(stateOf(T_PENDING).status).toBe('claimed');
  });
});

describe('跨租户与不存在', () => {
  it('领取其他租户的任务抛 NotFoundError 而不是 StateConflictError', () => {
    expect(capture(() => claimTask(db, CAROL, T_PENDING))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });

  it('跨租户领取失败后目标任务仍是 pending', () => {
    swallow(() => claimTask(db, CAROL, T_PENDING));
    expect(stateOf(T_PENDING).status).toBe('pending');
  });

  it('领取不存在的 id 抛 NotFoundError', () => {
    expect(capture(() => claimTask(db, ALICE, GHOST_TASK))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });

  it('领取已提交的任务抛 StateConflictError', () => {
    expect(capture(() => claimTask(db, ALICE, T_SUBMITTED_ALICE))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('领取已提交的任务后状态仍是 submitted', () => {
    swallow(() => claimTask(db, ALICE, T_SUBMITTED_ALICE));
    expect(stateOf(T_SUBMITTED_ALICE).status).toBe('submitted');
  });
});

describe('归还', () => {
  it('归还自己领取的任务后状态回到 pending', () => {
    releaseTask(db, ALICE, T_CLAIMED_ALICE);
    expect(stateOf(T_CLAIMED_ALICE).status).toBe('pending');
  });

  it('归还后 claimed_by 置空', () => {
    releaseTask(db, ALICE, T_CLAIMED_ALICE);
    expect(stateOf(T_CLAIMED_ALICE).claimed_by).toBeNull();
  });

  it('归还后 claimed_at 一并置空', () => {
    releaseTask(db, ALICE, T_CLAIMED_ALICE);
    expect(stateOf(T_CLAIMED_ALICE).claimed_at).toBeNull();
  });

  it('归还别人领取的任务抛 StateConflictError', () => {
    expect(capture(() => releaseTask(db, BOB, T_CLAIMED_ALICE))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('归还别人领取的任务后任务仍是 claimed 且归原主', () => {
    swallow(() => releaseTask(db, BOB, T_CLAIMED_ALICE));
    expect(stateOf(T_CLAIMED_ALICE)).toMatchObject({
      status: 'claimed',
      claimed_by: ALICE_ID,
    });
  });

  it('归还已提交的任务抛 StateConflictError', () => {
    expect(capture(() => releaseTask(db, ALICE, T_SUBMITTED_ALICE))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('归还已提交的任务后状态仍是 submitted', () => {
    swallow(() => releaseTask(db, ALICE, T_SUBMITTED_ALICE));
    expect(stateOf(T_SUBMITTED_ALICE).status).toBe('submitted');
  });

  it('归还其他租户的任务抛 NotFoundError', () => {
    expect(capture(() => releaseTask(db, CAROL, T_CLAIMED_ALICE))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });
});

describe('审计', () => {
  it('领取成功写一条 task.claim 审计并指向该任务', () => {
    claimTask(db, ALICE, T_PENDING);
    const row = db
      .prepare(`SELECT target_id FROM audit_logs WHERE action = 'task.claim'`)
      .get() as { target_id: string };
    expect(row.target_id).toBe(T_PENDING);
  });

  it('领取冲突时 audit_logs 总行数不变', () => {
    claimTask(db, ALICE, T_PENDING);
    const before = countAllAudit();
    swallow(() => claimTask(db, BOB, T_PENDING));
    expect(countAllAudit()).toBe(before);
  });

  it('跨租户领取失败时 audit_logs 总行数不变', () => {
    const before = countAllAudit();
    swallow(() => claimTask(db, CAROL, T_PENDING));
    expect(countAllAudit()).toBe(before);
  });

  it('归还成功写一条 task.release 审计', () => {
    releaseTask(db, ALICE, T_CLAIMED_ALICE);
    expect(countAudit('task.release')).toBe(1);
  });

  it('归还越权时 audit_logs 总行数不变', () => {
    const before = countAllAudit();
    swallow(() => releaseTask(db, BOB, T_CLAIMED_ALICE));
    expect(countAllAudit()).toBe(before);
  });
});

describe('API 权限', () => {
  it('管理员调用 claim 返回 403', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await claimPost(taskRequest(`/api/tasks/${T_PENDING}/claim`), CLAIM_CONTEXT);
    expect(res.status).toBe(403);
  });

  it('管理员调用 claim 的错误码是 FORBIDDEN', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await claimPost(taskRequest(`/api/tasks/${T_PENDING}/claim`), CLAIM_CONTEXT);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('管理员调用 release 返回 403', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await releasePost(
      taskRequest(`/api/tasks/${T_PENDING}/release`),
      CLAIM_CONTEXT,
    );
    expect(res.status).toBe(403);
  });

  it('管理员调用 claim 后任务仍是 pending', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    await claimPost(taskRequest(`/api/tasks/${T_PENDING}/claim`), CLAIM_CONTEXT);
    expect(stateOf(T_PENDING).status).toBe('pending');
  });
});

describe('冲突提示要分得清', () => {
  it('自己重复领取时提示「已经领取」', () => {
    claimTask(db, ALICE, T_PENDING);
    expect(() => claimTask(db, ALICE, T_PENDING)).toThrow(/已经领取/);
  });

  it('被同租户同事领走后提示「被别人领取」', () => {
    claimTask(db, BOB, T_PENDING);
    expect(() => claimTask(db, ALICE, T_PENDING)).toThrow(/其他人领取/);
  });
});

describe('冲突文案按状态区分', () => {
  /**
   * schema 的 CHECK 要求所有非 pending 行都带 claimed_by，
   * 所以已提交/已退回的任务同样满足 `claimed_by === 自己`。
   * 只看 claimed_by 的判定会把它们错报成「你已经领取了这条任务」，
   * 让用户以为状态被回退了。
   */
  it('领取已提交的任务提示已提交，而不是「你已经领取了」', () => {
    let message = '';
    try {
      claimTask(db, ALICE, T_SUBMITTED_ALICE);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe('这条任务已提交，不能重复领取');
  });
});
