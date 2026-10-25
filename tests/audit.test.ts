/**
 * H1 验收：登录成功与三种失败的审计埋点、失败原因不外泄、旁路模式、action 常量表。
 *
 * 审计写入失败用「把 audit_logs 表删掉」制造，不 mock 写入函数 ——
 * mock 只能证明「那段代码被调用过」，删表才证明「真写不进去时登录仍然成功」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB } from '@/lib/db';
import { AUDIT_ACTIONS } from '@/lib/audit-actions';
import { UnauthorizedError } from '@/lib/errors';
import {
  authenticate,
  hashPassword,
  loginWithFreshSession,
} from '@/lib/services/auth-service';

const TENANT_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
const ADMIN_ID = '3333333333333333';
/** 凭据正常但租户丢失的账号：schema 的 CHECK 会拦住，本场景用 pragma 造出来 */
const GHOST_ID = '4444444444444444';

const ALICE_PASSWORD = 'demo123';

type AuditDbRow = {
  actor_id: string | null;
  action: string;
  detail: string | null;
};

let db: DB;
/** 三个账号共用一个哈希，省掉三次 scrypt（每次约 300ms，纯为省测试时间） */
let passwordHash: string;

function seed(): DB {
  const fresh = createDb(':memory:');
  fresh
    .prepare('INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)')
    .run(TENANT_ID, '星尘机器人', 'Asia/Shanghai', 0);

  passwordHash = hashPassword(ALICE_PASSWORD);
  const insertUser = fresh.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run(ALICE_ID, TENANT_ID, 'alice', '林小雨', passwordHash, 'annotator', 0);
  insertUser.run(ADMIN_ID, null, 'admin', '平台管理员', passwordHash, 'admin', 0);

  // CHECK 关掉才能插入「标注员却没有租户」的行：真实库里它可能来自手工改库或旧库迁移
  fresh.pragma('ignore_check_constraints = ON');
  fresh
    .prepare(
      `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
       VALUES (?, NULL, ?, ?, ?, 'annotator', 0)`,
    )
    .run(GHOST_ID, 'ghost', '幽灵账号', passwordHash);
  fresh.pragma('ignore_check_constraints = OFF');
  return fresh;
}

function auditsOf(action: string): AuditDbRow[] {
  return db
    .prepare('SELECT actor_id, action, detail FROM audit_logs WHERE action = ?')
    .all(action) as AuditDbRow[];
}

/** 取该 action 第一条记录的 detail；没有记录时返回 null，断言里直接看得出「一条都没有」。 */
function detailOf(action: string): Record<string, unknown> | null {
  const detail = auditsOf(action)[0]?.detail;
  return detail === null || detail === undefined
    ? null
    : (JSON.parse(detail) as Record<string, unknown>);
}

/** 吞掉预期内的抛出，让「失败之后留下了什么」的用例只断言留下的东西。 */
async function attempt(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  db = seed();
});

afterEach(() => {
  db.close();
});

describe('登录成功的审计', () => {
  it('写入一条 auth.login', async () => {
    await loginWithFreshSession(db, 'alice', ALICE_PASSWORD);
    expect(auditsOf(AUDIT_ACTIONS.authLogin)).toHaveLength(1);
  });

  it('actorId 是刚登录的用户', async () => {
    await loginWithFreshSession(db, 'alice', ALICE_PASSWORD);
    expect(auditsOf(AUDIT_ACTIONS.authLogin)[0]?.actor_id).toBe(ALICE_ID);
  });

  it('审计的任何一列都不含本次签发的会话凭据', async () => {
    // sessions.id 就是这个 schema 里的 cookie 值。写进审计等于把一份有效凭据
    // 存进一张会被导出、会被贴进工单的表，而审计页的详情正是原样渲染 detail 的。
    // 这条反向断言比注释可靠：谁再往 detail 里塞一次，它立刻红。
    const { sessionId } = await loginWithFreshSession(db, 'alice', ALICE_PASSWORD);
    const rows = db
      .prepare('SELECT * FROM audit_logs')
      .all() as Record<string, unknown>[];

    expect(rows.some((row) => JSON.stringify(row).includes(sessionId))).toBe(false);
  });
});

