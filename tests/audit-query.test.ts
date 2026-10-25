/**
 * H2 验收：审计查询的筛选、分页稳定性、detail 解析容错、管理员范围与只读性。
 *
 * 时间戳直接写死进库（不用 nowMs），否则「同一毫秒」与「闭区间边界」两类用例无法稳定复现。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DB } from '@/lib/db';
import * as auditRepo from '@/lib/db/repos/audit-repo';
import { countAudit, listAudit, type AuditFilter } from '@/lib/db/repos/audit-repo';
import { ForbiddenError } from '@/lib/errors';
import type { SessionUser } from '@/lib/services/auth-service';
import { listAuditActors, listAuditLogs } from '@/lib/services/audit-query-service';
import { dayEndMs, dayStartMs } from '@/lib/time';

const TENANT_ID = '1111111111111111';
const OTHER_TENANT_ID = '9999999999999999';
const ADMIN_ID = '2222222222222222';
const ALICE_ID = '3333333333333333';

const VIDEO_ID = 'ddddddddddddddd1';
const TASK_ID = 'a000000000000001';
const GONE_TASK_ID = 'a0000000000000ff';

/** 默认窗口够宽，把「筛选」与「分页」的用例与时间区间解耦 */
const WIDE: AuditFilter = { fromMs: 0, toMs: 9_999_999_999_999 };
const FIRST_PAGE = { limit: 50, offset: 0 };

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
  tenantId: TENANT_ID,
  tenantName: '星尘机器人',
  timezone: 'Asia/Shanghai',
};

type SeedAudit = {
  id: string;
  createdAt: number;
  action: string;
  actorId?: string | null;
  actorRole?: string | null;
  tenantId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: string | null;
};

let db: DB;

