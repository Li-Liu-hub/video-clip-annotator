/**
 * F1 提交事务：四写同事务、租户时区定日期、总量按片段算。
 *
 * 断言一律查库：service 的返回值可能对，落库仍可能不对。
 * 时间用固定瞬间（vi.setSystemTime）而不是 Date.now()，否则「按租户时区还是按服务器时区」
 * 这条判断只有在一天里的某些小时才暴露，测试会随机器和运行时刻飘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as submitPost } from '@/app/api/tasks/[id]/submit/route';
import { createDb, type DB } from '@/lib/db';
import { findLatestByTask } from '@/lib/db/repos/submission-repo';
import { AppError } from '@/lib/errors';
import { getCurrentUser } from '@/lib/server/current-user';
import type { SessionUser, TenantUser } from '@/lib/services/auth-service';
import { localDateOf } from '@/lib/services/daily-date';
import { submitTask } from '@/lib/services/submit-service';

// 401 / 403 用例需要伪造请求上下文；其余用例直接调 service，不经过这一层
vi.mock('@/lib/server/current-user', () => ({ getCurrentUser: vi.fn() }));

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbbbbbbbbbb';

const ADMIN_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
const BOB_ID = '4444444444444444';

const VIDEO_A = 'ddddddddddddddd1';

const T_MINE = 'a000000000000001';
const T_EMPTY = 'a000000000000002';
const T_SUBMITTED = 'a000000000000003';
const T_OTHER_TENANT = 'b000000000000001';
/** 从不写入库的 id：验证「不存在」这条分支 */
const GHOST_TASK = 'f000000000000000';

const S_MINE_A = 'c000000000000001';
const S_MINE_B = 'c000000000000002';

/**
 * 固定瞬间：2026-10-19T16:30Z。
 * UTC 日是 10-19，Asia/Shanghai 是 10-20 —— 两者不同，才能证明日期取自租户时区。
 */
const FIXED_NOW = Date.UTC(2026, 9, 19, 16, 30);
const SHANGHAI_DATE = '2026-10-20';

const VIDEO_MS = 60_000;
/** 两段合计 6500ms：刻意远小于视频时长，用来区分「片段时长之和」与「视频时长」 */
const SEG_A = { startMs: 1_000, endMs: 5_000 };
const SEG_B = { startMs: 10_000, endMs: 12_500 };
const TOTAL_MS = 4_000 + 2_500;

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
  insertUser.run(BOB_ID, TENANT_B, 'bob', '陈默', PASSWORD_HASH, 'annotator', 0);

  fresh
    .prepare(
      `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'video/mp4', ?, ?)`,
    )
    .run(VIDEO_A, 'a-demo.mp4', `${VIDEO_A}.mp4`, 1024, VIDEO_MS, ADMIN_ID, 0);

  return fresh;
}

function addClaimed(id: string, tenantId: string, claimedBy: string, videoId = VIDEO_A): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, claimed_at, created_by, created_at)
     VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?, 0)`,
  ).run(id, tenantId, videoId, `任务 ${id.slice(-1)}`, claimedBy, FIXED_NOW - 60_000, ADMIN_ID);
}

function addSubmitted(id: string): void {
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, video_id, title, status, claimed_by, claimed_at, created_by, created_at)
     VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, 0)`,
  ).run(id, TENANT_A, VIDEO_A, `任务 ${id.slice(-1)}`, ALICE_ID, FIXED_NOW - 60_000, ADMIN_ID);
}

function addSegment(id: string, taskId: string, tenantId: string, seg: { startMs: number; endMs: number }): void {
  db.prepare(
    `INSERT INTO segments (id, task_id, tenant_id, start_ms, end_ms, label, created_at)
     VALUES (?, ?, ?, ?, ?, '说话人A', 0)`,
  ).run(id, taskId, tenantId, seg.startMs, seg.endMs);
}

function seedTasks(): void {
  addClaimed(T_MINE, TENANT_A, ALICE_ID);
  addSegment(S_MINE_A, T_MINE, TENANT_A, SEG_A);
  addSegment(S_MINE_B, T_MINE, TENANT_A, SEG_B);

  // 领取了但一段都没标：空片段检查的对象
  addClaimed(T_EMPTY, TENANT_A, ALICE_ID);

  addSubmitted(T_SUBMITTED);

  // 另一租户的任务：对 ALICE 来说必须和「不存在」表现一致
  addClaimed(T_OTHER_TENANT, TENANT_B, BOB_ID);
  addSegment('c0000000000000ff', T_OTHER_TENANT, TENANT_B, SEG_A);
}

