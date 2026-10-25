/**
 * 登录 / 登出 API、会话签发与审计的用例。
 *
 * 数据库用真实 SQLite 内存库跑，只替换「Node 里造不出来」的两样：
 * 连接入口（@/lib/server/db）与请求上下文（next/headers）。
 * 审计模块包了一层 spy，仅为制造「写入抛错」这一条验收场景，其余调用仍是真实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, POST } from '@/app/api/auth/login/route';
import { createDb, type DB } from '@/lib/db';
import { insertSession } from '@/lib/db/repos/session-repo';
import { UnauthorizedError } from '@/lib/errors';
import { hashPassword, loginWithFreshSession, createSession, resolveSession, SESSION_TTL_MS } from '@/lib/services/auth-service';
import { writeAudit } from '@/lib/services/audit-service';

/** 路由与测试共享的可变状态；vi.hoisted 让它先于 import 存在 */
const HOLDER = vi.hoisted(() => ({
  db: null as DB | null,
  sid: null as string | null,
}));

vi.mock('@/lib/server/db', () => ({ getDb: () => HOLDER.db }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (HOLDER.sid ? { name, value: HOLDER.sid } : undefined),
  }),
}));

vi.mock('@/lib/services/audit-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/audit-service')>();
  return { ...actual, writeAudit: vi.fn(actual.writeAudit) };
});

const TENANT_ID = '1111111111111111';
const ALICE_ID = '2222222222222222';
const ADMIN_ID = '3333333333333333';
const ALICE_PASSWORD = 'demo123';
const STALE_SID = 'a'.repeat(48);

type OkBody = { ok: true; role: 'admin' | 'annotator' };
type FailBody = { ok: false; error: { code: string; message: string } };
type AuditRow = {
  actor_id: string | null;
  actor_role: string | null;
  tenant_id: string | null;
  action: string;
  detail: string | null;
};

let db: DB;

function seed(): DB {
  const fresh = createDb(':memory:');
  fresh
    .prepare('INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)')
    .run(TENANT_ID, '星尘机器人', 'Asia/Shanghai', 0);
  const insertUser = fresh.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run(ALICE_ID, TENANT_ID, 'alice', '林小雨', hashPassword(ALICE_PASSWORD), 'annotator', 0);
  insertUser.run(ADMIN_ID, null, 'admin', '平台管理员', hashPassword('admin123'), 'admin', 0);
  return fresh;
}

/** 造一个「请求带来的旧会话」，并把 mock 的 cookie 指向它。 */
function staleSession(id = STALE_SID): string {
  const now = Date.now();
  insertSession(db, id, ALICE_ID, now + SESSION_TTL_MS, now);
  HOLDER.sid = id;
  return id;
}

function sessionExists(id: string): boolean {
  return db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id) !== undefined;
}

function audits(action: string): AuditRow[] {
  return db
    .prepare(
      'SELECT actor_id, actor_role, tenant_id, action, detail FROM audit_logs WHERE action = ?',
    )
    .all(action) as AuditRow[];
}

/** 吞掉预期内的抛出，让「失败之后状态如何」的用例只断言状态本身。 */
function attempt(fn: () => unknown): void {
  try {
    fn();
  } catch {
    // 预期内：是否该抛由另一条用例负责
  }
}

