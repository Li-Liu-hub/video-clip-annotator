/**
 * 审计写入的唯一入口：调用方只描述「发生了什么」，序列化与落盘在此完成。
 *
 * 两种模式，由 `strict` 区分：
 *
 * - **旁路模式（默认）**：用于认证类操作。登录成功不能因为审计写不进去就变 500，
 *   但静默丢数据同样不可接受，因此吞异常前必须留一条 error 日志 ——
 *   本文件是全项目唯一允许出现 console 的地方。
 *
 * - **严格模式（`strict: true`）**：用于业务写。此时审计与状态跃迁在同一个事务里，
 *   「任务建了但没记录」和「账本扣了但没记录」都是不可接受的断链。
 *   审计失败必须向上抛，让调用方的 `writeTx` 整体回滚。
 *
 * 默认值是旁路，因为认证是高频且可重试的；业务写必须显式要求严格，
 * 免得后来的人顺手一调又把事务完整性弄丢。
 *
 * 判据只有一句：**这次操作如果没留下审计，业务数据会不会变成无法解释的状态？**
 * 会 → 严格；不会 → 旁路。提交/退回/重新打开会改变账本与状态，属前者；
 * 登录只产生一条会话，丢日志不影响账目，属后者。
 */
import type { DB } from '@/lib/db';
import type { AuditAction } from '@/lib/audit-actions';
import { insertAudit } from '@/lib/db/repos/audit-repo';

export type AuditEntry = {
  actorId: string | null;
  actorRole: string | null;
  tenantId: string | null;
  /** 收窄自 string：动作名只能取自 AUDIT_ACTIONS，拼错变成编译错误而不是一条查不到的死数据 */
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  detail?: unknown;
  ip?: string | null;
  userAgent?: string | null;
};

/** 写一条审计。detail 序列化为 JSON，undefined 时存 NULL。 */
export function writeAudit(db: DB, entry: AuditEntry, options?: { strict?: boolean }): void {
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
    // 严格模式：业务写把审计当事务的一部分，失败必须让整个 writeTx 回滚，
    // 否则会出现「任务已建 / 状态已变 / 账本已扣，但没有操作记录」
    if (options?.strict) throw err;
    // rule-exception: 审计失败不影响登录 —— 批准人 CLAUDE
    // eslint-disable-next-line no-console -- 旁路可以失败，但不许静默失败
    console.error('审计写入失败', err);
  }
}
