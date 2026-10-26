/**
 * 任务列表的可见性：3 个租户，每户覆盖 pending / 自己领取 / 同事领取 / 已提交。
 *
 * 断言的核心是两条边界：本租户内「同事领取的」不可见，租户外「待领取的」不可见。
 * 后者是安全底线，单列一个用例，不与其他规则混在一条断言里。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DB } from '@/lib/db';
import {
  countAll,
  countForAnnotator,
  listAll,
  listForAnnotator,
  type ListOptions,
} from '@/lib/db/repos/task-repo';
import { AppError } from '@/lib/errors';
import type { SessionUser } from '@/lib/services/auth-service';
import { PAGE_SIZE, listTasks, listTenantTasks } from '@/lib/services/task-service';

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbbbbbbbbbb';
const TENANT_C = 'cccccccccccccccc';

const ADMIN_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
/** 同租户同事：schema 不允许存在，本场景为验证 claimed_by 谓词而造（见 seed 注释） */
const ALICE_PEER_ID = '3333333333333333';
const BOB_ID = '4444444444444444';
const CAROL_ID = '5555555555555555';
const CAROL_PEER_ID = '6666666666666666';

const VIDEO_A = 'ddddddddddddddd1';
const VIDEO_B = 'ddddddddddddddd2';
const VIDEO_C = 'ddddddddddddddd3';

const T1_PENDING = 'a000000000000001';
const T1_CLAIMED_SELF = 'a000000000000002';
const T1_CLAIMED_PEER = 'a000000000000003';
const T1_SUBMITTED_SELF = 'a000000000000004';
const T2_PENDING = 'b000000000000001';
const T2_CLAIMED_SELF = 'b000000000000002';
const T2_SUBMITTED_SELF = 'b000000000000003';
/**
 * 其他租户里挂在自己名下的任务：正常流程不会产生，但租户改派或直接改库会留下。
 * 有了它，「claimed_by = 自己」这一半条件在没有租户约束时就会泄漏 ——
 * 这正是 WHERE 少写括号后的形态，故必须造出来。
 */
const T2_CLAIMED_BY_ALICE = 'b000000000000004';
const T3_PENDING = 'c000000000000001';
const T3_CLAIMED_SELF = 'c000000000000002';
const T3_CLAIMED_PEER = 'c000000000000003';
const T3_SUBMITTED_SELF = 'c000000000000004';

const TASK_COUNT = 12;
const VIDEO_A_MS = 60_000;
const VIDEO_B_MS = 45_000;
const VIDEO_C_MS = 30_000;
const PASSWORD_HASH = 'scrypt$00$00';

const LIST_ALL: ListOptions = { limit: 100, offset: 0 };

const ADMIN: SessionUser = {
  id: ADMIN_ID,
  username: 'admin',
  displayName: '平台管理员',
  role: 'admin',
  tenantId: null,
  tenantName: null,
  timezone: 'Asia/Shanghai',
};

const ALICE: SessionUser = {
  id: ALICE_ID,
  username: 'alice',
  displayName: '林小雨',
  role: 'annotator',
  tenantId: TENANT_A,
  tenantName: 'A 空间',
  timezone: 'Asia/Shanghai',
};

/** role 是标注员但租户为空：users 行被改坏后的畸形身份。 */
const BROKEN_ALICE: SessionUser = { ...ALICE, tenantId: null };

const ALICE_VISIBLE = [T1_SUBMITTED_SELF, T1_CLAIMED_SELF, T1_PENDING];

/** 管理员视图的完整期望顺序：created_at DESC, id DESC。 */
const ALL_IN_ORDER = [
  T2_CLAIMED_BY_ALICE,
  T3_SUBMITTED_SELF,
  T3_CLAIMED_PEER,
  T2_SUBMITTED_SELF,
  T1_SUBMITTED_SELF,
  T1_CLAIMED_PEER,
  T1_CLAIMED_SELF,
  T3_CLAIMED_SELF,
  T2_CLAIMED_SELF,
  T3_PENDING,
  T2_PENDING,
  T1_PENDING,
];

let db: DB;

describe('发布时查看空间现有任务', () => {
  it('空间明细只包含该空间的所有状态任务', () => {
    expect(listTenantTasks(db, ADMIN, TENANT_A, 1).items.map((task) => task.id)).toEqual([
      T1_SUBMITTED_SELF, T1_CLAIMED_PEER, T1_CLAIMED_SELF, T1_PENDING,
    ]);
  });
  it('标注员不能调用空间明细服务', () => {
    expect(() => listTenantTasks(db, ALICE, TENANT_B, 1)).toThrow('没有权限');
  });
  it('空间明细分页不会退回全量查询', () => {
    expect(listTenantTasks(db, ADMIN, TENANT_A, 2)).toEqual({ items: [], total: 4, page: 2, pageSize: PAGE_SIZE });
  });
});