function seed(): DB {
  const fresh = createDb(':memory:');

  const insertTenant = fresh.prepare(
    'INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)',
  );
  insertTenant.run(TENANT_ID, '星尘机器人', 'Asia/Shanghai', 0);
  insertTenant.run(OTHER_TENANT_ID, '另一家公司', 'Asia/Shanghai', 0);

  const insertUser = fresh.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run(ADMIN_ID, null, 'admin', '平台管理员', 'scrypt$00$00', 'admin', 0);
  insertUser.run(ALICE_ID, TENANT_ID, 'alice', '林小雨', 'scrypt$00$00', 'annotator', 0);

  // 一条任务只为验证「对象」列能 join 到标题；GONE_TASK_ID 刻意不建行，模拟任务已被删
  fresh
    .prepare(
      `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(VIDEO_ID, 'demo.mp4', 'videos/demo.mp4', 1024, 60_000, ADMIN_ID, 0);
  fresh
    .prepare(
      `INSERT INTO tasks (id, tenant_id, video_id, title, description, created_by, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(TASK_ID, TENANT_ID, VIDEO_ID, '机器人在仓库巡回', ADMIN_ID, 0);

  return fresh;
}

function insertAuditRow(row: SeedAudit): void {
  db.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_role, tenant_id, action, target_type, target_id,
                             detail, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    row.id,
    row.actorId ?? null,
    row.actorRole ?? null,
    row.tenantId ?? null,
    row.action,
    row.targetType ?? null,
    row.targetId ?? null,
    row.detail ?? null,
    row.createdAt,
  );
}

function createdAtOf(filter: AuditFilter, page = FIRST_PAGE): number[] {
  return listAudit(db, filter, page).map((row) => row.createdAt);
}

beforeEach(() => {
  db = seed();
});

afterEach(() => {
  db.close();
});

describe('listAudit 的排序与筛选', () => {
  it('按时间倒序返回', () => {
    insertAuditRow({ id: '00000000000000a1', createdAt: 100, action: 'task.submit' });
    insertAuditRow({ id: '00000000000000a2', createdAt: 300, action: 'task.submit' });
    insertAuditRow({ id: '00000000000000a3', createdAt: 200, action: 'task.submit' });

    expect(createdAtOf(WIDE)).toEqual([300, 200, 100]);
  });

  it('action 筛选只返回该动作', () => {
    insertAuditRow({ id: '00000000000000b1', createdAt: 100, action: 'task.submit' });
    insertAuditRow({ id: '00000000000000b2', createdAt: 200, action: 'task.reject' });

    expect(createdAtOf({ ...WIDE, action: 'task.reject' })).toEqual([200]);
  });

  it('actorId 筛选只返回该操作人', () => {
    insertAuditRow({ id: '00000000000000c1', createdAt: 100, action: 'task.reject', actorId: ADMIN_ID });
    insertAuditRow({ id: '00000000000000c2', createdAt: 200, action: 'task.submit', actorId: ALICE_ID });

    expect(createdAtOf({ ...WIDE, actorId: ALICE_ID })).toEqual([200]);
  });

  it('时间区间是闭区间，两端那一毫秒都算在区间内', () => {
    insertAuditRow({ id: '00000000000000d1', createdAt: 1000, action: 'task.submit' });
    insertAuditRow({ id: '00000000000000d2', createdAt: 2000, action: 'task.submit' });

    expect(createdAtOf({ fromMs: 1000, toMs: 2000 })).toEqual([2000, 1000]);
  });

  it('分页按 limit / offset 取窗口', () => {
    insertAuditRow({ id: '00000000000000e1', createdAt: 100, action: 'task.submit' });
    insertAuditRow({ id: '00000000000000e2', createdAt: 200, action: 'task.submit' });
    insertAuditRow({ id: '00000000000000e3', createdAt: 300, action: 'task.submit' });

    expect(createdAtOf(WIDE, { limit: 1, offset: 1 })).toEqual([200]);
  });

  it('countAudit 是筛选后的总数，不是整表行数', () => {
    insertAuditRow({ id: '00000000000000f1', createdAt: 100, action: 'task.submit' });
    insertAuditRow({ id: '00000000000000f2', createdAt: 200, action: 'task.submit' });
    insertAuditRow({ id: '00000000000000f3', createdAt: 300, action: 'task.reject' });

    expect(countAudit(db, { ...WIDE, action: 'task.submit' })).toBe(2);
  });

  it('同一毫秒的两条记录翻页不重复（id 作二级排序键）', () => {
    // 同一毫秒、不同 id：只按 created_at 排序时两者的先后由 SQLite 自行决定，
    // 两次查询的顺序可能不同，翻页就会把同一条记录显示两次、另一条永远看不到。
    // 断言的既是「不重复」也是「次序稳定」—— 只断言去重的话，缺 id 时仍可能碰巧通过。
    // 故意让 id 大的先插入：缺 id 作次序键时，SQLite 会按插入顺序的逆序返回，与本用例的期望相反
    insertAuditRow({ id: '00000000000000bb', createdAt: 500, action: 'task.submit' });
    insertAuditRow({ id: '00000000000000aa', createdAt: 500, action: 'task.submit' });

    const firstPage = listAudit(db, WIDE, { limit: 1, offset: 0 });
    const secondPage = listAudit(db, WIDE, { limit: 1, offset: 1 });

    expect([...firstPage, ...secondPage].map((row) => row.id)).toEqual([
      '00000000000000bb',
      '00000000000000aa',
    ]);
  });
});

describe('listAudit 的展示字段', () => {
  it('登录失败的记录能解出 detail.username', () => {
    insertAuditRow({
      id: '0000000000000101',
      createdAt: 100,
      action: 'auth.login_failed',
      detail: JSON.stringify({ username: 'nobody', reason: 'no_such_user' }),
    });

    expect(listAudit(db, WIDE, FIRST_PAGE)[0]?.attemptedUsername).toBe('nobody');
  });

  it('detail 是坏 JSON 时不抛错', () => {
    insertAuditRow({
      id: '0000000000000102',
      createdAt: 100,
      action: 'task.submit',
      detail: '{不是合法 JSON',
    });

    expect(() => listAudit(db, WIDE, FIRST_PAGE)).not.toThrow();
  });

  it('detail 是坏 JSON 时 attemptedUsername 为 null', () => {
    insertAuditRow({
      id: '0000000000000103',
      createdAt: 100,
      action: 'auth.login_failed',
      detail: '{"username": ',
    });

    expect(listAudit(db, WIDE, FIRST_PAGE)[0]?.attemptedUsername).toBeNull();
  });

  it('detail 为 NULL 时 attemptedUsername 为 null', () => {
    insertAuditRow({ id: '0000000000000104', createdAt: 100, action: 'auth.logout' });

    expect(listAudit(db, WIDE, FIRST_PAGE)[0]?.attemptedUsername).toBeNull();
  });

  it('join 得到操作人姓名', () => {
    insertAuditRow({
      id: '0000000000000105',
      createdAt: 100,
      action: 'task.submit',
      actorId: ALICE_ID,
    });

    expect(listAudit(db, WIDE, FIRST_PAGE)[0]?.actorName).toBe('林小雨');
  });

  it('join 得到任务标题', () => {
    insertAuditRow({
      id: '0000000000000106',
      createdAt: 100,
      action: 'task.submit',
      targetType: 'task',
      targetId: TASK_ID,
    });

    expect(listAudit(db, WIDE, FIRST_PAGE)[0]?.targetTitle).toBe('机器人在仓库巡回');
  });

  it('任务已不存在时 targetTitle 为 null，行照样列出来', () => {
    insertAuditRow({
      id: '0000000000000107',
      createdAt: 100,
      action: 'task.submit',
      targetType: 'task',
      targetId: GONE_TASK_ID,
    });

    expect(listAudit(db, WIDE, FIRST_PAGE)[0]?.targetTitle).toBeNull();
  });
});

describe('listAuditLogs 的访问范围', () => {
  it('管理员能看到 tenant_id 为 NULL 的全局操作行', () => {
    // 审计表里管理员自己的操作 tenant_id 就是 NULL：查询若带租户谓词，这些行会整片消失
    insertAuditRow({ id: '0000000000000201', createdAt: 100, action: 'task.create', actorId: ADMIN_ID });
    insertAuditRow({
      id: '0000000000000202',
      createdAt: 200,
      action: 'task.submit',
      actorId: ALICE_ID,
      tenantId: TENANT_ID,
    });

    expect(listAuditLogs(db, ADMIN, WIDE, FIRST_PAGE).rows).toHaveLength(2);
  });

  it('标注员调用被拒绝（403）', () => {
    const err = (() => {
      try {
        listAuditLogs(db, ALICE, WIDE, FIRST_PAGE);
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(err instanceof ForbiddenError ? err.status : null).toBe(403);
  });

  it('标注员也拿不到筛选下拉的用户列表', () => {
    expect(() => listAuditActors(db, ALICE)).toThrow(ForbiddenError);
  });

  it('管理员拿到的用户列表含两个账号', () => {
    expect(listAuditActors(db, ADMIN)).toHaveLength(2);
  });
});

describe('按自然日给区间', () => {
  // 页面的筛选是「某几天」，库里存的是 UTC 毫秒：边界必须落在使用者时区上，
  // 直接用 UTC 零点会让东八区的「今天」缺掉最早 8 小时。
  it('时区里的零点换算成正确的 UTC 毫秒', () => {
    expect(dayStartMs('2026-10-25', 'Asia/Shanghai')).toBe(Date.parse('2026-10-24T16:00:00Z'));
  });

  it('当日最后一毫秒是闭区间的右端', () => {
    expect(dayEndMs('2026-10-25', 'Asia/Shanghai')).toBe(Date.parse('2026-10-25T15:59:59.999Z'));
  });
});

describe('只读', () => {
  it('审计 repo 只导出插入与查询，没有删除或编辑入口', () => {
    expect(Object.keys(auditRepo).sort()).toEqual(['countAudit', 'insertAudit', 'listAudit']);
  });
});
