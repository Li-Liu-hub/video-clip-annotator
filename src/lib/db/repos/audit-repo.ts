/**
 * audit_logs 表读写：只提供插入。
 *
 * 审计只追加，因此没有 update / delete 入口 —— 不提供能力比提供后靠自觉更可靠。
 */
import { randomBytes } from 'node:crypto';
import { nowMs, type DB } from '@/lib/db';

/** 8 字节随机数 → 16 位十六进制，与 RULES 的 id 约定一致 */
const AUDIT_ID_BYTES = 8;

export type AuditLogInsert = {
  actorId: string | null;
  actorRole: string | null;
  tenantId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** 已序列化的 JSON；调用方负责把 undefined 折成 null */
  detail: string | null;
  ip: string | null;
  userAgent: string | null;
};

export function insertAudit(db: DB, entry: AuditLogInsert): void {
  db.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_role, tenant_id, action, target_type, target_id, detail, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomBytes(AUDIT_ID_BYTES).toString('hex'),
    entry.actorId,
    entry.actorRole,
    entry.tenantId,
    entry.action,
    entry.targetType,
    entry.targetId,
    entry.detail,
    entry.ip,
    entry.userAgent,
    nowMs(),
  );
}
