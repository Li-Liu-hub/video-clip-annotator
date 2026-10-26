/**
 * G1 统计查询：账本是唯一数据源、三个维度、闭区间、角色可见范围与参数校验。
 *
 * 断言一律比对整份结果（dimension + 全部行）：少一行、多一列、顺序变了都会现形。
 * 「同租户两个标注员」需要先移除「一租户一标注员」的唯一索引（见 seed）——
 * 否则 annotator_id 谓词在「租户内只有我一个人」的假设下永远测不出来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as statsGet } from '@/app/api/stats/route';
import { createDb, type DB } from '@/lib/db';
import { insertEntry } from '@/lib/db/repos/ledger-repo';
import { insertSubmission } from '@/lib/db/repos/submission-repo';
import { AppError } from '@/lib/errors';
import { getCurrentUser } from '@/lib/server/current-user';
import type { SessionUser, TenantUser } from '@/lib/services/auth-service';
import { listStats, type StatsDimension, type StatsResult } from '@/lib/services/stats-service';

// 401 用例需要伪造请求上下文；其余用例直接调 service，不经过这一层
vi.mock('@/lib/server/current-user', () => ({ getCurrentUser: vi.fn() }));

/** 路由通过 getDb 取连接；测试把内存库从这里递进去 */
const HOLDER: { db: DB } = { db: null as unknown as DB };
vi.mock('@/lib/server/db', () => ({ getDb: () => HOLDER.db }));

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbbbbbbbbbb';

const ADMIN_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
/** 同租户同事：schema 的唯一索引不允许，本场景为验证 annotator_id 谓词而造 */
const PEER_ID = '3333333333333333';
const BOB_ID = '4444444444444444';
/** 同租户、一条账都没有：验证「没有记录的人不出现」 */
const CAROL_ID = '5555555555555555';

const VIDEO_A = 'ddddddddddddddd1';

const T_A1 = 'a100000000000001';
const T_A2 = 'a100000000000002';
const T_A3 = 'a100000000000003';
const T_A5 = 'a100000000000005';
const T_A6 = 'a100000000000006';
const T_B1 = 'b100000000000001';

const S_1 = 'c000000000000001';
const S_2 = 'c000000000000002';
const S_3 = 'c000000000000003';
const S_5 = 'c000000000000005';
const S_6 = 'c000000000000006';
const S_B1 = 'c0000000000000b1';

const D_0930 = '2026-09-30';
const D_1001 = '2026-10-01';
const D_1002 = '2026-10-02';

/** 测试默认区间：跨月查询，含数据日与空日 */
const RANGE = { from: D_1001, to: '2026-10-31' };
const ALICE_DETAILS = [
  { annotatorId: ALICE_ID, displayName: '林小雨', date: D_1001, taskId: T_A1, title: '任务甲', totalMs: 1_000, entryCount: 1, segmentCount: 1, submitCount: 1, revokeCount: 0 },
  { annotatorId: ALICE_ID, displayName: '林小雨', date: D_1001, taskId: T_A2, title: '任务乙', totalMs: 2_000, entryCount: 1, segmentCount: 1, submitCount: 1, revokeCount: 0 },
];

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

const PEER: TenantUser = { ...ALICE, id: PEER_ID, username: 'peer', displayName: '周予安' };

const ADMIN: SessionUser = {
  id: ADMIN_ID,
  username: 'admin',
  displayName: '平台管理员',
  role: 'admin',
  tenantId: null,
  tenantName: null,
  timezone: 'Asia/Shanghai',
};

/** role 是标注员但租户为空：users 行被改坏后的畸形身份 */
const BROKEN_ALICE: SessionUser = { ...ALICE, tenantId: null };

let db: DB;
/** 账本条目 id 递增，避免主键撞车 */
let entrySeq = 0;

