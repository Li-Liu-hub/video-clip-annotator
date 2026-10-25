/**
 * 密码与会话的用例：哈希随机性、凭据不可区分、身份回表、会话生命周期与过期清理。
 *
 * 每个用例独立 createDb(':memory:')，不 mock 数据库；
 * 租户与用户由本文件直接插入（认证是本步唯一不写 users 的业务路径，repo 层没有建号入口）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DB } from '@/lib/db';
import { insertSession } from '@/lib/db/repos/session-repo';
import { AppError } from '@/lib/errors';
import {
  authenticate,
  createSession,
  destroySession,
  hashPassword,
  purgeExpiredSessions,
  resolveSession,
  verifyPassword,
  SESSION_TTL_MS,
} from '@/lib/services/auth-service';

const TENANT_ID = '1111111111111111';
const ANNOTATOR_ID = '2222222222222222';
const ADMIN_ID = '3333333333333333';
const TENANT_NAME = '林小雨的工作空间';
/** 故意不用默认时区：时区若被硬编码成 Asia/Shanghai，标注员用例会失败 */
const TENANT_TIMEZONE = 'America/New_York';
const ANNOTATOR_PASSWORD = 'demo123';
const ADMIN_PASSWORD = 'admin123';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

let db: DB;

function seed(): DB {
  const fresh = createDb(':memory:');
  fresh
    .prepare('INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)')
    .run(TENANT_ID, TENANT_NAME, TENANT_TIMEZONE, 0);
  const insertUser = fresh.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run(ANNOTATOR_ID, TENANT_ID, 'alice', '林小雨', hashPassword(ANNOTATOR_PASSWORD), 'annotator', 0);
  insertUser.run(ADMIN_ID, null, 'admin', '平台管理员', hashPassword(ADMIN_PASSWORD), 'admin', 0);
  return fresh;
}

/** 把抛出物压成可断言的字面量；未抛出返回 null，免得每个用例各写一遍 try/catch。 */
async function failure(fn: () => unknown): Promise<{ name: string; message: string; status: number } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof AppError) return { name: err.name, message: err.message, status: err.status };
    if (err instanceof Error) return { name: err.name, message: err.message, status: 0 };
    return { name: 'non-error', message: String(err), status: 0 };
  }
}

function sessionCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  return row.n;
}

beforeEach(() => {
  db = seed();
});

afterEach(() => {
  db.close();
});

describe('hashPassword', () => {
  it('同一密码两次哈希结果不同（salt 随机）', () => {
    expect(hashPassword(ANNOTATOR_PASSWORD)).not.toBe(hashPassword(ANNOTATOR_PASSWORD));
  });

  it('两次哈希的结果都能通过校验', async () => {
    expect([
      await verifyPassword(ANNOTATOR_PASSWORD, hashPassword(ANNOTATOR_PASSWORD)),
      await verifyPassword(ANNOTATOR_PASSWORD, hashPassword(ANNOTATOR_PASSWORD)),
    ]).toEqual([true, true]);
  });

  it('格式是 scrypt$32 位 salt hex$128 位派生 hex', () => {
    expect(hashPassword(ANNOTATOR_PASSWORD).split('$').map((part, i) => (i === 0 ? part : part.length))).toEqual([
      'scrypt',
      32,
      128,
    ]);
  });
});

describe('verifyPassword', () => {
  it('正确密码返回 true', async () => {
    expect(await verifyPassword(ANNOTATOR_PASSWORD, hashPassword(ANNOTATOR_PASSWORD))).toBe(true);
  });

  it('错误密码返回 false', async () => {
    expect(await verifyPassword('wrong-password', hashPassword(ANNOTATOR_PASSWORD))).toBe(false);
  });

  const malformed = [
    '',
    'abc',
    'scrypt$xx',
    'scrypt$xx$yy',
    'scrypt$$',
    `scrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`,
    `scrypt$${'a'.repeat(32)}$${'b'.repeat(126)}`,
    `bcrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`,
    `scrypt$${'z'.repeat(32)}$${'b'.repeat(128)}`,
  ];

  for (const stored of malformed) {
    // 若实现改成抛错，这条会直接红 —— 同时覆盖「返回 false」与「不抛错」两个要求
    it(`格式非法（${stored.slice(0, 14) || '空串'}）返回 false 而不抛错`, async () => {
      expect(await verifyPassword(ANNOTATOR_PASSWORD, stored)).toBe(false);
    });
  }
});