function seed(): DB {
  const fresh = createDb(':memory:');

  // schema 的「一个租户只有一个标注员」唯一索引与「同租户同事」场景互斥。
  // 移除它而非放弃该场景：列表查询不能依赖「租户内只有我一个人」这个假设，
  // 一旦数据被直接改写，claimed_by 谓词就是挡住同事任务的唯一防线。
  fresh.exec('DROP INDEX idx_one_annotator_per_tenant');

  const insertTenant = fresh.prepare(
    'INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)',
  );
  insertTenant.run(TENANT_A, 'A 空间', 'Asia/Shanghai', 0);
  insertTenant.run(TENANT_B, 'B 空间', 'Asia/Shanghai', 0);
  insertTenant.run(TENANT_C, 'C 空间', 'Asia/Shanghai', 0);

  const insertUser = fresh.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run(ADMIN_ID, null, 'admin', '平台管理员', PASSWORD_HASH, 'admin', 0);
  insertUser.run(ALICE_ID, TENANT_A, 'alice', '林小雨', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(ALICE_PEER_ID, TENANT_A, 'alice_peer', '周予安', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(BOB_ID, TENANT_B, 'bob', '陈默', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(CAROL_ID, TENANT_C, 'carol', '宋清', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(CAROL_PEER_ID, TENANT_C, 'carol_peer', '吴桐', PASSWORD_HASH, 'annotator', 0);

  const insertVideo = fresh.prepare(
    `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'video/mp4', ?, ?)`,
  );
  insertVideo.run(VIDEO_A, 'a-demo.mp4', `${VIDEO_A}.mp4`, 1024, VIDEO_A_MS, ADMIN_ID, 0);
  insertVideo.run(VIDEO_B, 'b-demo.mp4', `${VIDEO_B}.mp4`, 1024, VIDEO_B_MS, ADMIN_ID, 0);
  insertVideo.run(VIDEO_C, 'c-demo.mp4', `${VIDEO_C}.mp4`, 1024, VIDEO_C_MS, ADMIN_ID, 0);

  return fresh;
}

/** pending 行不能带 claimed_by（schema 的 CHECK），故与已领取的行分成两个写入函数。 */
function addPending(id: string, tenantId: string, videoId: string, createdAt: number): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, created_by, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(id, tenantId, videoId, `任务 ${id.slice(-1)}`, ADMIN_ID, createdAt);
}

function addOwned(
  id: string,
  tenantId: string,
  videoId: string,
  claimedBy: string,
  createdAt: number,
  status: 'claimed' | 'submitted' | 'rejected' = 'claimed',
): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, claimed_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, tenantId, videoId, `任务 ${id.slice(-1)}`, status, claimedBy, createdAt, ADMIN_ID, createdAt);
}

/** 三个 pending 共用 created_at，专门用来验证同毫秒下的次序键。 */
function seedTasks(): void {
  addPending(T1_PENDING, TENANT_A, VIDEO_A, 1_000);
  addOwned(T1_CLAIMED_SELF, TENANT_A, VIDEO_A, ALICE_ID, 3_000);
  addOwned(T1_CLAIMED_PEER, TENANT_A, VIDEO_A, ALICE_PEER_ID, 4_000);
  addOwned(T1_SUBMITTED_SELF, TENANT_A, VIDEO_A, ALICE_ID, 5_000, 'submitted');

  addPending(T2_PENDING, TENANT_B, VIDEO_B, 1_000);
  addOwned(T2_CLAIMED_SELF, TENANT_B, VIDEO_B, BOB_ID, 2_000);
  addOwned(T2_SUBMITTED_SELF, TENANT_B, VIDEO_B, BOB_ID, 6_000, 'submitted');
  addOwned(T2_CLAIMED_BY_ALICE, TENANT_B, VIDEO_B, ALICE_ID, 9_000);

  addPending(T3_PENDING, TENANT_C, VIDEO_C, 1_000);
  addOwned(T3_CLAIMED_SELF, TENANT_C, VIDEO_C, CAROL_ID, 2_000);
  addOwned(T3_CLAIMED_PEER, TENANT_C, VIDEO_C, CAROL_PEER_ID, 7_000);
  addOwned(T3_SUBMITTED_SELF, TENANT_C, VIDEO_C, CAROL_ID, 8_000, 'submitted');
}

function ids(rows: { id: string }[]): string[] {
  return rows.map((row) => row.id);
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

beforeEach(() => {
  db = seed();
  seedTasks();
});

afterEach(() => {
  db.close();
});

describe('listForAnnotator 可见范围', () => {
  it('标注员只看到本租户的待领取任务与自己领取的任务', () => {
    expect(ids(listForAnnotator(db, TENANT_A, ALICE_ID, LIST_ALL))).toEqual(ALICE_VISIBLE);
  });

  it('标注员看不到同租户同事领取的任务', () => {
    expect(ids(listForAnnotator(db, TENANT_A, ALICE_ID, LIST_ALL))).not.toContain(T1_CLAIMED_PEER);
  });

  it('标注员看不到其他租户的待领取任务', () => {
    const foreignPending = ids(listForAnnotator(db, TENANT_A, ALICE_ID, LIST_ALL)).filter(
      (id) => id === T2_PENDING || id === T3_PENDING,
    );
    expect(foreignPending).toEqual([]);
  });

  it('标注员的结果里没有一条来自其他租户', () => {
    const rows = listForAnnotator(db, TENANT_A, ALICE_ID, LIST_ALL);
    expect(rows.every((row) => row.tenant_id === TENANT_A)).toBe(true);
  });

  it('标注员看不到其他租户里挂在自己名下的任务', () => {
    expect(ids(listForAnnotator(db, TENANT_A, ALICE_ID, LIST_ALL))).not.toContain(
      T2_CLAIMED_BY_ALICE,
    );
  });

  it('标注员的结果里没有被同租户同事领取的任务', () => {
    const peerOwned = listForAnnotator(db, TENANT_A, ALICE_ID, LIST_ALL).filter(
      (row) => row.claimed_by !== null && row.claimed_by !== ALICE_ID,
    );
    expect(peerOwned).toEqual([]);
  });
});

describe('管理员视图', () => {
  it('管理员看到全部任务（跨 3 个租户）', () => {
    expect(ids(listAll(db, LIST_ALL))).toEqual(ALL_IN_ORDER);
  });

  it('管理员的结果覆盖 3 个租户', () => {
    expect(new Set(listAll(db, LIST_ALL).map((row) => row.tenant_id)).size).toBe(3);
  });

  it('countAll 等于全部任务数', () => {
    expect(countAll(db)).toBe(TASK_COUNT);
  });
});

describe('排序与分页', () => {
  it('多次查询的顺序完全一致（同毫秒行有确定的次序）', () => {
    const runs = [ids(listAll(db, LIST_ALL)), ids(listAll(db, LIST_ALL)), ids(listAll(db, LIST_ALL))];
    expect(new Set(runs.map((run) => run.join(','))).size).toBe(1);
  });

  it('created_at 相同的行按 id 倒序排列', () => {
    const order = ids(listAll(db, LIST_ALL));
    expect(order.indexOf(T3_PENDING)).toBeLessThan(order.indexOf(T1_PENDING));
  });

  it('listAll 遵守 limit 与 offset', () => {
    expect(ids(listAll(db, { limit: 2, offset: 1 }))).toEqual(ALL_IN_ORDER.slice(1, 3));
  });

  it('countAll 不随分页变化', () => {
    expect({ counted: countAll(db), listed: listAll(db, { limit: 2, offset: 0 }).length }).toEqual({
      counted: TASK_COUNT,
      listed: 2,
    });
  });
});

describe('countForAnnotator 与 listForAnnotator 同条件', () => {
  it('两者的条数一致', () => {
    expect(countForAnnotator(db, TENANT_A, ALICE_ID)).toBe(
      listForAnnotator(db, TENANT_A, ALICE_ID, LIST_ALL).length,
    );
  });

  it('计数不把同租户同事领取的任务算进可见范围', () => {
    expect(countForAnnotator(db, TENANT_A, ALICE_ID)).toBe(ALICE_VISIBLE.length);
  });
});

describe('展示字段', () => {
  it('列表带出视频文件名与租户名', () => {
    expect(listForAnnotator(db, TENANT_A, ALICE_ID, LIST_ALL)[0]).toMatchObject({
      video_filename: 'a-demo.mp4',
      tenant_name: 'A 空间',
      claimed_by_name: '林小雨',
    });
  });

  it('时长取自任务所引用素材的时长', () => {
    expect(listForAnnotator(db, TENANT_A, ALICE_ID, LIST_ALL)[0].estimated_ms).toBe(VIDEO_A_MS);
  });
});

describe('listTasks 角色分派', () => {
  it('管理员拿到的总数与条数都是全部任务', () => {
    const result = listTasks(db, ADMIN, 1);
    expect({ total: result.total, count: result.items.length }).toEqual({
      total: TASK_COUNT,
      count: TASK_COUNT,
    });
  });

  it('管理员拿到的任务跨 3 个租户', () => {
    expect(new Set(listTasks(db, ADMIN, 1).items.map((row) => row.tenant_id)).size).toBe(3);
  });

  it('标注员拿到的条目与 listForAnnotator 一致', () => {
    expect(ids(listTasks(db, ALICE, 1).items)).toEqual(ALICE_VISIBLE);
  });

  it('标注员拿到的总数与列表条数一致', () => {
    const result = listTasks(db, ALICE, 1);
    expect(result.items.length).toBe(result.total);
  });

  it('页码非正整数时回落到第一页', () => {
    expect(ids(listTasks(db, ALICE, 0).items)).toEqual(ids(listTasks(db, ALICE, 1).items));
  });

  it('PAGE_SIZE 为 20', () => {
    expect(PAGE_SIZE).toBe(20);
  });
});

describe('畸形身份', () => {
  it('标注员缺少租户时抛 ForbiddenError，而不是返回空列表', () => {
    expect(capture(() => listTasks(db, BROKEN_ALICE, 1))).toEqual({
      threw: 'ForbiddenError',
      status: 403,
    });
  });

  it('标注员的租户为空串时同样抛错', () => {
    expect(capture(() => listTasks(db, { ...ALICE, tenantId: '' }, 1))).toEqual({
      threw: 'ForbiddenError',
      status: 403,
    });
  });
});
