/** users 表读取。认证查询刻意不带 tenant_id 谓词：username 全局唯一，登录时尚不知道租户。 */
import type { DB } from '@/lib/db';

export type UserRow = {
  id: string;
  tenant_id: string | null;
  username: string;
  display_name: string;
  password_hash: string;
  role: 'admin' | 'annotator';
};

/** 用户 + 所属租户的名与时区。管理员两项均为 NULL。 */
export type UserWithTenantRow = UserRow & {
  tenant_name: string | null;
  timezone: string | null;
};

const USER_COLUMNS = 'id, tenant_id, username, display_name, password_hash, role';

export function findByUsername(db: DB, username: string): UserRow | null {
  // audit-ignore: 认证查询，username 全局唯一
  const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`).get(username);
  return (row as UserRow | undefined) ?? null;
}

export function findById(db: DB, id: string): UserRow | null {
  const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id);
  return (row as UserRow | undefined) ?? null;
}

/**
 * 登录成功后装配身份用：一次取到用户与其租户。
 *
 * LEFT JOIN 不能改成 INNER JOIN —— 管理员的 tenant_id 为 NULL，
 * INNER JOIN 会让管理员登录后装配不出身份。
 */
export function findWithTenantById(db: DB, id: string): UserWithTenantRow | null {
  const row = db
    .prepare(
      `SELECT u.id, u.tenant_id, u.username, u.display_name, u.password_hash, u.role,
              t.name AS tenant_name, t.timezone
         FROM users u
    LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE u.id = ?`,
    )
    .get(id);
  return (row as UserWithTenantRow | undefined) ?? null;
}
