/**
 * 审计动作 → 中文标签。
 *
 * 表按 AuditAction 铺满：漏一条即编译错误，新增 action 时不会静默显示成 raw 值。
 */
import type { AuditAction } from '@/lib/audit-actions';

const LABELS: Record<AuditAction, string> = {
  'task.create': '创建任务',
  'task.claim': '领取任务',
  'task.release': '归还任务',
  'task.submit': '提交任务',
  'task.reject': '退回任务',
  'task.reopen': '重新打开',
  'auth.login': '登录',
  'auth.login_failed': '登录失败',
  'auth.logout': '登出',
  'auth.password_changed': '修改密码',
};

function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(LABELS, value);
}

/**
 * 未知 action 回落 raw 值而不是「未知动作」：
 * audit_logs.action 是 TEXT，库里可能有枚举之外的历史值，显示原文比显示「未知」有用。
 */
export function auditActionLabel(action: string): string {
  return isAuditAction(action) ? LABELS[action] : action;
}