function seed(): DB {
  const fresh = createDb(':memory:');
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
  insertUser.run(PEER_ID, TENANT_A, 'peer', '周予安', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(CAROL_ID, TENANT_A, 'carol', '吴桐', PASSWORD_HASH, 'annotator', 0);
  insertUser.run(BOB_ID, TENANT_B, 'bob', '陈默', PASSWORD_HASH, 'annotator', 0);

  fresh
    .prepare(
      `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
       VALUES (?, 'a-demo.mp4', ?, 1024, 60000, 'video/mp4', ?, 0)`,
    )
    .run(VIDEO_A, `${VIDEO_A}.mp4`, ADMIN_ID);

  return fresh;
}

/** 非 pending 的任务必须带 claimed_by（schema 的 CHECK），故统一按 submitted 写。 */
function addTask(id: string, tenantId: string, title: string, claimedBy: string): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, claimed_at, created_by, created_at)
     VALUES (?, ?, ?, ?, 'submitted', ?, 0, ?, 0)`,
  ).run(id, tenantId, VIDEO_A, title, claimedBy, ADMIN_ID);
}

function addSubmission(args: {
  id: string;
  taskId: string;
  tenantId: string;
  annotatorId: string;
  localDate: string;
  totalMs: number;
}): void {
  insertSubmission(db, {
    id: args.id,
    taskId: args.taskId,
    tenantId: args.tenantId,
    annotatorId: args.annotatorId,
    submittedAt: 0,
    localDate: args.localDate,
    totalMs: args.totalMs,
    segmentCount: 1,
    segmentsJson: '[]',
    createdAt: 0,
  });
}

function addEntry(args: {
  taskId: string;
  tenantId: string;
  annotatorId: string;
  submissionId: string;
  deltaMs: number;
  entryDate: string;
  kind: 'submit' | 'revoke';
}): void {
  entrySeq += 1;
  insertEntry(db, {
    id: `e${String(entrySeq).padStart(15, '0')}`,
    tenantId: args.tenantId,
    taskId: args.taskId,
    submissionId: args.submissionId,
    annotatorId: args.annotatorId,
    deltaMs: args.deltaMs,
    entryDate: args.entryDate,
    kind: args.kind,
    createdAt: 0,
  });
}

/** 提交成功时快照与账本成对落库，这里按同一顺序造。 */
function addSubmitChain(args: {
  submissionId: string;
  taskId: string;
  tenantId: string;
  annotatorId: string;
  localDate: string;
  deltaMs: number;
}): void {
  addSubmission({
    id: args.submissionId,
    taskId: args.taskId,
    tenantId: args.tenantId,
    annotatorId: args.annotatorId,
    localDate: args.localDate,
    totalMs: args.deltaMs,
  });
  addEntry({
    taskId: args.taskId,
    tenantId: args.tenantId,
    annotatorId: args.annotatorId,
    submissionId: args.submissionId,
    deltaMs: args.deltaMs,
    entryDate: args.localDate,
    kind: 'submit',
  });
}

/**
 * 基础账本：A 空间 alice 10-01 两笔、09-30 一笔（区间外）；peer 10-02 一笔提交一笔冲正（净额 0）；
 * B 空间 bob 10-01 一笔（跨租户隔离用）。
 */
function seedLedger(): void {
  addTask(T_A1, TENANT_A, '任务甲', ALICE_ID);
  addTask(T_A2, TENANT_A, '任务乙', ALICE_ID);
  addTask(T_A3, TENANT_A, '任务丙', PEER_ID);
  addTask(T_A5, TENANT_A, '任务戊', ALICE_ID);
  addTask(T_A6, TENANT_A, '任务己', ALICE_ID);
  addTask(T_B1, TENANT_B, '任务丁', BOB_ID);

  addSubmitChain({
    submissionId: S_1,
    taskId: T_A1,
    tenantId: TENANT_A,
    annotatorId: ALICE_ID,
    localDate: D_1001,
    deltaMs: 1_000,
  });
  addSubmitChain({
    submissionId: S_2,
    taskId: T_A2,
    tenantId: TENANT_A,
    annotatorId: ALICE_ID,
    localDate: D_1001,
    deltaMs: 2_000,
  });

  // 退回：冲正记在原提交日，于是 10-02 的净额为 0
  addSubmitChain({
    submissionId: S_3,
    taskId: T_A3,
    tenantId: TENANT_A,
    annotatorId: PEER_ID,
    localDate: D_1002,
    deltaMs: 4_000,
  });
  addEntry({
    taskId: T_A3,
    tenantId: TENANT_A,
    annotatorId: PEER_ID,
    submissionId: S_3,
    deltaMs: -4_000,
    entryDate: D_1002,
    kind: 'revoke',
  });

  addSubmitChain({
    submissionId: S_5,
    taskId: T_A5,
    tenantId: TENANT_A,
    annotatorId: ALICE_ID,
    localDate: D_0930,
    deltaMs: 500,
  });

  addSubmitChain({
    submissionId: S_B1,
    taskId: T_B1,
    tenantId: TENANT_B,
    annotatorId: BOB_ID,
    localDate: D_1001,
    deltaMs: 8_000,
  });
}

/**
 * 入参维度是字面量，返回类型随之收窄 —— listStats 的联合返回不会自动跟着入参走，
 * 故在此断言一次；断言错了会在下面的整份比对里立刻变红。
 */
function stats<D extends StatsDimension>(
  actor: SessionUser,
  dimension: D,
  range = RANGE,
): Extract<StatsResult, { dimension: D }> {
  const result = listStats(db, actor, { dimension, ...range });
  return result as Extract<StatsResult, { dimension: D }>;
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
  HOLDER.db = db;
  entrySeq = 0;
  seedLedger();
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

describe('账本是唯一数据源', () => {
  it('只有提交快照、没有账本条目时不计入工作量', () => {
    // 从 submissions 反推会把这 7000 算进去；账本没记就是没记
    addSubmission({
      id: S_6,
      taskId: T_A6,
      tenantId: TENANT_A,
      annotatorId: ALICE_ID,
      localDate: D_1001,
      totalMs: 7_000,
    });
    expect(stats(ALICE, 'day')).toEqual({
      dimension: 'day',
      rows: [{ date: D_1001, totalMs: 3_000, entryCount: 2 }],
    });
  });

  it('冲正条目参与净额：10-02 是 0 而不是 4000', () => {
    expect(stats(ADMIN, 'day').rows).toEqual([
      { date: D_1001, totalMs: 11_000, entryCount: 3 },
      { date: D_1002, totalMs: 0, entryCount: 2 },
    ]);
  });
});

describe('按日聚合', () => {
  it('同一天两条提交合计为两条之和', () => {
    expect(stats(ALICE, 'day')).toEqual({
      dimension: 'day',
      rows: [{ date: D_1001, totalMs: 3_000, entryCount: 2 }],
    });
  });

  it('同一天一条冲正 -1000 后净额变成 2000', () => {
    addEntry({
      taskId: T_A2,
      tenantId: TENANT_A,
      annotatorId: ALICE_ID,
      submissionId: S_2,
      deltaMs: -1_000,
      entryDate: D_1001,
      kind: 'revoke',
    });
    expect(stats(ALICE, 'day').rows).toEqual([{ date: D_1001, totalMs: 2_000, entryCount: 3 }]);
  });

  it('净额为 0 的日期仍出现在结果里，条目数如实反映', () => {
    expect(stats(ADMIN, 'day').rows[1]).toEqual({ date: D_1002, totalMs: 0, entryCount: 2 });
  });

  it('日期按升序排列，没有账目的日期不补零', () => {
    // 10-03 到 10-31 一条账都没有：三天不出现，也不出现 0 行
    expect(stats(ADMIN, 'day').rows.map((row) => row.date)).toEqual([D_1001, D_1002]);
  });

  it('from 是闭区间：区间首日当天的账要算进来', () => {
    expect(stats(ALICE, 'day').rows.map((row) => row.date)).toEqual([D_1001]);
  });

  it('to 是闭区间：区间末日当天的账要算进来', () => {
    expect(
      stats(ALICE, 'day', { from: D_0930, to: D_1001 }).rows.map((row) => row.date),
    ).toEqual([D_0930, D_1001]);
  });

  it('区间外的账不计入', () => {
    expect(stats(ALICE, 'day').rows.map((row) => row.date)).not.toContain(D_0930);
  });
});

describe('按人聚合', () => {
  it('同一个人在不同日期提交同一个任务时分开列出', () => {
    addSubmitChain({ submissionId: S_6, taskId: T_A1, tenantId: TENANT_A, annotatorId: ALICE_ID, localDate: D_1002, deltaMs: 3_000 });
    expect(stats(ALICE, 'annotator').rows).toEqual([
      { ...ALICE_DETAILS[0], date: D_1002, totalMs: 3_000 }, ...ALICE_DETAILS,
    ]);
  });

  it('一次提交有三个片段时有效片段数为三，冲正后归零', () => {
    db.prepare('UPDATE submissions SET segment_count = 3 WHERE id = ?').run(S_3);
    expect(stats(PEER, 'annotator').rows[0]).toMatchObject({ segmentCount: 0, submitCount: 1, revokeCount: 1, totalMs: 0 });
  });

  it('有效片段数读取提交快照数量而非账本行数', () => {
    db.prepare('UPDATE submissions SET segment_count = 3 WHERE id = ?').run(S_1);
    expect(stats(ALICE, 'annotator').rows[0]).toMatchObject({ segmentCount: 3, entryCount: 1 });
  });

  it('按人明细同样挡住属于其他租户但标注员为自己的账目', () => {
    addEntry({ taskId: T_B1, tenantId: TENANT_B, annotatorId: ALICE_ID, submissionId: S_B1, deltaMs: 9_000, entryDate: D_1001, kind: 'submit' });
    expect(stats(ALICE, 'annotator').rows).toEqual(ALICE_DETAILS);
  });
  it('按区间总量排列人员，人员内拆分日期和任务', () => {
    expect(stats(ADMIN, 'annotator')).toEqual({
      dimension: 'annotator',
      rows: [
        { annotatorId: BOB_ID, displayName: '陈默', date: D_1001, taskId: T_B1, title: '任务丁', totalMs: 8_000, entryCount: 1, segmentCount: 1, submitCount: 1, revokeCount: 0 },
        ...ALICE_DETAILS,
        { annotatorId: PEER_ID, displayName: '周予安', date: D_1002, taskId: T_A3, title: '任务丙', totalMs: 0, entryCount: 2, segmentCount: 0, submitCount: 1, revokeCount: 1 },
      ],
    });
  });

  it('一条账都没有的标注员不出现在结果里', () => {
    expect(stats(ADMIN, 'annotator').rows.map((row) => row.annotatorId)).not.toContain(CAROL_ID);
  });
});

describe('按任务聚合', () => {
  it('提交与退回次数分别计数，总量取净额，按 totalMs 降序', () => {
    expect(stats(ADMIN, 'task')).toEqual({
      dimension: 'task',
      rows: [
        { taskId: T_B1, title: '任务丁', totalMs: 8_000, submitCount: 1, revokeCount: 0 },
        { taskId: T_A2, title: '任务乙', totalMs: 2_000, submitCount: 1, revokeCount: 0 },
        { taskId: T_A1, title: '任务甲', totalMs: 1_000, submitCount: 1, revokeCount: 0 },
        { taskId: T_A3, title: '任务丙', totalMs: 0, submitCount: 1, revokeCount: 1 },
      ],
    });
  });
});

describe('租户与角色隔离', () => {
  it('别的租户同日的账不计入标注员视图', () => {
    expect(stats(ALICE, 'day').rows[0].totalMs).toBe(3_000);
  });

  it('账本行的租户不属于本租户时，即使标注员是自己也不计入', () => {
    // 脏数据：annotator 是 alice，tenant 却是 B。少了 tenant_id 谓词，这类行会被算进 alice 的账 ——
    // 标注员谓词只能挡住「别人」，租户谓词才是跨租户这道的最后防线
    addEntry({
      taskId: T_B1,
      tenantId: TENANT_B,
      annotatorId: ALICE_ID,
      submissionId: S_B1,
      deltaMs: 9_000,
      entryDate: D_1001,
      kind: 'submit',
    });
    expect(stats(ALICE, 'day')).toEqual({
      dimension: 'day',
      rows: [{ date: D_1001, totalMs: 3_000, entryCount: 2 }],
    });
  });

  it('管理员按日含其他租户的账', () => {
    expect(stats(ADMIN, 'day').rows[0]).toEqual({ date: D_1001, totalMs: 11_000, entryCount: 3 });
  });

  it('标注员按人只出自己的任务明细', () => {
    expect(stats(ALICE, 'annotator')).toEqual({
      dimension: 'annotator',
      rows: ALICE_DETAILS,
    });
  });

  it('同租户同事的查询只出自己的', () => {
    expect(stats(PEER, 'annotator').rows.map((row) => row.annotatorId)).toEqual([PEER_ID]);
  });

  it('标注员按任务看不到同租户同事的任务', () => {
    expect(stats(ALICE, 'task').rows.map((row) => row.taskId)).toEqual([T_A2, T_A1]);
  });

  it('管理员看到各标注员的合计', () => {
    expect(stats(ADMIN, 'annotator').rows.reduce((sum, row) => sum + row.totalMs, 0)).toBe(11_000);
  });

  it('标注员身份缺租户时抛 ForbiddenError 而不是看全部', () => {
    expect(capture(() => stats(BROKEN_ALICE, 'day'))).toEqual({
      threw: 'ForbiddenError',
      status: 403,
    });
  });
});

describe('参数校验', () => {
  it('非法 dimension 抛 ValidationError', () => {
    expect(capture(() => stats(ADMIN, 'week' as StatsDimension))).toEqual({
      threw: 'ValidationError',
      status: 400,
    });
  });

  it('日期缺位补零抛 ValidationError', () => {
    expect(
      capture(() => listStats(db, ADMIN, { dimension: 'day', from: '2026-1-01', to: D_1001 })),
    ).toEqual({ threw: 'ValidationError', status: 400 });
  });

  it('日期用斜杠分隔抛 ValidationError', () => {
    expect(
      capture(() => listStats(db, ADMIN, { dimension: 'day', from: '2026/10/01', to: D_1001 })),
    ).toEqual({ threw: 'ValidationError', status: 400 });
  });

  it('2 月 31 日抛 ValidationError，而不是静默返回空数组', () => {
    // 静默返回空数组会让用户以为「这段时间没数据」，
    // 与 from > to 返回空数组是同一个问题：调用方写错了却看不出来
    expect(capture(() => listStats(db, ALICE, { dimension: 'day', from: '2026-02-31', to: '2026-03-01' }))).toEqual({
      threw: 'ValidationError',
      status: 400,
    });
  });

  it('非闰年的 2 月 29 日抛 ValidationError', () => {
    expect(capture(() => listStats(db, ALICE, { dimension: 'day', from: '2025-02-29', to: '2025-03-01' }))).toEqual({
      threw: 'ValidationError',
      status: 400,
    });
  });

  it('13 月抛 ValidationError', () => {
    expect(capture(() => listStats(db, ALICE, { dimension: 'day', from: '2026-13-01', to: '2026-13-02' }))).toEqual({
      threw: 'ValidationError',
      status: 400,
    });
  });

  it('0 月抛 ValidationError', () => {
    expect(capture(() => listStats(db, ALICE, { dimension: 'day', from: '2026-00-10', to: '2026-01-10' }))).toEqual({
      threw: 'ValidationError',
      status: 400,
    });
  });

  it('闰年的 2 月 29 日可以查询', () => {
    // 2024 是闰年：校验过严的话这里会误拒
    expect(capture(() => listStats(db, ALICE, { dimension: 'day', from: '2024-02-29', to: '2024-02-29' }))).toEqual({
      threw: 'none',
      status: 0,
    });
  });

  it('from 等于 to 时返回该日数据', () => {
    expect(listStats(db, ALICE, { dimension: 'day', from: D_1001, to: D_1001 }).rows.length).toBe(1);
  });

  it('from 晚于 to 抛 ValidationError，而不是返回空数组', () => {
    expect(
      capture(() => listStats(db, ADMIN, { dimension: 'day', from: D_1002, to: D_1001 })),
    ).toEqual({ threw: 'ValidationError', status: 400 });
  });
});

describe('GET /api/stats', () => {
  function request(query: string): Request {
    return new Request(`http://localhost/api/stats${query}`);
  }

  it('未登录返回 401', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await statsGet(request(`?dim=day&from=${D_1001}&to=${D_1002}`));
    expect(res.status).toBe(401);
  });

  it('管理员按日查询返回按日数组', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await statsGet(request(`?dim=day&from=${D_1001}&to=${D_1002}`));
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 200,
      body: {
        ok: true,
        dimension: 'day',
        rows: [
          { date: D_1001, totalMs: 11_000, entryCount: 3 },
          { date: D_1002, totalMs: 0, entryCount: 2 },
        ],
      },
    });
  });

  it('标注员按人查询只看到自己的明细', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ALICE);
    const res = await statsGet(request(`?dim=annotator&from=${D_1001}&to=${D_1002}`));
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 200,
      body: {
        ok: true,
        dimension: 'annotator',
        rows: ALICE_DETAILS,
      },
    });
  });

  it('非法 dimension 返回 400', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await statsGet(request(`?dim=week&from=${D_1001}&to=${D_1002}`));
    expect(res.status).toBe(400);
  });
});

