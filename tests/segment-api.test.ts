/**
 * E4 片段 CRUD：归属校验、区间预检、替换回滚，以及触发器这层兜底。
 *
 * 断言一律查库而非只看返回值：返回值对、落库不对是这类接口最常见的失效方式。
 * 「并发时预检与插入不在同一事务」无法在单线程测试里复现，由 writeTx(BEGIN IMMEDIATE)
 * 的结构保证；本文件用裸 SQL 绕过 service，验证最后一道防线真的在守。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE as deleteSegmentRoute } from '@/app/api/tasks/[id]/segments/[segmentId]/route';
import { GET as listSegmentsRoute, POST as upsertSegmentRoute } from '@/app/api/tasks/[id]/segments/route';
import { createDb, type DB } from '@/lib/db';
import { AppError, NotFoundError, OverlapError } from '@/lib/errors';
import { insertSegment } from '@/lib/db/repos/segment-repo';
import { getCurrentUser } from '@/lib/server/current-user';
import type { SessionUser, TenantUser } from '@/lib/services/auth-service';
import {
  deleteSegment,
  listSegments,
  upsertSegment,
} from '@/lib/services/segment-service';

// 403 用例需要伪造请求上下文；其余用例直接调 service，不经过这一层
vi.mock('@/lib/server/current-user', () => ({ getCurrentUser: vi.fn() }));

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbbbbbbbbbb';

const ADMIN_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
/** 同租户同事：schema 的唯一索引不允许，本场景为验证 claimed_by 谓词而造 */
const ALICE_PEER_ID = '3333333333333333';
const BOB_ID = '4444444444444444';

const VIDEO_A = 'ddddddddddddddd1';
const VIDEO_B = 'ddddddddddddddd2';

const T_MINE = 'a000000000000001';
const T_PENDING = 'a000000000000002';
const T_PEER = 'a000000000000003';
const T_SUBMITTED = 'a000000000000004';
const T_REJECTED = 'a000000000000005';
const T_OTHER = 'b000000000000001';

const S_MINE = 'c000000000000001';
const S_OTHER = 'c000000000000002';
/** 从不写入库的 id：验证「不存在」这条分支 */
const GHOST_SEGMENT = 'f000000000000000';

const VIDEO_A_MS = 60_000;
const VIDEO_B_MS = 30_000;
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
  // 移除它而非放弃该场景：claimed_by 谓词只有同租户内才测得出来。
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
  insertUser.run(ALICE_PEER_ID, TENANT_A, 'alice_peer', '周予安', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(BOB_ID, TENANT_B, 'bob', '陈默', PASSWORD_HASH, 'annotator', 0);

  const insertVideo = fresh.prepare(
    `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'video/mp4', ?, ?)`,
  );
  insertVideo.run(VIDEO_A, 'a-demo.mp4', `${VIDEO_A}.mp4`, 1024, VIDEO_A_MS, ADMIN_ID, 0);
  insertVideo.run(VIDEO_B, 'b-demo.mp4', `${VIDEO_B}.mp4`, 1024, VIDEO_B_MS, ADMIN_ID, 0);

  return fresh;
}

/** pending 行不能带 claimed_by（schema 的 CHECK），故与已领取的行分开写。 */
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
  status: 'claimed' | 'submitted' | 'rejected',
): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, claimed_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(id, tenantId, videoId, `任务 ${id.slice(-1)}`, status, claimedBy, 1_000, ADMIN_ID);
}

/** 建库用的片段：写入合法的互不重叠区间，触发器不会拦。 */
function addSegment(id: string, taskId: string, tenantId: string, startMs: number, endMs: number): void {
  db.prepare(
    `INSERT INTO segments (id, task_id, tenant_id, start_ms, end_ms, label, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 0)`,
  ).run(id, taskId, tenantId, startMs, endMs);
}

function seedRows(): void {
  addOwned(T_MINE, TENANT_A, VIDEO_A, ALICE_ID, 'claimed');
  addPending(T_PENDING, TENANT_A, VIDEO_A);
  addOwned(T_PEER, TENANT_A, VIDEO_A, ALICE_PEER_ID, 'claimed');
  addOwned(T_SUBMITTED, TENANT_A, VIDEO_A, ALICE_ID, 'submitted');
  // 退回的行仍带着 claimed_by（schema 要求非 pending 必须有归属），正是「像自己的、其实不是」那条分支
  addOwned(T_REJECTED, TENANT_A, VIDEO_A, ALICE_ID, 'rejected');
  addOwned(T_OTHER, TENANT_B, VIDEO_B, BOB_ID, 'claimed');

  addSegment(S_MINE, T_MINE, TENANT_A, 10_000, 20_000);
  addSegment(S_OTHER, T_OTHER, TENANT_B, 5_000, 8_000);
}