describe('authenticate', () => {
  it('标注员的 role 与库中一致', async () => {
    expect((await authenticate(db, 'alice', ANNOTATOR_PASSWORD)).role).toBe('annotator');
  });

  it('标注员的 tenantId 与库中一致', async () => {
    expect((await authenticate(db, 'alice', ANNOTATOR_PASSWORD)).tenantId).toBe(TENANT_ID);
  });

  it('标注员的 tenantName 取自 tenants.name', async () => {
    expect((await authenticate(db, 'alice', ANNOTATOR_PASSWORD)).tenantName).toBe(TENANT_NAME);
  });

  it('标注员的 timezone 取自 tenants.timezone', async () => {
    expect((await authenticate(db, 'alice', ANNOTATOR_PASSWORD)).timezone).toBe(TENANT_TIMEZONE);
  });

  it('displayName 取自 users.display_name', async () => {
    expect((await authenticate(db, 'alice', ANNOTATOR_PASSWORD)).displayName).toBe('林小雨');
  });

  it('正确凭据返回的 id 是用户的库内 id', async () => {
    expect((await authenticate(db, 'alice', ANNOTATOR_PASSWORD)).id).toBe(ANNOTATOR_ID);
  });

  it('密码错误抛 UnauthorizedError', async () => {
    expect((await failure(() => authenticate(db, 'alice', 'wrong-password')))?.name).toBe('UnauthorizedError');
  });

  it('用户名不存在同样抛 UnauthorizedError', async () => {
    expect((await failure(() => authenticate(db, 'nobody', ANNOTATOR_PASSWORD)))?.name).toBe('UnauthorizedError');
  });

  it('密码错误与用户名不存在抛同一个类', async () => {
    const wrongPassword = await failure(() => authenticate(db, 'alice', 'wrong-password'));
    const unknownUser = await failure(() => authenticate(db, 'nobody', ANNOTATOR_PASSWORD));
    expect([wrongPassword?.name, unknownUser?.name]).toEqual(['UnauthorizedError', 'UnauthorizedError']);
  });

  it('密码错误与用户名不存在是同一句 message', async () => {
    const wrongPassword = await failure(() => authenticate(db, 'alice', 'wrong-password'));
    const unknownUser = await failure(() => authenticate(db, 'nobody', ANNOTATOR_PASSWORD));
    expect(unknownUser?.message).toBe(wrongPassword?.message);
  });

  it('登录失败的状态码是 401', async () => {
    expect((await failure(() => authenticate(db, 'alice', 'wrong-password')))?.status).toBe(401);
  });

  it('管理员登录后 tenantId 为 null', async () => {
    expect((await authenticate(db, 'admin', ADMIN_PASSWORD)).tenantId).toBeNull();
  });

  it('管理员登录后 tenantName 为 null', async () => {
    expect((await authenticate(db, 'admin', ADMIN_PASSWORD)).tenantName).toBeNull();
  });

  it('管理员登录后 timezone 是默认值', async () => {
    expect((await authenticate(db, 'admin', ADMIN_PASSWORD)).timezone).toBe(DEFAULT_TIMEZONE);
  });

  it('登录时顺带清理掉过期会话', async () => {
    insertSession(db, 'f'.repeat(48), ANNOTATOR_ID, 1, 0);
    await authenticate(db, 'alice', ANNOTATOR_PASSWORD);
    expect(sessionCount()).toBe(0);
  });
});

