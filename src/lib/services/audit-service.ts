/**
 * 审计写入的唯一入口：调用方只描述「发生了什么」，序列化与落盘在此完成。
 *
 * 审计是旁路 —— 写入失败不能改变被审计操作的结果（登录成功不能因审计失败变 500）。
 * 但静默丢数据同样不可接受，因此吞异常前必须留一条 error 日志：本文件是全项目唯一
 * 允许出现 console 的地方，异常集中在这里处理，调用方无需各自 try。
 */
import type { DB } from '@/lib/db';
import { insertAudit } from '@/lib/db/repos/audit-repo';

export type AuditEntry = {
  actorId: string | null;
  actorRole: string | null;
  tenantId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: unknown;
  ip?: string | null;
  userAgent?: string | null;
};

/** 写一条审计。detail 序列化为 JSON，undefined 时存 NULL。 */
export function writeAudit(db: DB, entry: AuditEntry): void {
  try {
    insertAudit(db, {
      actorId: entry.actorId,
      actorRole: entry.actorRole,
      tenantId: entry.tenantId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      // JSON.stringify(undefined) 返回 undefined 而非 'undefined' 字符串，落库会被绑成 NULL；
      // 这里显式判 undefined，是为了让「没带 detail」与「detail 是 null」在类型上就区分开
      detail: entry.detail === undefined ? null : JSON.stringify(entry.detail),
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
    });
  } catch (err) {
    // rule-exception: 审计失败不影响登录 —— 批准人 CLAUDE
    // eslint-disable-next-line no-console -- 旁路可以失败，但不许静默失败
    console.error('审计写入失败', err);
  }
}