function countRows(table: 'submissions' | 'ledger_entries' | 'audit_logs' | 'segments'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function statusOf(taskId: string): string {
  return (db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string })
    .status;
}

type SnapshotRow = { total_ms: number; segment_count: number; segments_json: string; local_date: string; annotator_id: string };

function submissionOf(taskId: string): SnapshotRow {
  return db
    .prepare(
      `SELECT total_ms, segment_count, segments_json, local_date, annotator_id
         FROM submissions WHERE task_id = ?`,
    )
    .get(taskId) as SnapshotRow;
}

type LedgerRow = { delta_ms: number; entry_date: string; kind: string };

function ledgerOf(taskId: string): LedgerRow {
  return db
    .prepare('SELECT delta_ms, entry_date, kind FROM ledger_entries WHERE task_id = ?')
    .get(taskId) as LedgerRow;
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

/** 库里四张表的当前状态，用来一次性断言「什么都没发生」。 */
function worldState(taskId: string): Record<string, unknown> {
  return {
    submissions: countRows('submissions'),
    ledger: countRows('ledger_entries'),
    audit: countRows('audit_logs'),
    status: statusOf(taskId),
  };
}

beforeEach(() => {
  db = seed();
  seedTasks();
  vi.clearAllMocks();
  // 只冻结 Date：submit-service 通过 nowMs() 取当前时刻，冻结后日期断言与机器时区、运行时刻无关
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('localDateOf 时区换算', () => {
  it('纪元零点在 Asia/Shanghai 是 1970-01-01', () => {
    expect(localDateOf(0, 'Asia/Shanghai')).toBe('1970-01-01');
  });

  it('纪元零点在 UTC 是 1970-01-01', () => {
    expect(localDateOf(0, 'UTC')).toBe('1970-01-01');
  });

  it('同一瞬间在 UTC 与 Asia/Shanghai 落在不同日历日', () => {
    // 16:00 UTC = 次日 00:00 +08：服务器在哪个时区都不该改变这两个结果
    const instant = Date.UTC(2026, 9, 19, 16, 0);
    expect([localDateOf(instant, 'UTC'), localDateOf(instant, 'Asia/Shanghai')]).toEqual([
      '2026-10-19',
      '2026-10-20',
    ]);
  });

  it('非法时区抛错而不是静默退化成 UTC', () => {
    expect(() => localDateOf(0, 'Mars/Olympus')).toThrow();
  });
});

describe('提交成功', () => {
  it('写一行 submissions 快照', () => {
    submitTask(db, ALICE, T_MINE);
    expect(countRows('submissions')).toBe(1);
  });

  it('写一行 submit 类型的账本条目', () => {
    submitTask(db, ALICE, T_MINE);
    expect(ledgerOf(T_MINE).kind).toBe('submit');
  });

  it('任务状态变为 submitted', () => {
    submitTask(db, ALICE, T_MINE);
    expect(statusOf(T_MINE)).toBe('submitted');
  });

  it('total_ms 是片段时长之和，不是视频时长', () => {
    // 视频 60s，两段只标了 6.5s：计入的是 6.5s
    submitTask(db, ALICE, T_MINE);
    expect(submissionOf(T_MINE).total_ms).toBe(TOTAL_MS);
  });

  it('segment_count 等于片段条数', () => {
    submitTask(db, ALICE, T_MINE);
    expect(submissionOf(T_MINE).segment_count).toBe(2);
  });

  it('segments_json 是快照且不含 id', () => {
    submitTask(db, ALICE, T_MINE);
    const snapshot = JSON.parse(submissionOf(T_MINE).segments_json) as Record<string, unknown>[];
    expect(snapshot.every((row) => !('id' in row))).toBe(true);
  });

  it('segments_json 保留每段的起止与标签', () => {
    submitTask(db, ALICE, T_MINE);
    const snapshot = JSON.parse(submissionOf(T_MINE).segments_json) as Record<string, unknown>[];
    expect(snapshot).toEqual([
      { startMs: SEG_A.startMs, endMs: SEG_A.endMs, label: '说话人A' },
      { startMs: SEG_B.startMs, endMs: SEG_B.endMs, label: '说话人A' },
    ]);
  });

  it('local_date 按租户时区算，落在上海的那一天而不是 UTC 的那一天', () => {
    submitTask(db, ALICE, T_MINE);
    expect(submissionOf(T_MINE).local_date).toBe(SHANGHAI_DATE);
  });

  it('账本 entry_date 与提交的 local_date 一致', () => {
    submitTask(db, ALICE, T_MINE);
    expect(ledgerOf(T_MINE).entry_date).toBe(submissionOf(T_MINE).local_date);
  });

  it('账本 delta_ms 等于 total_ms', () => {
    submitTask(db, ALICE, T_MINE);
    expect(ledgerOf(T_MINE).delta_ms).toBe(TOTAL_MS);
  });

  it('快照记在提交人名下', () => {
    submitTask(db, ALICE, T_MINE);
    expect(submissionOf(T_MINE).annotator_id).toBe(ALICE_ID);
  });

  it('first_submitted_at 记为提交时刻', () => {
    submitTask(db, ALICE, T_MINE);
    const row = db.prepare('SELECT first_submitted_at FROM tasks WHERE id = ?').get(T_MINE) as {
      first_submitted_at: number | null;
    };
    expect(row.first_submitted_at).toBe(FIXED_NOW);
  });

  it('写一条 task.submit 审计并指向该任务', () => {
    submitTask(db, ALICE, T_MINE);
    const row = db
      .prepare(`SELECT target_id FROM audit_logs WHERE action = 'task.submit'`)
      .get() as { target_id: string };
    expect(row.target_id).toBe(T_MINE);
  });

  it('提交后 segments 行原样保留，工作记录不丢', () => {
    const before = countRows('segments');
    submitTask(db, ALICE, T_MINE);
    expect(countRows('segments')).toBe(before);
  });

  it('返回的 submissionId 指向刚落库的那条快照', () => {
    const { submissionId } = submitTask(db, ALICE, T_MINE);
    const row = db.prepare('SELECT id FROM submissions WHERE task_id = ?').get(T_MINE) as {
      id: string;
    };
    expect(submissionId).toBe(row.id);
  });

  it('findLatestByTask 能取回刚写入的快照', () => {
    const { submissionId } = submitTask(db, ALICE, T_MINE);
    expect(findLatestByTask(db, TENANT_A, T_MINE)?.id).toBe(submissionId);
  });
});

describe('空片段', () => {
  it('提交没有片段的已领取任务抛 StateConflictError', () => {
    expect(capture(() => submitTask(db, ALICE, T_EMPTY))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('空片段被拒后四张表与任务状态都没变', () => {
    swallow(() => submitTask(db, ALICE, T_EMPTY));
    expect(worldState(T_EMPTY)).toEqual({ submissions: 0, ledger: 0, audit: 0, status: 'claimed' });
  });
});

describe('状态冲突与归属', () => {
  it('重复提交第二次抛 StateConflictError', () => {
    submitTask(db, ALICE, T_MINE);
    expect(capture(() => submitTask(db, ALICE, T_MINE))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('重复提交后 submissions 仍只有一行', () => {
    submitTask(db, ALICE, T_MINE);
    swallow(() => submitTask(db, ALICE, T_MINE));
    expect(countRows('submissions')).toBe(1);
  });

  it('重复提交后账本仍只有一条，不重复入账', () => {
    submitTask(db, ALICE, T_MINE);
    swallow(() => submitTask(db, ALICE, T_MINE));
    expect(countRows('ledger_entries')).toBe(1);
  });

  it('已提交的任务再提交抛 StateConflictError', () => {
    expect(capture(() => submitTask(db, ALICE, T_SUBMITTED))).toEqual({
      threw: 'StateConflictError',
      status: 409,
    });
  });

  it('提交别人的任务抛 NotFoundError 而不是 403', () => {
    // 跨租户必须表现成「不存在」：403 等于承认这条任务存在
    expect(capture(() => submitTask(db, ALICE, T_OTHER_TENANT))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });

  it('别人的任务被拒后对方任务仍是 claimed', () => {
    swallow(() => submitTask(db, ALICE, T_OTHER_TENANT));
    expect(statusOf(T_OTHER_TENANT)).toBe('claimed');
  });

  it('提交不存在的任务抛 NotFoundError', () => {
    expect(capture(() => submitTask(db, ALICE, GHOST_TASK))).toEqual({
      threw: 'NotFoundError',
      status: 404,
    });
  });

  it('提交失败后没有留下任何提交或账本', () => {
    swallow(() => submitTask(db, ALICE, T_SUBMITTED));
    expect([countRows('submissions'), countRows('ledger_entries')]).toEqual([0, 0]);
  });
});

describe('审计严格模式', () => {
  it('审计写入失败时提交抛错', () => {
    db.exec(
      `CREATE TRIGGER trg_test_audit_down BEFORE INSERT ON audit_logs
       BEGIN SELECT RAISE(ABORT, 'AUDIT_DOWN'); END;`,
    );
    expect(capture(() => submitTask(db, ALICE, T_MINE)).threw).not.toBe('none');
  });

  it('审计写入失败时整个提交回滚：无提交、无账本、状态未变', () => {
    db.exec(
      `CREATE TRIGGER trg_test_audit_down BEFORE INSERT ON audit_logs
       BEGIN SELECT RAISE(ABORT, 'AUDIT_DOWN'); END;`,
    );
    swallow(() => submitTask(db, ALICE, T_MINE));
    expect(worldState(T_MINE)).toEqual({ submissions: 0, ledger: 0, audit: 0, status: 'claimed' });
  });
});

describe('API 权限', () => {
  const CONTEXT = { params: Promise.resolve({ id: T_MINE }) };

  function request(): Request {
    return new Request(`http://localhost/api/tasks/${T_MINE}/submit`, { method: 'POST' });
  }

  it('未登录调用 submit 返回 401', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await submitPost(request(), CONTEXT);
    expect(res.status).toBe(401);
  });

  it('管理员调用 submit 返回 403', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    const res = await submitPost(request(), CONTEXT);
    expect(res.status).toBe(403);
  });
});

describe('时区：租户时区决定记哪一天', () => {
  it('租户时区是 UTC 时按 UTC 记日，与本机时区无关', () => {
    // 这条是本机恒盲区的唯一解药：本机在 Asia/Shanghai，
    // 任何「用服务器时区算」的实现在这里都会把 16:30Z 算成次日，从而变红。
    // FIXED_NOW = 2026-10-19 16:30Z → UTC 是 19 日，上海是 20 日
    submitTask(db, { ...ALICE, timezone: 'UTC' }, T_MINE);

    const row = findLatestByTask(db, TENANT_A, T_MINE);
    expect(row?.local_date).toBe('2026-10-19');
  });

  it('同一任务在上海时区记的是次日', () => {
    submitTask(db, { ...ALICE, timezone: 'Asia/Shanghai' }, T_MINE);

    const row = findLatestByTask(db, TENANT_A, T_MINE);
    expect(row?.local_date).toBe('2026-10-20');
  });
});

describe('重复提交：旧快照要被标记为已取代', () => {
  it('提交两次后，未取代的快照只剩一条', () => {
    // 退回后重新提交会留下多条历史快照。不标记 superseded_by 的话，
    // F2 的 findCurrentByTask 取 rowid 最小那条（旧的），
    // 下一次退回按旧金额、旧日期冲正 —— 账静默错一笔，用例全绿也看不出来。
    submitTask(db, ALICE, T_MINE);
    // 造一条历史快照：直接插一行 superseded_by 为 NULL 的旧记录，模拟上一轮提交
    db.prepare(
      `INSERT INTO submissions
         (id, task_id, tenant_id, annotator_id, submitted_at, local_date,
          total_ms, segment_count, segments_json, superseded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      'old0000000000001', T_MINE, TENANT_A, ALICE_ID, FIXED_NOW - 86_400_000,
      '2026-10-18', 1_000, 1, '[]', FIXED_NOW - 86_400_000,
    );

    // 再来一次提交（先把它改回 claimed，模拟 F3 接通后的重新提交）
    db.prepare("UPDATE tasks SET status = 'claimed' WHERE id = ?").run(T_MINE);
    submitTask(db, ALICE, T_MINE);

    const open = db
      .prepare('SELECT COUNT(*) AS n FROM submissions WHERE task_id = ? AND superseded_by IS NULL')
      .get(T_MINE) as { n: number };
    expect(open.n).toBe(1);
  });
});