function login(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://localhost/api/auth/login', {
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

function logout(): Promise<Response> {
  return DELETE(new Request('http://localhost/api/auth/logout', { method: 'DELETE' }));
}

function setCookieOf(res: Response): string {
  return res.headers.get('set-cookie') ?? '';
}

function sidIn(setCookie: string): string {
  return /vsap_sid=([^;]+)/.exec(setCookie)?.[1] ?? '';
}

beforeEach(() => {
  db = seed();
  HOLDER.db = db;
  HOLDER.sid = null;
  vi.mocked(writeAudit).mockClear();
});

afterEach(() => {
  db.close();
  HOLDER.db = null;
});

describe('loginWithFreshSession', () => {
  it('正确凭据签发的会话可解析出身份', () => {
    const { sessionId } = loginWithFreshSession(db, 'alice', ALICE_PASSWORD);
    expect(resolveSession(db, sessionId)?.username).toBe('alice');
  });

  it('登录成功后请求带来的旧 sid 在库中已不存在', () => {
    loginWithFreshSession(db, 'alice', ALICE_PASSWORD, staleSession());
    expect(sessionExists(STALE_SID)).toBe(false);
  });

  it('密码错误时旧 sid 仍然有效', () => {
    staleSession();
    attempt(() => loginWithFreshSession(db, 'alice', 'wrong-password', STALE_SID));
    expect(sessionExists(STALE_SID)).toBe(true);
  });

  it('密码错误抛 UnauthorizedError', () => {
    expect(() => loginWithFreshSession(db, 'alice', 'wrong-password')).toThrow(UnauthorizedError);
  });

  it('新会话 id 不复用请求带来的旧 sid', () => {
    const { sessionId } = loginWithFreshSession(db, 'alice', ALICE_PASSWORD, staleSession());
    expect(sessionId).not.toBe(STALE_SID);
  });

  it('未传旧 sid 时同样签发会话（管理员无租户）', () => {
    const { sessionId } = loginWithFreshSession(db, 'admin', 'admin123');
    expect(resolveSession(db, sessionId)?.tenantId).toBeNull();
  });

  it('旧 sid 属于其他用户时不销毁（防踢他人下线）', () => {
    // 若不加归属判断，任何知道他人 sid 的人用自己的账号登录一次就能把对方踢下线，
    // 反复调用即构成 DoS
    const adminSid = createSession(db, ADMIN_ID);

    loginWithFreshSession(db, 'alice', ALICE_PASSWORD, adminSid);

    expect(sessionExists(adminSid)).toBe(true);
  });
});

describe('writeAudit', () => {
  it('按调用方给的字段落库', () => {
    writeAudit(db, {
      actorId: ALICE_ID,
      actorRole: 'annotator',
      tenantId: TENANT_ID,
      action: 'task.claim',
    });
    expect(audits('task.claim')[0]).toMatchObject({
      actor_id: ALICE_ID,
      actor_role: 'annotator',
      tenant_id: TENANT_ID,
    });
  });

  it('detail 序列化为 JSON 字符串', () => {
    writeAudit(db, {
      actorId: null,
      actorRole: null,
      tenantId: null,
      action: 'auth.login_failed',
      detail: { username: 'alice', reason: 'bad_credentials' },
    });
    expect(audits('auth.login_failed')[0]?.detail).toBe(
      JSON.stringify({ username: 'alice', reason: 'bad_credentials' }),
    );
  });

  it('未给 detail 时存 NULL 而不是字符串 "undefined"', () => {
    writeAudit(db, { actorId: null, actorRole: null, tenantId: null, action: 'auth.logout' });
    expect(audits('auth.logout')[0]?.detail).toBeNull();
  });

  it('审计表不可写时不向调用方抛错', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const closed = createDb(':memory:');
    closed.close();
    expect(() =>
      writeAudit(closed, { actorId: null, actorRole: null, tenantId: null, action: 'auth.login' }),
    ).not.toThrow();
    log.mockRestore();
  });
});

