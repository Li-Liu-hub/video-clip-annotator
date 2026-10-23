/**
 * 领域错误的唯一出口。
 *
 * 业务层只抛 AppError 子类，路由层统一用 toErrorBody 转响应体 ——
 * 这样「哪些细节能出网」只在一处决定，不会因为某个 handler 顺手 return err.message 而泄漏 SQL。
 */
import type { Interval } from '@/lib/interval';

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'OVERLAP'
  | 'STATE_CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** 给调用方补充判断用的结构化信息（如冲突区间）。只进日志，不进响应体。 */
  readonly details?: unknown;

  constructor(code: ErrorCode, status: number, message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, options);
    // 子类实例的 name 指向子类名，日志里一眼能看出错误类型
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * 401 的错误码用 `UNAUTHENTICATED` 而非 `UNAUTHORIZED`。
 *
 * HTTP 状态码叫 401 Unauthorized 是历史遗留（RFC 7235 明说它的实际含义是「缺少有效认证凭据」）。
 * 若照抄字面用 `UNAUTHORIZED`，它和 `FORBIDDEN` 在名字上就分不清了——
 * 前端看到一个 UNAUTHORIZED 一个 FORBIDDEN，会以为都是「没权限」。
 * `UNAUTHENTICATED`（没有身份）与 `FORBIDDEN`（有身份但无权限）才是真正可区分的两个概念。
 */
export class UnauthorizedError extends AppError {
  constructor(message = '请先登录') {
    super('UNAUTHENTICATED', 401, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super('NOT_FOUND', 404, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = '没有权限执行该操作') {
    super('FORBIDDEN', 403, message);
  }
}

export class ValidationError extends AppError {
  constructor(message = '请求参数不合法') {
    super('VALIDATION', 400, message);
  }
}

export class StateConflictError extends AppError {
  constructor(message = '当前状态不允许该操作') {
    super('STATE_CONFLICT', 409, message);
  }
}

export class OverlapError extends AppError {
  /** cause 用于保留原始 SQLITE_CONSTRAINT：应用层预检与触发器都抛 OVERLAP，日志里靠它区分来源。 */
  constructor(conflict?: Interval, message = '该时间段与已有片段重叠', options?: { cause?: unknown }) {
    super('OVERLAP', 409, message, conflict ? { conflict } : undefined, options);
  }
}

export type ErrorBody = {
  ok: false;
  error: { code: string; message: string };
};

export type ErrorResponse = { status: number; body: ErrorBody };

// 兜底文案刻意与原始异常无关：堆栈、SQL、表名都不能到客户端
const INTERNAL_MESSAGE = '服务器内部错误，请稍后再试';

/**
 * 把任意抛出物压成 { status, body }；非 AppError 一律降级为 500 + INTERNAL。
 *
 * 连 status 一起返回，是为了让「这个错误该回 404 还是 500」也只在这一处决定。
 * 否则每个 route handler 都要写一遍 `err instanceof AppError ? err.status : 500`，
 * 11 个 handler 里漏一个就会出现「HTTP 200 + body {ok:false}」。
 */
export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { ok: false, error: { code: err.code, message: err.message } },
    };
  }
  return {
    status: 500,
    body: { ok: false, error: { code: 'INTERNAL', message: INTERNAL_MESSAGE } },
  };
}