describe('createSession', () => {
  it('session id 是 48 位十六进制', () => {
    expect(createSession(db, ANNOTATOR_ID)).toMatch(/^[0-9a-f]{48}$/);
  });

  it('两次签发得到不同的 id', () => {
    expect(createSession(db, ANNOTATOR_ID)).not.toBe(createSession(db, ANNOTATOR_ID));
  });

  it('过期时间是签发时刻加 7 天', () => {
    const id = createSession(db, ANNOTATOR_ID);
    const row = db.prepare('SELECT expires_at, created_at FROM sessions WHERE id = ?').get(id) as {
      expires_at: number;
      created_at: number;
    };
    expect(row.expires_at - row.created_at).toBe(SESSION_TTL_MS);
  });
});

describe('resolveSession', () => {
  it('有效会话解析出对应用户', () => {
    const id = createSession(db, ANNOTATOR_ID);
    expect(resolveSession(db, id)?.id).toBe(ANNOTATOR_ID);
  });

  it('管理员的有效会话也能解析出身份', () => {
    const id = createSession(db, ADMIN_ID);
    expect(resolveSession(db, id)?.role).toBe('admin');
  });

  it('管理员的会话解析后 tenantId 为 null 且时区取默认值', () => {
    const id = createSession(db, ADMIN_ID);
    const user = resolveSession(db, id);
    expect([user?.tenantId, user?.tenantName, user?.timezone]).toEqual([null, null, DEFAULT_TIMEZONE]);
  });

  it('过期会话返回 null', () => {
    const id = createSession(db, ANNOTATOR_ID);
    db.prepare('UPDATE sessions SET expires_at = 0 WHERE id = ?').run(id);
    expect(resolveSession(db, id)).toBeNull();
  });

  it('伪造的 session id 返回 null', () => {
    expect(resolveSession(db, 'deadbeef'.repeat(6))).toBeNull();
  });

  it('用户被删除后返回 null', () => {
    const id = createSession(db, ANNOTATOR_ID);
    db.prepare('DELETE FROM users WHERE id = ?').run(ANNOTATOR_ID);
    expect(resolveSession(db, id)).toBeNull();
  });

  it('身份每次回表：租户改名后旧会话读到新名字', () => {
    const id = createSession(db, ANNOTATOR_ID);
    db.prepare('UPDATE tenants SET name = ? WHERE id = ?').run('改名后的空间', TENANT_ID);
    expect(resolveSession(db, id)?.tenantName).toBe('改名后的空间');
  });
});

describe('destroySession', () => {
  it('删除后同一 id 解析不到', () => {
    const id = createSession(db, ANNOTATOR_ID);
    destroySession(db, id);
    expect(resolveSession(db, id)).toBeNull();
  });

  it('session 不存在时静默成功', async () => {
    expect(await failure(() => destroySession(db, 'a'.repeat(48)))).toBeNull();
  });
});

describe('purgeExpiredSessions', () => {
  it('返回删除的过期行数', () => {
    insertSession(db, 'a'.repeat(48), ANNOTATOR_ID, 1, 0);
    insertSession(db, 'b'.repeat(48), ANNOTATOR_ID, 2, 0);
    createSession(db, ANNOTATOR_ID);
    expect(purgeExpiredSessions(db, Date.now())).toBe(2);
  });

  it('只删过期行，未过期会话仍在', () => {
    insertSession(db, 'a'.repeat(48), ANNOTATOR_ID, 1, 0);
    const alive = createSession(db, ANNOTATOR_ID);
    purgeExpiredSessions(db, Date.now());
    expect(resolveSession(db, alive)?.id).toBe(ANNOTATOR_ID);
  });

  it('没有过期会话时返回 0', () => {
    createSession(db, ANNOTATOR_ID);
    expect(purgeExpiredSessions(db, Date.now())).toBe(0);
  });
});
