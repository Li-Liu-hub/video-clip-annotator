/**
 * 审计查询的唯一入口：只有管理员，只读。
 *
 * 本文件不提供删除与编辑 —— 审计的价值在于「不能被人事后擦掉」。
 * 不 import next/headers：身份由调用方注入，可在内存库上单测。
 */
import type { DB } from '@/lib/db';
import {
  countAudit,
  listAudit,
  type AuditFilter,
  type AuditRow,
} from '@/lib/db/repos/audit-repo';
import { listAll as listUserOptions } from '@/lib/db/repos/user-repo';
import { ForbiddenError } from '@/lib/errors';
import type { SessionUser } from './auth-service';

export type { AuditFilter, AuditRow };

export type AuditActorOption = { id: string; displayName: string };

/** 文案不带「租户」：这里判的是角色，不是访问范围。 */
const ADMIN_ONLY_MESSAGE = '审计记录只有管理员可查看';

/** 只有管理员。标注员连自己的审计也看不到 —— 那是管理信息。 */
function assertAdmin(actor: SessionUser): void {
  if (actor.role !== 'admin') throw new ForbiddenError(ADMIN_ONLY_MESSAGE);
}

/**
 * 审计列表。范围由角色决定，不由查询条件决定：
 * 管理员是全局视角，查询里刻意没有租户谓词（审计表里管理员自己那几行 tenant_id 就是 NULL）。
 */
export function listAuditLogs(
  db: DB,
  actor: SessionUser,
  filter: AuditFilter,
  page: { limit: number; offset: number },
): { rows: AuditRow[]; total: number } {
  assertAdmin(actor);
  return { rows: listAudit(db, filter, page), total: countAudit(db, filter) };
}

/**
 * 「人」筛选的下拉数据。
 *
 * 列全部用户而不是「本租户用户」：管理员没有租户，而审计范围本来就是全局的 ——
 * 若只列某个租户的人，管理员就永远筛不到另一个租户的登录失败。
 */
export function listAuditActors(db: DB, actor: SessionUser): AuditActorOption[] {
  assertAdmin(actor);
  return listUserOptions(db).map((row) => ({ id: row.id, displayName: row.display_name }));
}
