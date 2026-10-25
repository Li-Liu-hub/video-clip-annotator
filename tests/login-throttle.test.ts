/**
 * O1 验收：登录失败计数。
 *
 * 纯函数部分直接调模块；路由部分只替换三样：连接入口、cookie、凭据校验函数。
 * 「第 6 次不跑 scrypt」用调用次数证明 —— 计时在 CI 上不可靠，次数是确定的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/auth/login/route';
import { createDb, type DB } from '@/lib/db';
import { hashPassword, loginWithFreshSession } from '@/lib/services/auth-service';
import {
  MAX_FAILURES,
  WINDOW_MS,
  clearFailures,
  isLocked,
  noteFailure,
  resetThrottle,
  throttleKey,
} from '@/lib/server/login-throttle';

const HOLDER = vi.hoisted(() => ({ db: null as DB | null, sid: null as string | null }));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getDb: () => HOLDER.db };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (HOLDER.sid ? { name, value: HOLDER.sid } : undefined),
  }),
}));

/** 包一层计数，其余仍是真实现：这样别处的断言不受影响，这里能数调用次数 */
vi.mock('@/lib/services/auth-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/auth-service')>();
  return { ...actual, loginWithFreshSession: vi.fn(actual.loginWithFreshSession) };
});

const TENANT_ID = '1111111111111111';
const ALICE_PASSWORD = 'demo123';
const IP = '10.0.0.1';
/** 时间基准无意义，只用来跨窗口；固定值让「窗口边界」这类断言不受真实时钟影响 */
const T0 = 1_760_000_000_000;

let db: DB;

function seed(): DB {
  const fresh = createDb(':memory:');
  const insertTenant = fresh.prepare(
    'INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)',
  );
  insertTenant.run(TENANT_ID, '星尘机器人', 'Asia/Shanghai', 0);
  // 每个租户只能挂一个标注员（部分唯一索引），bob 必须有自己的租户
  insertTenant.run('4444444444444444', '第二个工作空间', 'Asia/Shanghai', 0);
  const insertUser = fresh.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run('2222222222222222', TENANT_ID, 'alice', '林小雨', hashPassword(ALICE_PASSWORD), 'annotator', 0);
  insertUser.run('3333333333333333', '4444444444444444', 'bob', '陈默', hashPassword(ALICE_PASSWORD), 'annotator', 0);
  return fresh;
}

function login(username: string, password: string, ip = IP): Promise<Response> {
  return POST(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'vitest',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({ username, password }),
    }),
  );
}

/** 连错 n 次，返回最后一次的状态码 */
async function failTimes(n: number, username = 'alice', ip = IP): Promise<number> {
  let status = 0;
  for (let i = 0; i < n; i += 1) {
    status = (await login(username, 'wrong-password', ip)).status;
  }
  return status;
}

beforeEach(() => {
  db = seed();
  HOLDER.db = db;
  HOLDER.sid = null;
  resetThrottle();
  vi.mocked(loginWithFreshSession).mockClear();
});

afterEach(() => {
  db.close();
  HOLDER.db = null;
});

describe('throttleKey', () => {
  it('由 IP 与用户名组成，用户名统一小写', () => {
    expect(throttleKey('10.0.0.1', 'Alice')).toBe('10.0.0.1:alice');
  });

  it('没有 IP 时用固定占位，仍按用户名分桶', () => {
    expect(throttleKey(null, 'alice')).toBe('unknown:alice');
  });
});

