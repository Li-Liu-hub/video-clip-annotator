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

/**
 * 按 id 取会话行，**不判断是否过期**。
 * 用于「登录时清理旧会话」这类需要看归属的场景：过期行同样该被清掉。
 */
export function findSession(db: DB, sessionId: string): SessionRow | null {
  const row = db.prepare('SELECT id, user_id, expires_at FROM sessions WHERE id = ?').get(sessionId);
  return (row as SessionRow | undefined) ?? null;
}

export function deleteSession(db: DB, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/**
 * 删掉某用户除 keepSessionId 外的全部会话，返回删除行数。
 *
 * 改密后旧口令签发的会话仍在别的浏览器里活着，等于改密没生效；
 * 但把当前这条一起删掉，用户改完密码就被自己踢出登录页。
 */
export function deleteOtherSessionsOfUser(db: DB, userId: string, keepSessionId: string): number {
  return db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, keepSessionId)
    .changes;
}

export function deleteExpired(db: DB, nowMs: number): number {
  // 与查询侧「expires_at > now 才算有效」严格互补，恰好到期的行算过期
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowMs).changes;
}