describe('POST /api/auth/login', () => {
  it('正确凭据返回 200', async () => {
    expect((await login({ username: 'alice', password: ALICE_PASSWORD })).status).toBe(200);
  });

  it('正确凭据的响应体为角色信息', async () => {
    const body = (await (await login({ username: 'alice', password: ALICE_PASSWORD })).json()) as OkBody;
    expect(body).toEqual({ ok: true, role: 'annotator' });
  });

  it('响应体不含会话 id 字段', async () => {
    const body = (await (await login({ username: 'alice', password: ALICE_PASSWORD })).json()) as OkBody;
    expect(Object.keys(body).sort()).toEqual(['ok', 'role']);
  });

  it('Set-Cookie 带 HttpOnly', async () => {
    const res = await login({ username: 'alice', password: ALICE_PASSWORD });
    expect(setCookieOf(res).toLowerCase()).toContain('httponly');
  });

  it('Set-Cookie 带 SameSite=Lax', async () => {
    const res = await login({ username: 'alice', password: ALICE_PASSWORD });
    expect(setCookieOf(res).toLowerCase()).toContain('samesite=lax');
  });

  it('Set-Cookie 带 Path=/', async () => {
    const res = await login({ username: 'alice', password: ALICE_PASSWORD });
    expect(setCookieOf(res).toLowerCase()).toContain('path=/');
  });

  it('cookie 的 maxAge 以秒为单位', async () => {
    const res = await login({ username: 'alice', password: ALICE_PASSWORD });
    // 精确比值而非包含匹配：包含写法下 604800000 也「含」604800，毫秒/秒的错误漏得掉
    expect(/max-age=(\d+)/i.exec(setCookieOf(res))?.[1]).toBe(String(SESSION_TTL_MS / 1000));
  });

  it('下发的 cookie 值在库中可解析出身份', async () => {
    const res = await login({ username: 'alice', password: ALICE_PASSWORD });
    expect(resolveSession(db, sidIn(setCookieOf(res)))?.id).toBe(ALICE_ID);
  });

  it('错误密码返回 401 且 code 为 UNAUTHENTICATED', async () => {
    const res = await login({ username: 'alice', password: 'wrong-password' });
    const body = (await res.json()) as FailBody;
    expect([res.status, body.error.code]).toEqual([401, 'UNAUTHENTICATED']);
  });

  it('错误密码的文案不透露是哪一项错', async () => {
    const body = (await (await login({ username: 'alice', password: 'wrong-password' })).json()) as FailBody;
    expect(body.error.message).toBe('用户名或密码不正确');
  });

  it('失败响应里不出现用户名', async () => {
    const body = (await (await login({ username: 'alice', password: 'wrong-password' })).json()) as FailBody;
    expect(JSON.stringify(body)).not.toContain('alice');
  });

  it('缺密码返回 400 且 code 为 VALIDATION', async () => {
    const res = await login({ username: 'alice' });
    const body = (await res.json()) as FailBody;
    expect([res.status, body.error.code]).toEqual([400, 'VALIDATION']);
  });

  it('缺字段的文案提示补全', async () => {
    const body = (await (await login({ username: 'alice', password: '' })).json()) as FailBody;
    expect(body.error.message).toBe('请填写用户名和密码');
  });

  it('登录成功后请求带来的旧 sid 在库中已不存在', async () => {
    staleSession();
    await login({ username: 'alice', password: ALICE_PASSWORD });
    expect(sessionExists(STALE_SID)).toBe(false);
  });

  it('登录失败时请求带来的旧 sid 仍然有效', async () => {
    staleSession();
    await login({ username: 'alice', password: 'wrong-password' });
    expect(resolveSession(db, STALE_SID)?.id).toBe(ALICE_ID);
  });

  it('登录成功写入一条 auth.login 审计', async () => {
    await login({ username: 'alice', password: ALICE_PASSWORD });
    expect(audits('auth.login')).toHaveLength(1);
  });

  it('密码错写入的 auth.login_failed 关联到被尝试的账号', async () => {
    // H1 收尾时改了这条语义：密码错时账号是确定的，把 actor_id 记下来，
    // 追溯不必只靠 detail.username。actor_id 为 NULL 只发生在用户名根本不存在时。
    await login({ username: 'alice', password: 'wrong-password' });
    expect(audits('auth.login_failed')[0]?.actor_id).toBe(ALICE_ID);
  });

  it('登录失败的审计 detail 里留有用户名，供追溯', async () => {
    await login({ username: 'alice', password: 'wrong-password' });
    const detail = audits('auth.login_failed')[0]?.detail ?? '{}';
    expect((JSON.parse(detail) as { username?: string }).username).toBe('alice');
  });

  it('审计写入抛错时登录仍然成功', async () => {
    vi.mocked(writeAudit).mockImplementationOnce(() => {
      throw new Error('audit disk full');
    });
    expect((await login({ username: 'alice', password: ALICE_PASSWORD })).status).toBe(200);
  });
});

describe('DELETE /api/auth/logout', () => {
  it('登出后当前 sid 失效', async () => {
    const sid = staleSession();
    await logout();
    expect(sessionExists(sid)).toBe(false);
  });

  it('未登录时登出返回 200', async () => {
    expect((await logout()).status).toBe(200);
  });

  it('未登录时登出的响应体仍是成功', async () => {
    const body = (await (await logout()).json()) as { ok: true };
    expect(body).toEqual({ ok: true });
  });

  it('重复登出仍返回 200', async () => {
    staleSession();
    await logout();
    expect((await logout()).status).toBe(200);
  });

  it('登出响应清除会话 cookie', async () => {
    staleSession();
    expect(setCookieOf(await logout())).toContain('vsap_sid=;');
  });

  it('登出写入一条 auth.logout 审计', async () => {
    staleSession();
    await logout();
    expect(audits('auth.logout')[0]?.actor_id).toBe(ALICE_ID);
  });
});
