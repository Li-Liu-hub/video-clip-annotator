/** 领域错误与统一错误响应体的用例：状态码、降级规则、泄漏防护、cause 追溯。 */
import { describe, expect, it } from 'vitest';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  OverlapError,
  StateConflictError,
  ValidationError,
  toErrorResponse,
} from '@/lib/errors';

describe('AppError 子类', () => {
  it('NotFoundError 是 404 / NOT_FOUND', () => {
    const err = new NotFoundError();
    expect([err.status, err.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('ForbiddenError 是 403 / FORBIDDEN', () => {
    const err = new ForbiddenError();
    expect([err.status, err.code]).toEqual([403, 'FORBIDDEN']);
  });

  it('ValidationError 是 400 / VALIDATION', () => {
    const err = new ValidationError('时间区间无效');
    expect([err.status, err.code]).toEqual([400, 'VALIDATION']);
  });

  it('StateConflictError 是 409 / STATE_CONFLICT', () => {
    const err = new StateConflictError();
    expect([err.status, err.code]).toEqual([409, 'STATE_CONFLICT']);
  });

  it('OverlapError 是 409 / OVERLAP', () => {
    const err = new OverlapError();
    expect([err.status, err.code]).toEqual([409, 'OVERLAP']);
  });

  it('子类的 name 指向子类名，不是 Error', () => {
    expect(new OverlapError().name).toBe('OverlapError');
  });

  it('子类都是 AppError 与 Error 的实例', () => {
    const err = new ValidationError('标签不能为空');
    expect(err instanceof AppError && err instanceof Error).toBe(true);
  });
});

describe('OverlapError 的附加信息', () => {
  it('冲突区间放进 details', () => {
    const err = new OverlapError({ startMs: 1000, endMs: 2000 });
    expect(err.details).toEqual({ conflict: { startMs: 1000, endMs: 2000 } });
  });

  it('没有冲突区间时 details 为空', () => {
    expect(new OverlapError().details).toBeUndefined();
  });

  it('保留原始异常作为 cause，便于区分预检与触发器', () => {
    const raw = new Error('SQLITE_CONSTRAINT: OVERLAP');
    expect(new OverlapError(undefined, '冲突', { cause: raw }).cause).toBe(raw);
  });
});

describe('toErrorResponse', () => {
  it('AppError 保留状态码、业务错误码与中文文案', () => {
    expect(toErrorResponse(new NotFoundError('任务不存在'))).toEqual({
      status: 404,
      body: { ok: false, error: { code: 'NOT_FOUND', message: '任务不存在' } },
    });
  });

  it('ForbiddenError 的响应体是 403', () => {
    expect(toErrorResponse(new ForbiddenError()).status).toBe(403);
  });

  it('ValidationError 的响应体是 400', () => {
    expect(toErrorResponse(new ValidationError('x')).status).toBe(400);
  });

  it('StateConflictError 的响应体是 409', () => {
    expect(toErrorResponse(new StateConflictError()).status).toBe(409);
  });

  it('普通 Error 降级为 500 / INTERNAL', () => {
    const r = toErrorResponse(new Error('boom'));
    expect([r.status, r.body.error.code]).toEqual([500, 'INTERNAL']);
  });

  it('非 Error 的抛出物同样降级为 500 / INTERNAL', () => {
    expect(toErrorResponse('字符串也能被 throw').body.error.code).toBe('INTERNAL');
  });

  it('null 与 undefined 也降级为 INTERNAL', () => {
    expect(toErrorResponse(null).body.error.code).toBe('INTERNAL');
    expect(toErrorResponse(undefined).body.error.code).toBe('INTERNAL');
  });

  it('降级文案是固定通用文案，不带原始信息', () => {
    const r = toErrorResponse(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: users.username'));
    expect(r.body.error.message).toBe('服务器内部错误，请稍后再试');
  });

  it('details 不进入响应体', () => {
    const r = toErrorResponse(new OverlapError({ startMs: 1000, endMs: 2000 }));
    expect(Object.keys(r.body.error)).toEqual(['code', 'message']);
  });
});

describe('响应体不得泄漏实现细节', () => {
  const forbidden = ['segments', 'SQLITE', 'UNIQUE', 'stack', 'at Object', 'C:\\', '/home/'];

  const samples: unknown[] = [
    new Error('SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: segments.tenant_id'),
    new Error('ENOENT: no such file or directory, open C:\\tmp\\segments\\a.mp4'),
    { message: 'sqlite3.Database' },
    'raw string',
    null,
  ];

  for (const sample of samples) {
    it(`输入 ${String(sample).slice(0, 40)} 时响应体不含禁词`, () => {
      const text = JSON.stringify(toErrorResponse(sample).body);
      expect(forbidden.filter((w) => text.includes(w))).toEqual([]);
    });
  }
});

describe('跨租户的文案一致性', () => {
  it('「不存在」与「属于他人」返回完全相同的文案', () => {
    // 两者必须不可区分，否则 404 就变成了「这个资源存在」的确认信号
    expect(new NotFoundError().message).toBe(new NotFoundError('资源不存在').message);
  });

  it('NotFound 的默认文案里不出现「权限」二字', () => {
    expect(new NotFoundError().message).not.toContain('权限');
  });
});