describe('失败计数', () => {
  const KEY = 'k';

  it(`窗口上限是 ${MAX_FAILURES} 次、${WINDOW_MS} 毫秒`, () => {
    expect([MAX_FAILURES, WINDOW_MS]).toEqual([5, 60_000]);
  });

  it('失败 4 次仍未锁', () => {
    for (let i = 0; i < 4; i += 1) noteFailure(KEY, T0);
    expect(isLocked(KEY, T0)).toBe(false);
  });

  it('失败 5 次后锁定', () => {
    for (let i = 0; i < 5; i += 1) noteFailure(KEY, T0);
    expect(isLocked(KEY, T0)).toBe(true);
  });

  it('窗口到期自动解锁', () => {
    for (let i = 0; i < 5; i += 1) noteFailure(KEY, T0);
    expect(isLocked(KEY, T0 + WINDOW_MS)).toBe(false);
  });

  it('窗口到期后重新计数（再错一次不会立刻锁）', () => {
    for (let i = 0; i < 5; i += 1) noteFailure(KEY, T0);
    noteFailure(KEY, T0 + WINDOW_MS);
    expect(isLocked(KEY, T0 + WINDOW_MS)).toBe(false);
  });

  it('clearFailures 立即解锁', () => {
    for (let i = 0; i < 5; i += 1) noteFailure(KEY, T0);
    clearFailures(KEY);
    expect(isLocked(KEY, T0)).toBe(false);
  });

  it('不同用户名互不影响', () => {
    for (let i = 0; i < 5; i += 1) noteFailure(throttleKey(IP, 'alice'), T0);
    expect(isLocked(throttleKey(IP, 'bob'), T0)).toBe(false);
  });

  it('不同 IP 互不影响', () => {
    for (let i = 0; i < 5; i += 1) noteFailure(throttleKey('10.0.0.1', 'alice'), T0);
    expect(isLocked(throttleKey('10.0.0.2', 'alice'), T0)).toBe(false);
  });

  it('用户名大小写不同视为同一个桶', () => {
    for (let i = 0; i < 5; i += 1) noteFailure(throttleKey(IP, 'Alice'), T0);
    expect(isLocked(throttleKey(IP, 'alice'), T0)).toBe(true);
  });

  it('resetThrottle 清空全部桶', () => {
    for (let i = 0; i < 5; i += 1) noteFailure(KEY, T0);
    resetThrottle();
    expect(isLocked(KEY, T0)).toBe(false);
  });
});

describe('POST /api/auth/login 的限流', () => {
  it('连续 5 次密码错都返回 401', async () => {
    expect(await failTimes(5)).toBe(401);
  });

  it('第 6 次返回 429', async () => {
    await failTimes(5);
    expect((await login('alice', 'wrong-password')).status).toBe(429);
  });

  it('第 6 次的 code 是 RATE_LIMITED', async () => {
    await failTimes(5);
    const body = (await (await login('alice', 'wrong-password')).json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('第 6 次不进入凭据校验（即不跑 scrypt）', async () => {
    await failTimes(5);
    await login('alice', ALICE_PASSWORD);
    expect(vi.mocked(loginWithFreshSession).mock.calls).toHaveLength(5);
  });

  it('被锁后即使口令正确也是 429', async () => {
    await failTimes(5);
    expect((await login('alice', ALICE_PASSWORD)).status).toBe(429);
  });

  it('成功登录后计数清零：再错仍是 401', async () => {
    await failTimes(4);
    await login('alice', ALICE_PASSWORD);
    expect((await login('alice', 'wrong-password')).status).toBe(401);
  });

  it('成功登录后计数清零：连续再错 5 次才会锁', async () => {
    await failTimes(4);
    await login('alice', ALICE_PASSWORD);
    expect(await failTimes(5)).toBe(401);
  });

  it('锁的是「IP + 用户名」：同一 IP 换用户名仍可登录', async () => {
    await failTimes(5, 'alice');
    expect((await login('bob', ALICE_PASSWORD)).status).toBe(200);
  });

  it('锁的是「IP + 用户名」：同一用户换 IP 仍可登录', async () => {
    await failTimes(5, 'alice');
    expect((await login('alice', ALICE_PASSWORD, '10.0.0.2')).status).toBe(200);
  });

  it('成功登录会写 auth.login，锁定时不写', async () => {
    await failTimes(5);
    await login('alice', ALICE_PASSWORD);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.login'").get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });
});