describe('冲正归原提交日，不是退回当天', () => {
  it('跨日退回：原日期净额归零，退回当天没有行', () => {
    // createdAt 必须给真实时间戳。全用 0 的话，「按 created_at 分组」的错误实现
    // 会把所有日期算成 1970-01-01，用例红了但红的不是这件事 —— 靠偶然正确。
    const submittedAt = Date.UTC(2026, 9, 20, 10, 0);
    const rejectedAt = Date.UTC(2026, 9, 25, 15, 0);
    const insert = db.prepare(
      `INSERT INTO ledger_entries
         (id, tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('e900000000000001', TENANT_A, T_A1, S_1, ALICE_ID, 5_000, '2026-10-20', 'submit', submittedAt);
    insert.run('e900000000000002', TENANT_A, T_A1, S_1, ALICE_ID, -5_000, '2026-10-20', 'revoke', rejectedAt);

    // 原提交日：净额 0，但两笔都在
    const onSubmitDay = listStats(db, ALICE, { dimension: 'day', from: '2026-10-20', to: '2026-10-20' });
    // StatsResult 是联合类型，取行前先按 dimension 窄化；维度分派错了会落到空数组，断言照样红
    const onSubmitDayRows = onSubmitDay.dimension === 'day' ? onSubmitDay.rows : [];
    expect({ totalMs: onSubmitDayRows[0]?.totalMs, entryCount: onSubmitDayRows[0]?.entryCount }).toEqual({
      totalMs: 0,
      entryCount: 2,
    });

    // 退回当天：什么行都不该有 —— 冲正记的是原日期
    const onRejectDay = listStats(db, ALICE, { dimension: 'day', from: '2026-10-25', to: '2026-10-25' });
    expect(onRejectDay.rows).toEqual([]);
  });
});
