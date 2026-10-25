/**
 * O1 验收：改密。
 *
 * 服务层用例跑真实内存库（不 mock repo），路由用例只替换「Node 里造不出来」的连接入口与 cookie。
 * 重点在三条不可见的约束：旧口令错必须与登录失败同文案、成功后只留当前会话、审计不含口令材料。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/auth/password/route';
import { createDb, type DB } from '@/lib/db';
import { AppError } from '@/lib/errors';
import {
  authenticate,
  changePassword,
  createSession,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  resolveSession,
  type SessionUser,
} from '@/lib/services/auth-service';

const HOLDER = vi.hoisted(() => ({ db: null as DB | null, sid: null as string | null }));

/** 只替换 getDb：createDb / writeTx 等仍取真实现，否则测的就不是真库了 */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getDb: () => HOLDER.db };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (HOLDER.sid ? { name, value: HOLDER.sid } : undefined),
  }),
}));

const TENANT_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
const ADMIN_ID = '3333333333333333';
const TENANT_NAME = '星尘机器人';
const OLD_PASSWORD = 'old-password-1';
const NEW_PASSWORD = 'brand-new-pass-2';

const ALICE: SessionUser = {
  id: ALICE_ID,
  username: 'alice',
  displayName: '林小雨',
  role: 'annotator',
  tenantId: TENANT_ID,
  tenantName: TENANT_NAME,
  timezone: 'Asia/Shanghai',
};

type AuditRow = { action: string; detail: string | null; actor_id: string | null };

let db: DB;
let currentSid: string;
let otherSid: string;

function seed(): DB {
  const fresh = createDb(':memory:');
  fresh
    .prepare('INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)')
    .run(TENANT_ID, TENANT_NAME, 'Asia/Shanghai', 0);
  const insertUser = fresh.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run(ALICE_ID, TENANT_ID, 'alice', '林小雨', hashPassword(OLD_PASSWORD), 'annotator', 0);
  insertUser.run(ADMIN_ID, null, 'admin', '平台管理员', hashPassword(OLD_PASSWORD), 'admin', 0);
  return fresh;
}

function sessionExists(id: string): boolean {
  return db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id) !== undefined;
}

function audits(action: string): AuditRow[] {
  return db
    .prepare('SELECT action, detail, actor_id FROM audit_logs WHERE action = ?')
    .all(action) as AuditRow[];
}

async function canLogin(password: string): Promise<boolean> {
  try {
    await authenticate(db, 'alice', password);
    return true;
  } catch {
    return false;
  }
}

/** 把抛出物压成可断言的字面量；未抛出返回 null。 */
async function failure(fn: () => Promise<unknown>): Promise<{ name: string; message: string; status: number } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof AppError) return { name: err.name, message: err.message, status: err.status };
    if (err instanceof Error) return { name: err.name, message: err.message, status: 0 };
    return { name: 'non-error', message: String(err), status: 0 };
  }
}

function change(input: { currentPassword: string; newPassword: string }, keepCurrent = true): Promise<void> {
  return changePassword(db, ALICE, input, { ip: '10.0.0.1', userAgent: 'vitest' }, keepCurrent ? currentSid : undefined);
}

/** 请求体形状与登录接口一致；x-forwarded-for 只作审计参考 */
function postPassword(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://localhost/api/auth/password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'vitest',
        'x-forwarded-for': '10.0.0.1, 10.0.0.2',
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  db = seed();
  HOLDER.db = db;
  currentSid = createSession(db, ALICE_ID);
  otherSid = createSession(db, ALICE_ID);
  HOLDER.sid = currentSid;
});

afterEach(() => {
  db.close();
  HOLDER.db = null;
  HOLDER.sid = null;
});

