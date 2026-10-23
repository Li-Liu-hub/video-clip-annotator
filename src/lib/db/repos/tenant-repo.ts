/**
 * tenants 表读取：建任务前校验租户存在，建任务页列出可发布的租户。
 *
 * 本表描述租户自身，没有 tenant_id 列，故查询不带租户谓词。
 */
import type { DB } from '@/lib/db';

export type TenantRow = {
  id: string;
  name: string;
  timezone: string;
  created_at: number;
};

const TENANT_COLUMNS = 'id, name, timezone, created_at';

export function findById(db: DB, id: string): TenantRow | null {
  const row = db.prepare(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = ?`).get(id);
  return (row as TenantRow | undefined) ?? null;
}

/** 按名称排序：下拉与清单里顺序稳定，不随插入顺序漂移。 */
export function listAll(db: DB): TenantRow[] {
  return db.prepare(`SELECT ${TENANT_COLUMNS} FROM tenants ORDER BY name, id`).all() as TenantRow[];
}
