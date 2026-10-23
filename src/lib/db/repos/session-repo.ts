/** sessions 表读写。解析身份时一次 join 取全，避免「会话 → 用户 → 租户」三次往返。 */
import type { DB } from '@/lib/db';
import type { UserWithTenantRow } from './user-repo';

export type SessionRow = {
  id: string;
  user_id: string;
  expires_at: number;
};

/** 会话 + 用户 + 租户。与 UserWithTenantRow 共用一份定义，避免两处字段各自漂移。 */
export type JoinedUserRow = UserWithTenantRow;

export function insertSession(
  db: DB,
  id: string,
  userId: string,
  expiresAt: number,
  createdAt: number,
): void {
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    expiresAt,
    createdAt,
  );
}

/**
 * 按会话 id 取身份，过期会话直接查不到。
 *
 * LEFT JOIN 是必需的：管理员 tenant_id 为 NULL，INNER JOIN 会让管理员永远解析不出身份。
 */
export function findSessionWithUser(db: DB, sessionId: string, nowMs: number): JoinedUserRow | null {
  const row = db
    .prepare(
      `SELECT u.id, u.tenant_id, u.username, u.display_name, u.password_hash, u.role,
              t.name AS tenant_name, t.timezone
         FROM sessions s
         JOIN users u   ON u.id = s.user_id
    LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE s.id = ? AND s.expires_at > ?`,
    )
    .get(sessionId, nowMs);
  return (row as JoinedUserRow | undefined) ?? null;
}

export function deleteSession(db: DB, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function deleteExpired(db: DB, nowMs: number): number {
  // 与查询侧「expires_at > now 才算有效」严格互补，恰好到期的行算过期
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowMs).changes;
}
