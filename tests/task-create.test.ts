/**
 * 建任务：一次为多个租户各建一条，全部成功或全部不落库，每条附一条审计。
 *
 * 事务性是本文件的核心：只断言「抛了 NotFoundError」会漏掉「前几个租户已经落库」，
 * 因此「行数一行不变」单列一个用例，用调用前后的 COUNT(*) 对比。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/tasks/route';
import { createDb, type DB } from '@/lib/db';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { getCurrentUser } from '@/lib/server/current-user';
import type { SessionUser } from '@/lib/services/auth-service';
import { createTasks, MAX_TITLE_LENGTH, type CreateTasksInput } from '@/lib/services/task-service';

// 403 用例需要伪造请求上下文；其余用例直接调 service，不经过这一层
vi.mock('@/lib/server/current-user', () => ({ getCurrentUser: vi.fn() }));

const TENANT_A = 'aaaaaaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbbbbbbbbbb';
/** 从不写入库的租户 id：验证「任一租户不存在」这条分支 */
const GHOST_TENANT = 'ffffffffffffffff';

const ADMIN_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
const VIDEO_ID = 'dddddddddddddddd';
const GHOST_VIDEO = 'ddddddddddddddd0';

const PASSWORD_HASH = 'scrypt$00$00';
const VIDEO_MS = 30_000;
const TITLE = '第 3 批 · 装配线上料';

const ADMIN: SessionUser = {
  id: ADMIN_ID,
  username: 'admin',
  displayName: '平台管理员',
  role: 'admin',
  tenantId: null,
  tenantName: null,
  timezone: 'Asia/Shanghai',
};

const ANNOTATOR: SessionUser = {
  id: ALICE_ID,
  username: 'alice',
  displayName: '林小雨',
  role: 'annotator',
  tenantId: TENANT_A,
  tenantName: '林小雨的工作空间',
  timezone: 'Asia/Shanghai',
};

let db: DB;

function seed(): DB {
  const fresh = createDb(':memory:');

  const insertTenant = fresh.prepare(
    'INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)',
  );
  insertTenant.run(TENANT_A, '林小雨的工作空间', 'Asia/Shanghai', 0);
  insertTenant.run(TENANT_B, '陈默的工作空间', 'Asia/Shanghai', 0);

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
    .run(VIDEO_ID, 'aloha-coffee.mp4', `${VIDEO_ID}.mp4`, 1024 * 1024, VIDEO_MS, ADMIN_ID, 0);

  return fresh;
}

function buildInput(overrides: Partial<CreateTasksInput> = {}): CreateTasksInput {
  return { videoId: VIDEO_ID, tenantIds: [TENANT_A, TENANT_B], title: TITLE, ...overrides };
}

/** 直接查表：断言的是库里的状态，不是 service 的返回值。 */
function countTasks(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
  return row.n;
}

function countTasksByTenant(): Record<string, number> {
  const rows = db
    .prepare('SELECT tenant_id, COUNT(*) AS n FROM tasks GROUP BY tenant_id')
    .all() as { tenant_id: string; n: number }[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.tenant_id] = row.n;
  return counts;
}

function auditTargetIds(): string[] {
  const rows = db
    .prepare(`SELECT target_id FROM audit_logs WHERE action = 'task.create'`)
    .all() as { target_id: string }[];
  return rows.map((row) => row.target_id);
}

/** 吞掉预期内的异常：抛错本身由相邻用例断言，这里只关心是否落库。 */
function swallow(fn: () => void): void {
  try {
    fn();
  } catch {
    // 预期抛错，见相邻用例
  }
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db = seed();
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

describe('createTasks 成功路径', () => {
  it('为 2 个租户建任务时返回 2 个 id', () => {
    expect(createTasks(db, ADMIN, buildInput()).ids).toHaveLength(2);
  });

  it('库中新增的任务数等于勾选的租户数', () => {
    createTasks(db, ADMIN, buildInput());
    expect(countTasks()).toBe(2);
  });

  it('每个租户各分到一条任务', () => {
    createTasks(db, ADMIN, buildInput());
    expect(countTasksByTenant()).toEqual({ [TENANT_A]: 1, [TENANT_B]: 1 });
  });

  it('新建的任务状态是 pending 且没有领取人', () => {
    createTasks(db, ADMIN, buildInput());
    const rows = db.prepare('SELECT status, claimed_by FROM tasks').all() as {
      status: string;
      claimed_by: string | null;
    }[];
    expect(rows.map((row) => ({ status: row.status, claimedBy: row.claimed_by }))).toEqual([
      { status: 'pending', claimedBy: null },
      { status: 'pending', claimedBy: null },
    ]);
  });
});

describe('事务性', () => {
  it('其中一个租户不存在时抛 NotFoundError', () => {
    expect(() =>
      createTasks(db, ADMIN, buildInput({ tenantIds: [TENANT_A, GHOST_TENANT, TENANT_B] })),
    ).toThrow(NotFoundError);
  });

  it('任一租户不存在时任务表的行数与调用前完全相同', () => {
    const before = countTasks();
    swallow(() => createTasks(db, ADMIN, buildInput({ tenantIds: [TENANT_A, GHOST_TENANT] })));
    expect(countTasks()).toBe(before);
  });

  it('视频不存在时抛 NotFoundError', () => {
    expect(() => createTasks(db, ADMIN, buildInput({ videoId: GHOST_VIDEO }))).toThrow(
      NotFoundError,
    );
  });

  it('视频不存在时不写入任何任务', () => {
    const before = countTasks();
    swallow(() => createTasks(db, ADMIN, buildInput({ videoId: GHOST_VIDEO })));
    expect(countTasks()).toBe(before);
  });
});

describe('输入校验', () => {
  it('标题为空时抛 ValidationError', () => {
    expect(() => createTasks(db, ADMIN, buildInput({ title: '   ' }))).toThrow(ValidationError);
  });

  it('标题超过 100 字时抛 ValidationError', () => {
    expect(() =>
      createTasks(db, ADMIN, buildInput({ title: '标'.repeat(MAX_TITLE_LENGTH + 1) })),
    ).toThrow(ValidationError);
  });

  it('tenantIds 为空数组时抛 ValidationError', () => {
    expect(() => createTasks(db, ADMIN, buildInput({ tenantIds: [] }))).toThrow(ValidationError);
  });

  it('tenantIds 含重复项时只建一条', () => {
    createTasks(db, ADMIN, buildInput({ tenantIds: [TENANT_A, TENANT_A] }));
    expect(countTasks()).toBe(1);
  });
});

describe('审计', () => {
  it('每条任务各有一条 task.create 审计，且指向对应的任务 id', () => {
    const { ids } = createTasks(db, ADMIN, buildInput());
    expect(auditTargetIds().sort()).toEqual([...ids].sort());
  });

  it('审计按任务所属租户分别记账', () => {
    createTasks(db, ADMIN, buildInput());
    const rows = db
      .prepare(`SELECT tenant_id FROM audit_logs WHERE action = 'task.create' ORDER BY tenant_id`)
      .all() as { tenant_id: string }[];
    expect(rows.map((row) => row.tenant_id)).toEqual([TENANT_A, TENANT_B]);
  });
});

describe('POST /api/tasks 权限', () => {
  it('标注员调用时返回 403', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ANNOTATOR);
    const res = await POST(postRequest(buildInput()));
    expect(res.status).toBe(403);
  });

  it('标注员调用时响应体标明无权限，而不是未登录', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ANNOTATOR);
    const res = await POST(postRequest(buildInput()));
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });
});