describe('登录失败的审计', () => {
  it('密码错写入一条 auth.login_failed', async () => {
    await attempt(() => authenticate(db, 'alice', 'wrong-password'));
    expect(auditsOf(AUDIT_ACTIONS.authLoginFailed)).toHaveLength(1);
  });

  it('密码错时 actorId 是该用户', async () => {
    await attempt(() => authenticate(db, 'alice', 'wrong-password'));
    expect(auditsOf(AUDIT_ACTIONS.authLoginFailed)[0]?.actor_id).toBe(ALICE_ID);
  });

  it('密码错的 reason 是 bad_password', async () => {
    await attempt(() => authenticate(db, 'alice', 'wrong-password'));
    expect(detailOf(AUDIT_ACTIONS.authLoginFailed)?.reason).toBe('bad_password');
  });

  it('用户不存在时 actorId 为 NULL', async () => {
    await attempt(() => authenticate(db, 'nobody', ALICE_PASSWORD));
    expect(auditsOf(AUDIT_ACTIONS.authLoginFailed)[0]?.actor_id).toBeNull();
  });

  it('用户不存在时 detail.username 有值，是试的那个名字', async () => {
    await attempt(() => authenticate(db, 'nobody', ALICE_PASSWORD));
    expect(detailOf(AUDIT_ACTIONS.authLoginFailed)?.username).toBe('nobody');
  });

  it('账号不可用时 reason 是 inactive', async () => {
    await attempt(() => authenticate(db, 'ghost', ALICE_PASSWORD));
    expect(detailOf(AUDIT_ACTIONS.authLoginFailed)?.reason).toBe('inactive');
  });

  it('失败记录的 detail 只有 username 与 reason，不含密码或哈希', async () => {
    await attempt(() => authenticate(db, 'alice', 'wrong-password'));
    expect(detailOf(AUDIT_ACTIONS.authLoginFailed)).toEqual({
      username: 'alice',
      reason: 'bad_password',
    });
  });
});

describe('不泄漏失败原因', () => {
  const reasons = ['bad_password', 'no_such_user', 'inactive'] as const;

  it('三种原因抛的是同一种错误、同一句文案', async () => {
    const wrongPassword = await attempt(() => authenticate(db, 'alice', 'wrong-password'));
    const noSuchUser = await attempt(() => authenticate(db, 'nobody', ALICE_PASSWORD));
    const inactive = await attempt(() => authenticate(db, 'ghost', ALICE_PASSWORD));

    const shape = (err: unknown) =>
      err instanceof UnauthorizedError ? [err.name, err.status, err.message] : null;

    // 三条一起比：任一文案不同即失败，逐条比对时容易漏掉「只有第三条不一样」
    expect([shape(wrongPassword), shape(noSuchUser), shape(inactive)]).toEqual([
      ['UnauthorizedError', 401, '用户名或密码不正确'],
      ['UnauthorizedError', 401, '用户名或密码不正确'],
      ['UnauthorizedError', 401, '用户名或密码不正确'],
    ]);
  });

  it('三种原因在审计里是分开的', async () => {
    await attempt(() => authenticate(db, 'alice', 'wrong-password'));
    await attempt(() => authenticate(db, 'nobody', ALICE_PASSWORD));
    await attempt(() => authenticate(db, 'ghost', ALICE_PASSWORD));

    const recorded = auditsOf(AUDIT_ACTIONS.authLoginFailed).map(
      (row) => (JSON.parse(row.detail ?? '{}') as { reason?: string }).reason,
    );
    expect(new Set(recorded)).toEqual(new Set(reasons));
  });
});

describe('抛错与审计的先后', () => {
  it('抛错之前审计已经落库（异常没把它一起带走）', async () => {
    await attempt(() => authenticate(db, 'nobody', ALICE_PASSWORD));
    expect(auditsOf(AUDIT_ACTIONS.authLoginFailed)).toHaveLength(1);
  });
});

describe('旁路模式', () => {
  /** 真写不进去：表都没了，任何插入都会抛 SQLITE_ERROR */
  function dropAuditTable(): void {
    db.exec('DROP TABLE audit_logs');
  }

  it('审计表不可写时登录仍然成功', async () => {
    dropAuditTable();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loginWithFreshSession(db, 'alice', ALICE_PASSWORD)).resolves.toBeDefined();
    log.mockRestore();
  });

  it('审计表不可写时的失败登录抛的仍是凭据错误，而不是审计错误', async () => {
    dropAuditTable();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await attempt(() => authenticate(db, 'nobody', ALICE_PASSWORD));
    log.mockRestore();
    expect(err instanceof UnauthorizedError).toBe(true);
  });
});

describe('action 常量表', () => {
  it('八个 action 的取值与文档一致（拼错在编译期就会报）', () => {
    expect(Object.values(AUDIT_ACTIONS)).toEqual([
      'task.create',
      'task.claim',
      'task.release',
      'task.submit',
      'task.reject',
      'task.reopen',
      'auth.login',
      'auth.login_failed',
    ]);
  });

  it('登记在常量表里的 action 都是小写点分形式，库里读回来不会歧义', () => {
    expect(Object.values(AUDIT_ACTIONS).every((action) => /^[a-z]+\.[a-z_]+$/.test(action))).toBe(
      true,
    );
  });
});