describe('changePassword 的成功路径', () => {
  it('改密后旧口令登录失败', async () => {
    await change({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(await canLogin(OLD_PASSWORD)).toBe(false);
  });

  it('改密后新口令登录成功', async () => {
    await change({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(await canLogin(NEW_PASSWORD)).toBe(true);
  });

  it('当前会话仍可解析出身份（不把自己踢下线）', async () => {
    await change({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(resolveSession(db, currentSid)?.id).toBe(ALICE_ID);
  });

  it('该用户的其他会话被销毁', async () => {
    await change({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(sessionExists(otherSid)).toBe(false);
  });

  it('其他用户的会话不受影响', async () => {
    const adminSid = createSession(db, ADMIN_ID);
    await change({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(sessionExists(adminSid)).toBe(true);
  });

  it('不传当前会话时销毁该用户全部会话（安全侧默认）', async () => {
    // 契约的四个参数里没有会话标识；缺省时没有可保留的对象，宁可全踢也不留旧口令会话
    await change({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, false);
    expect(sessionExists(currentSid)).toBe(false);
  });

  it('写一条 auth.password_changed', async () => {
    await change({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(audits('auth.password_changed')).toHaveLength(1);
  });

  it('审计关联到改密的用户', async () => {
    await change({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(audits('auth.password_changed')[0]?.actor_id).toBe(ALICE_ID);
  });

  it('审计 detail 只有 username', async () => {
    await change({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(JSON.parse(audits('auth.password_changed')[0]?.detail ?? 'null')).toEqual({
      username: 'alice',
    });
  });
});

describe('changePassword 的拒绝路径', () => {
  it('旧密码错抛 UnauthorizedError', async () => {
    const err = await failure(() => change({ currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }));
    expect(err?.name).toBe('UnauthorizedError');
  });

  it('旧密码错的状态码是 401', async () => {
    const err = await failure(() => change({ currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }));
    expect(err?.status).toBe(401);
  });

  it('旧密码错的文案与登录失败完全相同', async () => {
    const loginErr = await failure(() => authenticate(db, 'alice', 'wrong-password'));
    const changeErr = await failure(() => change({ currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }));
    expect(changeErr?.message).toBe(loginErr?.message);
  });

  it('旧密码错时口令不变', async () => {
    await failure(() => change({ currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }));
    expect(await canLogin(OLD_PASSWORD)).toBe(true);
  });

  it('旧密码错时其他会话不被销毁', async () => {
    await failure(() => change({ currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }));
    expect(sessionExists(otherSid)).toBe(true);
  });

  it(`新密码只有 ${MIN_PASSWORD_LENGTH - 1} 位时抛 ValidationError`, async () => {
    const err = await failure(() =>
      change({ currentPassword: OLD_PASSWORD, newPassword: 'a'.repeat(MIN_PASSWORD_LENGTH - 1) }),
    );
    expect([err?.name, err?.status]).toEqual(['ValidationError', 400]);
  });

  it('新密码过短时口令不变', async () => {
    await failure(() => change({ currentPassword: OLD_PASSWORD, newPassword: '1234567' }));
    expect(await canLogin(OLD_PASSWORD)).toBe(true);
  });

  it('新密码与旧密码相同时抛 ValidationError', async () => {
    const err = await failure(() => change({ currentPassword: OLD_PASSWORD, newPassword: OLD_PASSWORD }));
    expect([err?.name, err?.status]).toEqual(['ValidationError', 400]);
  });

  it('新密码与旧密码相同时不写审计', async () => {
    await failure(() => change({ currentPassword: OLD_PASSWORD, newPassword: OLD_PASSWORD }));
    expect(audits('auth.password_changed')).toHaveLength(0);
  });
});

describe('审计与口令材料', () => {
  it('审计表里不出现新旧口令与任何哈希', async () => {
    await change({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    const rows = db.prepare('SELECT * FROM audit_logs').all() as Record<string, unknown>[];
    const text = JSON.stringify(rows);
    expect([OLD_PASSWORD, NEW_PASSWORD, 'scrypt$'].filter((s) => text.includes(s))).toEqual([]);
  });

  it('审计写不进去时整段回滚：口令未改、会话未删', async () => {
    db.exec('DROP TABLE audit_logs');
    await failure(() => change({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }));
    expect([await canLogin(OLD_PASSWORD), sessionExists(otherSid)]).toEqual([true, true]);
  });
});

describe('POST /api/auth/password', () => {
  it('未登录返回 401', async () => {
    HOLDER.sid = null;
    expect((await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(401);
  });

  it('成功返回 200', async () => {
    expect((await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it('成功的响应体只有 ok', async () => {
    const body = (await (await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })).json()) as unknown;
    expect(body).toEqual({ ok: true });
  });

  it('旧密码错返回 401 与登录失败同一句文案', async () => {
    const res = await postPassword({ currentPassword: 'wrong-password', newPassword: NEW_PASSWORD });
    const body = (await res.json()) as { error: { message: string } };
    expect([res.status, body.error.message]).toEqual([401, '用户名或密码不正确']);
  });

  it('新密码短于 8 位返回 400', async () => {
    expect(
      (await postPassword({ currentPassword: OLD_PASSWORD, newPassword: '1234567' })).status,
    ).toBe(400);
  });

  it('缺字段返回 400', async () => {
    expect((await postPassword({ currentPassword: OLD_PASSWORD })).status).toBe(400);
  });

  it('成功后当前会话仍可解析（cookie 里的 sid 未被删）', async () => {
    await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(resolveSession(db, currentSid)?.id).toBe(ALICE_ID);
  });

  it('成功后其他会话失效', async () => {
    await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(sessionExists(otherSid)).toBe(false);
  });
});

describe('会话处置', () => {
  it('改密不签发新会话，当前会话 id 原样保留', async () => {
    await change({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(sessionExists(currentSid)).toBe(true);
  });
});
