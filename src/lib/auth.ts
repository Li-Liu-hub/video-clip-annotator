import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { getDb, nowMs } from './db';

export const SESSION_COOKIE = 'vsap_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type Role = 'admin' | 'annotator';

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /** 管理员为 null —— 这是平台角色而非租户内角色 */
  tenantId: string | null;
  tenantName: string | null;
  timezone: string;
};

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = scryptSync(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function createSession(userId: string): string {
  const db = getDb();
  const id = randomBytes(24).toString('hex');
  const expiresAt = nowMs() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    expiresAt,
    nowMs(),
  );
  return id;
}

export function destroySession(sessionId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  tenant_id: string | null;
  tenant_name: string | null;
  timezone: string | null;
};

/**
 * 当前登录用户。每次请求都回表查一次 —— 不信任 cookie 里的任何身份字段，
 * 否则改一个 cookie 就能换角色或换租户。
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const sid = store.get(SESSION_COOKIE)?.value;
  if (!sid) return null;

  const row = getDb()
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.tenant_id,
              t.name AS tenant_name, t.timezone
         FROM sessions s
         JOIN users u   ON u.id = s.user_id
    LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE s.id = ? AND s.expires_at > ?`,
    )
    .get(sid, nowMs()) as UserRow | undefined;

  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    timezone: row.timezone ?? 'Asia/Shanghai',
  };
}

/** 标注员必须有租户；这里做一次运行期兜底，防止数据被手工改坏后越权 */
export function annotatorTenantId(actor: SessionUser): string {
  if (actor.role !== 'annotator' || !actor.tenantId) {
    throw new Error('actor is not a tenant-bound annotator');
  }
  return actor.tenantId;
}
