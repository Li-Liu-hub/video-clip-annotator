/** 临时安全验证：确认畸形哈希不会通过校验。跑完即删。 */
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/services/auth-service';

describe('畸形密码哈希', () => {
  it('scrypt$zz$zz 不得通过', () => {
    // 若不校验 hex 与长度，Buffer.from('zz','hex') 得空 buffer，timingSafeEqual(空,空) 为 true
    expect(verifyPassword('任意密码', 'scrypt$zz$zz')).toBe(false);
  });

  it('空 salt 与空 hash 不得通过', () => {
    expect(verifyPassword('x', 'scrypt$$')).toBe(false);
  });

  it('截断到 8 字节的哈希不得通过', () => {
    const real = hashPassword('secret');
    const [, salt, hash] = real.split('$');
    const truncated = `scrypt$${salt}$${hash.slice(0, 32)}`;
    expect(verifyPassword('secret', truncated)).toBe(false);
  });

  it('长度正确但内容错误的哈希不得通过', () => {
    const fake = `scrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`;
    expect(verifyPassword('x', fake)).toBe(false);
  });
});

describe('登录耗时是否随用户是否存在而变化', () => {
  it('不存在的用户也应消耗与真实用户相当的时间（防用户名枚举）', async () => {
    const { createDb } = await import('@/lib/db');
    const { authenticate } = await import('@/lib/services/auth-service');
    const db = createDb(':memory:');

    // 造一个用户
    const tenantId = 'tenantA';
    db.prepare('INSERT INTO tenants (id,name,timezone,created_at) VALUES (?,?,?,?)').run(
      tenantId,
      'T',
      'Asia/Shanghai',
      0,
    );
    db.prepare(
      'INSERT INTO users (id,tenant_id,username,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run('u1', tenantId, 'alice', 'A', hashPassword('demo123'), 'annotator', 0);

    const time = (fn: () => void) => {
      const t0 = performance.now();
      try {
        fn();
      } catch {
        /* 预期抛错 */
      }
      return performance.now() - t0;
    };

    // 各跑三次取最小，减少抖动
    const existing = Math.min(
      ...Array.from({ length: 3 }, () => time(() => authenticate(db, 'alice', 'wrong'))),
    );
    const missing = Math.min(
      ...Array.from({ length: 3 }, () => time(() => authenticate(db, 'nobody', 'wrong'))),
    );

    // 两者应当在同一数量级（允许 5 倍差异，只挡「完全跳过 scrypt」这种数量级差）
    expect(missing).toBeGreaterThan(existing / 5);

    db.close();
  });
});
