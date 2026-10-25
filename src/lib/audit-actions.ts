/**
 * 审计动作名的唯一来源。
 *
 * 写入侧用 `AuditAction`（拼错即编译错），读取侧仍按 `string` 处理 ——
 * `audit_logs.action` 是 TEXT，历史库里可能有枚举之外的值，按枚举读会在读取时抛错。
 */

export const AUDIT_ACTIONS = {
  taskCreate: 'task.create',
  taskClaim: 'task.claim',
  taskRelease: 'task.release',
  taskSubmit: 'task.submit',
  taskReject: 'task.reject',
  taskReopen: 'task.reopen',
  authLogin: 'auth.login',
  authLoginFailed: 'auth.login_failed',
} as const;

/**
 * 登出与改密不进 AUDIT_ACTIONS：契约表只收八个业务与认证动作，而 `auth.logout` 在 07、
 * `auth.password_changed` 在 O1 才出现，且都有各自的用例。单独成常量并入 AuditAction，
 * 既不删既有审计，也不让这里多出两个键（`tests/audit.test.ts` 逐项核对了那八个值）。
 */
export const AUTH_LOGOUT_ACTION = 'auth.logout';
export const AUTH_PASSWORD_CHANGED_ACTION = 'auth.password_changed';

export type AuditAction =
  | (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]
  | typeof AUTH_LOGOUT_ACTION
  | typeof AUTH_PASSWORD_CHANGED_ACTION;