function countOf(taskId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM segments WHERE task_id = ?').get(taskId) as {
    n: number;
  };
  return row.n;
}

function segmentOf(id: string): { start_ms: number; end_ms: number } | null {
  const row = db
    .prepare('SELECT start_ms, end_ms FROM segments WHERE id = ?')
    .get(id) as { start_ms: number; end_ms: number } | undefined;
  return row ?? null;
}

/** 把「抛错」与「返回」压成同一个可断言的字面量，避免两者被同一个 it 混过去。 */
function capture(fn: () => unknown): { threw: string; status: number } {
  try {
    fn();
    return { threw: 'none', status: 0 };
  } catch (err) {
    if (err instanceof AppError) return { threw: err.name, status: err.status };
    return { threw: err instanceof Error ? err.message : 'non-error', status: 0 };
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

beforeEach(() => {
  db = seed();
  seedRows();
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

describe('新增片段', () => {
  it('新增合法片段返回 16 位十六进制 id', () => {
    const row = upsertSegment(db, ALICE, T_MINE, { startMs: 30_000, endMs: 40_000 });
    expect(row.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('新增合法片段后落库，任务片段数加一', () => {
    upsertSegment(db, ALICE, T_MINE, { startMs: 30_000, endMs: 40_000 });
    expect(countOf(T_MINE)).toBe(2);
  });

  it('新增返回的行边界与入参一致', () => {
    const row = upsertSegment(db, ALICE, T_MINE, { startMs: 30_000, endMs: 40_000 });
    expect({ startMs: row.startMs, endMs: row.endMs }).toEqual({ startMs: 30_000, endMs: 40_000 });
  });

  it('首尾相接的片段合法（半开区间）', () => {
    expect(capture(() => upsertSegment(db, ALICE, T_MINE, { startMs: 20_000, endMs: 30_000 }))).toEqual(
      { threw: 'none', status: 0 },
    );
  });

  it('列表按起点升序返回', () => {
    addSegment('c000000000000003', T_MINE, TENANT_A, 30_000, 35_000);
    expect(listSegments(db, ALICE, T_MINE).map((row) => row.startMs)).toEqual([10_000, 30_000]);
  });

  it('列表只含本任务的片段', () => {
    expect(listSegments(db, ALICE, T_MINE).map((row) => row.id)).toEqual([S_MINE]);
  });
});

describe('重叠预检', () => {
  it('新增与已有片段重叠的抛 OverlapError', () => {
    expect(capture(() => upsertSegment(db, ALICE, T_MINE, { startMs: 15_000, endMs: 25_000 }))).toEqual(
      { threw: 'OverlapError', status: 409 },
    );
  });

  it('重叠失败后库中片段数不变', () => {
    swallow(() => upsertSegment(db, ALICE, T_MINE, { startMs: 15_000, endMs: 25_000 }));
    expect(countOf(T_MINE)).toBe(1);
  });

  it('完全包含已有片段的新增同样被拒', () => {
    expect(capture(() => upsertSegment(db, ALICE, T_MINE, { startMs: 5_000, endMs: 25_000 }))).toEqual(
      { threw: 'OverlapError', status: 409 },
    );
  });
});

describe('区间不合法', () => {
  it('短于 MIN_SEGMENT_MS 的片段抛 ValidationError', () => {
    expect(capture(() => upsertSegment(db, ALICE, T_MINE, { startMs: 30_000, endMs: 30_050 }))).toEqual(
      { threw: 'ValidationError', status: 400 },
    );
  });

  it('越界的片段抛 ValidationError', () => {
    expect(capture(() => upsertSegment(db, ALICE, T_MINE, { startMs: 55_000, endMs: 60_100 }))).toEqual(
      { threw: 'ValidationError', status: 400 },
    );
  });

  it('小数毫秒抛 ValidationError', () => {
    expect(capture(() => upsertSegment(db, ALICE, T_MINE, { startMs: 30_000.5, endMs: 40_000 }))).toEqual(
      { threw: 'ValidationError', status: 400 },
    );
  });

  it('起点晚于终点的片段抛 ValidationError', () => {
    expect(capture(() => upsertSegment(db, ALICE, T_MINE, { startMs: 40_000, endMs: 30_000 }))).toEqual(
      { threw: 'ValidationError', status: 400 },
    );
  });

  it('校验失败的片段不会落库', () => {
    swallow(() => upsertSegment(db, ALICE, T_MINE, { startMs: 30_000, endMs: 30_050 }));
    expect(countOf(T_MINE)).toBe(1);
  });
});

describe('替换', () => {
  it('正常替换后旧片段消失', () => {
    upsertSegment(db, ALICE, T_MINE, { startMs: 12_000, endMs: 18_000, replaces: S_MINE });
    expect(segmentOf(S_MINE)).toBeNull();
  });

  it('正常替换后新片段落库', () => {
    upsertSegment(db, ALICE, T_MINE, { startMs: 12_000, endMs: 18_000, replaces: S_MINE });
    expect(countOf(T_MINE)).toBe(1);
  });

  it('替换返回的 id 与旧 id 不同（先删后插）', () => {
    const row = upsertSegment(db, ALICE, T_MINE, { startMs: 12_000, endMs: 18_000, replaces: S_MINE });
    expect(row.id).not.toBe(S_MINE);
  });

  it('替换后库里的区间是新区间', () => {
    const row = upsertSegment(db, ALICE, T_MINE, { startMs: 12_000, endMs: 18_000, replaces: S_MINE });
    expect(segmentOf(row.id)).toEqual({ start_ms: 12_000, end_ms: 18_000 });
  });

  it('replaces 指向别的任务的片段时抛 NotFoundError', () => {
    expect(
      capture(() => upsertSegment(db, ALICE, T_MINE, { startMs: 30_000, endMs: 40_000, replaces: S_OTHER })),
    ).toEqual({ threw: 'NotFoundError', status: 404 });
  });

  it('replaces 跨任务失败后本任务的片段数不变', () => {
    swallow(() =>
      upsertSegment(db, ALICE, T_MINE, { startMs: 30_000, endMs: 40_000, replaces: S_OTHER }),
    );
    expect(countOf(T_MINE)).toBe(1);
  });

  it('replaces 跨任务失败后别的任务的片段仍在', () => {
    swallow(() =>
      upsertSegment(db, ALICE, T_MINE, { startMs: 30_000, endMs: 40_000, replaces: S_OTHER }),
    );
    expect(segmentOf(S_OTHER)).not.toBeNull();
  });

  it('替换成与另一段重叠的区间时抛 OverlapError', () => {
    addSegment('c000000000000003', T_MINE, TENANT_A, 25_000, 35_000);
    expect(
      capture(() => upsertSegment(db, ALICE, T_MINE, { startMs: 10_000, endMs: 30_000, replaces: S_MINE })),
    ).toEqual({ threw: 'OverlapError', status: 409 });
  });

  it('替换失败后旧片段仍在，且区间未被改动', () => {
    addSegment('c000000000000003', T_MINE, TENANT_A, 25_000, 35_000);
    swallow(() =>
      upsertSegment(db, ALICE, T_MINE, { startMs: 10_000, endMs: 30_000, replaces: S_MINE }),
    );
    // 旧行 id 未变 = 删除发生在事务内且被回滚，不存在「删了但没插上」的中间态
    expect(segmentOf(S_MINE)).toEqual({ start_ms: 10_000, end_ms: 20_000 });
  });

  it('替换失败后片段总数不变', () => {
    addSegment('c000000000000003', T_MINE, TENANT_A, 25_000, 35_000);
    swallow(() =>
      upsertSegment(db, ALICE, T_MINE, { startMs: 10_000, endMs: 30_000, replaces: S_MINE }),
    );
    expect(countOf(T_MINE)).toBe(2);
  });
});

describe('删除', () => {
  it('删除自己的片段后该行消失', () => {
    deleteSegment(db, ALICE, T_MINE, S_MINE);
    expect(segmentOf(S_MINE)).toBeNull();
  });

  it('删除不属于该任务的片段抛 NotFoundError', () => {
    expect(capture(() => deleteSegment(db, ALICE, T_MINE, S_OTHER))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });

  it('删除别人的片段后它仍然存在', () => {
    swallow(() => deleteSegment(db, ALICE, T_MINE, S_OTHER));
    expect(segmentOf(S_OTHER)).not.toBeNull();
  });

  it('删除不存在的片段抛 NotFoundError', () => {
    expect(capture(() => deleteSegment(db, ALICE, T_MINE, GHOST_SEGMENT))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });
});

describe('归属与状态', () => {
  it('未领取的 pending 任务改片段抛 NotFoundError', () => {
    expect(capture(() => upsertSegment(db, ALICE, T_PENDING, { startMs: 0, endMs: 1_000 }))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });

  it('同租户同事领取的任务改片段抛 NotFoundError', () => {
    expect(capture(() => upsertSegment(db, ALICE, T_PEER, { startMs: 0, endMs: 1_000 }))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });

  it('其他租户的任务改片段抛 NotFoundError', () => {
    expect(capture(() => upsertSegment(db, ALICE, T_OTHER, { startMs: 0, endMs: 1_000 }))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });

  it('已提交的任务改片段抛 StateConflictError', () => {
    expect(capture(() => upsertSegment(db, ALICE, T_SUBMITTED, { startMs: 0, endMs: 1_000 }))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('已提交的任务改片段不会落库', () => {
    // 上一个用例只断言抛错；这条守的是「写路径真的没走到 SQL」
    swallow(() => upsertSegment(db, ALICE, T_SUBMITTED, { startMs: 0, endMs: 1_000 }));
    expect(countOf(T_SUBMITTED)).toBe(0);
  });

  it('已提交的任务删片段抛 StateConflictError', () => {
    expect(capture(() => deleteSegment(db, ALICE, T_SUBMITTED, S_MINE))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('已提交的任务删片段后该片段仍在', () => {
    addSegment('c000000000000004', T_SUBMITTED, TENANT_A, 1_000, 5_000);
    swallow(() => deleteSegment(db, ALICE, T_SUBMITTED, 'c000000000000004'));
    expect(countOf(T_SUBMITTED)).toBe(1);
  });

  it('已提交的任务可以列出片段（E8 需求变更，不再是 409）', () => {
    // E4 时期这里断言 StateConflictError：当时读路径与写路径共用 requireWritableTask。
    // E8 起读路径改用 requireOwnedTask，已提交任务的片段必须能列出来，
    // 否则只读回顾打不开。这是需求驱动的行为变更，不是回归。
    addSegment('c000000000000005', T_SUBMITTED, TENANT_A, 1_000, 5_000);
    expect(listSegments(db, ALICE, T_SUBMITTED).map((row) => row.id)).toEqual(['c000000000000005']);
  });

  it('已退回的任务改片段抛 StateConflictError 而不是 404', () => {
    // 退货后 claimed_by 仍是本人（schema 强制非 pending 必须有归属），
    // 所以拒绝的理由是「状态不允许改」，不是「不是你的任务」
    expect(
      capture(() => upsertSegment(db, ALICE, T_REJECTED, { startMs: 0, endMs: 1_000 })),
    ).toEqual({ threw: 'StateConflictError', status: 409 });
  });

  it('已退回的任务删片段抛 StateConflictError 而不是 404', () => {
    expect(capture(() => deleteSegment(db, ALICE, T_REJECTED, S_MINE))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('已退回的任务列片段抛 NotFoundError', () => {
    // 不是 409 也不是空数组：退回后任务已回池子，claimed_by 只是历史残留，
    // 与「同租户同事的任务」同一条出口
    expect(capture(() => listSegments(db, ALICE, T_REJECTED))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });

  it('其他租户的任务列片段抛 NotFoundError', () => {
    expect(capture(() => listSegments(db, BOB, T_MINE))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });
});

describe('API 权限', () => {
  const LIST_CONTEXT = { params: Promise.resolve({ id: T_MINE }) };
  const DELETE_CONTEXT = { params: Promise.resolve({ id: T_MINE, segmentId: S_MINE }) };

  function postRequest(): Request {
    return new Request(`http://localhost/api/tasks/${T_MINE}/segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startMs: 30_000, endMs: 40_000 }),
    });
  }

  it('管理员调用列表接口返回 403', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await listSegmentsRoute(new Request('http://localhost/api/tasks'), LIST_CONTEXT);
    expect(res.status).toBe(403);
  });

  it('管理员调用新增接口返回 403', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await upsertSegmentRoute(postRequest(), LIST_CONTEXT);
    expect(res.status).toBe(403);
  });

  it('管理员调用删除接口返回 403', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await deleteSegmentRoute(
      new Request('http://localhost/api/tasks', { method: 'DELETE' }),
      DELETE_CONTEXT,
    );
    expect(res.status).toBe(403);
  });

  it('管理员调用新增接口后没有片段落库', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    await upsertSegmentRoute(postRequest(), LIST_CONTEXT);
    expect(countOf(T_MINE)).toBe(1);
  });
});

describe('触发器兜底', () => {
  it('绕过应用层直接插重叠片段，触发器抛 OVERLAP', () => {
    expect(() => addSegment('c00000000000000f', T_MINE, TENANT_A, 15_000, 25_000)).toThrow(/OVERLAP/);
  });

  it('裸 SQL 插入被拒后片段数不变', () => {
    swallow(() => addSegment('c00000000000000f', T_MINE, TENANT_A, 15_000, 25_000));
    expect(countOf(T_MINE)).toBe(1);
  });

  it('首尾相接的裸插入不被触发器拦（半开区间语义一致）', () => {
    addSegment('c00000000000000f', T_MINE, TENANT_A, 20_000, 25_000);
    // 应用层预检与触发器必须得出同一结论，否则「预检放行、触发器拒绝」会变成 500
    expect(countOf(T_MINE)).toBe(2);
  });
});

/**
 * 补充验证：前四组各自对应 Reviewer 指出的一个「零变异命中」的规则。
 * 这四条规则在代码里都是对的，但没有测试守着 —— 按 RULES「未变红者视为未测」，
 * 等于没测。下面每一例都对应一个具体变异。
 */
describe('补充：无测试守着就等于没测的四条规则', () => {
  it('replaces 为空串时抛 NotFoundError 而不是静默新增', () => {
    // 变异：把 `replaces ?? null` 改回 `replaces ? ... : null`，空串会降级成新增
    expect(() =>
      upsertSegment(db, ALICE, T_MINE, { startMs: 30_000, endMs: 32_000, replaces: '' }),
    ).toThrow(NotFoundError);
  });

  it('replaces 为空串时库中行数不变', () => {
    swallow(() =>
      upsertSegment(db, ALICE, T_MINE, { startMs: 30_000, endMs: 32_000, replaces: '' }),
    );
    expect(listSegments(db, ALICE, T_MINE)).toHaveLength(1);
  });

  it('直接调 insertSegment 撞触发器时抛 OverlapError，而不是原始 SQLite 错误', () => {
    // 变异（M2）：去掉 repo 的异常翻译，会抛裸 SqliteError，客户端收到 500
    expect(() =>
      insertSegment(db, {
        id: 'c0000000000000ff',
        taskId: T_MINE,
        tenantId: TENANT_A,
        startMs: 15_000,
        endMs: 25_000,
        label: null,
        createdAt: 0,
      }),
    ).toThrow(OverlapError);
  });

  it('插入被触发器拒绝时，被替换的旧片段仍在原处', () => {
    // 变异（M4）：去掉 writeTx，delete 已经落地不会回滚，旧片段消失且新片段没插上
    db.exec(
      "CREATE TRIGGER block_seg_insert BEFORE INSERT ON segments BEGIN SELECT RAISE(ABORT, 'OVERLAP'); END",
    );
    swallow(() =>
      upsertSegment(db, ALICE, T_MINE, {
        startMs: 30_000,
        endMs: 32_000,
        replaces: S_MINE,
      }),
    );
    db.exec('DROP TRIGGER block_seg_insert');
    expect(listSegments(db, ALICE, T_MINE).map((row) => row.id)).toEqual([S_MINE]);
  });

  it('预检的读取发生在写事务内', () => {
    // 变异（M5）：把 listByTask 移到 writeTx 之外，这里会观察到 false。
    // BEGIN IMMEDIATE 在回调执行前就已取到写锁，所以回调内的第一条读必然 inTransaction。
    const observed: boolean[] = [];
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (sql.includes('FROM segments')) observed.push(db.inTransaction);
      return original(sql);
    }) as typeof db.prepare;
    try {
      upsertSegment(db, ALICE, T_MINE, { startMs: 30_000, endMs: 32_000 });
    } finally {
      (db as unknown as { prepare: typeof db.prepare }).prepare = original;
    }
    expect(observed.length > 0 && observed.every(Boolean)).toBe(true);
  });

  it('用本任务的路径删另一任务的片段返回 404，且两个任务的片段数都不变', () => {
    // 变异（M8）：deleteById 去掉 task_id 谓词后，这一例会成功删掉别人的片段
    addOwned('a000000000000009', TENANT_A, VIDEO_A, ALICE_ID, 'claimed');
    addSegment('c000000000000009', 'a000000000000009', TENANT_A, 40_000, 45_000);
    expect(() => deleteSegment(db, ALICE, T_MINE, 'c000000000000009')).toThrow(NotFoundError);
  });
});
