/**
 * 两套守卫的分流方向与 isTenantUser 的类型窄化。
 *
 * getCurrentUser 依赖 next/headers 的 cookies()，测试环境无请求上下文，故整体 mock。
 * redirect 的真实实现靠抛 NEXT_REDIRECT 中断渲染，mock 也必须抛 ——
 * 若只记录参数不抛错，requireUser 会带着 null 继续往下走，用例反而变绿。
 * 因此每个「未登录」用例同时断言了「抛了」和「没返回用户」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redirect } from 'next/navigation';
import { ForbiddenError, UnauthorizedError } from '@/lib/errors';
import { getCurrentUser } from '@/lib/server/current-user';
import { requireAdmin, requireUser } from '@/lib/server/guards';
import { requireApiAdmin, requireApiUser } from '@/lib/server/api-guard';
import { isTenantUser, type SessionUser } from '@/lib/services/auth-service';

vi.mock('@/lib/server/current-user', () => ({ getCurrentUser: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

const currentUser = vi.mocked(getCurrentUser);
const mockedRedirect = vi.mocked(redirect);

const ANNOTATOR: SessionUser = {
  id: '2222222222222222',
  username: 'alice',
  displayName: '林小雨',
  role: 'annotator',
  tenantId: '1111111111111111',
  tenantName: '林小雨的工作空间',
  timezone: 'Asia/Shanghai',
};

const ADMIN: SessionUser = {
  id: '3333333333333333',
  username: 'admin',
  displayName: '平台管理员',
  role: 'admin',
  tenantId: null,
  tenantName: null,
  timezone: 'Asia/Shanghai',
};

/** 跑一遍守卫并取回抛出物；未抛出返回 null —— 「没返回用户」的证据只能是它抛了。 */
async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  // clearAllMocks 只清调用记录，保留 redirect 的「必抛」实现
  vi.clearAllMocks();
});

describe('requireUser', () => {
  it('未登录时重定向到 /login', async () => {
    currentUser.mockResolvedValue(null);
    await rejection(requireUser);
    expect(mockedRedirect).toHaveBeenCalledWith('/login');
  });

  it('未登录时抛出重定向信号而不是返回用户', async () => {
    currentUser.mockResolvedValue(null);
    expect(await rejection(requireUser)).toMatchObject({ message: 'NEXT_REDIRECT:/login' });
  });

  it('已登录时返回当前用户', async () => {
    currentUser.mockResolvedValue(ANNOTATOR);
    expect((await requireUser()).id).toBe(ANNOTATOR.id);
  });

  it('已登录时不触发重定向', async () => {
    currentUser.mockResolvedValue(ANNOTATOR);
    await requireUser();
    expect(mockedRedirect).not.toHaveBeenCalled();
  });
});

describe('requireAdmin', () => {
  it('标注员访问时重定向到 /tasks', async () => {
    currentUser.mockResolvedValue(ANNOTATOR);
    await rejection(requireAdmin);
    expect(mockedRedirect).toHaveBeenCalledWith('/tasks');
  });

  it('标注员访问时不会被送去登录页', async () => {
    currentUser.mockResolvedValue(ANNOTATOR);
    await rejection(requireAdmin);
    expect(mockedRedirect).not.toHaveBeenCalledWith('/login');
  });

  it('标注员访问时不返回用户', async () => {
    currentUser.mockResolvedValue(ANNOTATOR);
    expect(await rejection(requireAdmin)).toMatchObject({ message: 'NEXT_REDIRECT:/tasks' });
  });

  it('未登录访问时重定向到 /login', async () => {
    currentUser.mockResolvedValue(null);
    await rejection(requireAdmin);
    expect(mockedRedirect).toHaveBeenCalledWith('/login');
  });

  it('管理员访问时返回当前用户', async () => {
    currentUser.mockResolvedValue(ADMIN);
    expect((await requireAdmin()).id).toBe(ADMIN.id);
  });

  it('管理员访问时不触发重定向', async () => {
    currentUser.mockResolvedValue(ADMIN);
    await requireAdmin();
    expect(mockedRedirect).not.toHaveBeenCalled();
  });
});

describe('requireApiUser', () => {
  it('未登录抛 UnauthorizedError', async () => {
    currentUser.mockResolvedValue(null);
    expect(await rejection(requireApiUser)).toBeInstanceOf(UnauthorizedError);
  });

  it('未登录的状态码是 401', async () => {
    currentUser.mockResolvedValue(null);
    expect(await rejection(requireApiUser)).toMatchObject({ status: 401 });
  });

  it('已登录时返回当前用户', async () => {
    currentUser.mockResolvedValue(ANNOTATOR);
    expect((await requireApiUser()).id).toBe(ANNOTATOR.id);
  });

  it('不触发页面重定向（API 不返回 HTML 跳转）', async () => {
    currentUser.mockResolvedValue(null);
    await rejection(requireApiUser);
    expect(mockedRedirect).not.toHaveBeenCalled();
  });
});

describe('requireApiAdmin', () => {
  it('标注员访问抛 ForbiddenError', async () => {
    currentUser.mockResolvedValue(ANNOTATOR);
    expect(await rejection(requireApiAdmin)).toBeInstanceOf(ForbiddenError);
  });

  it('标注员访问的状态码是 403', async () => {
    currentUser.mockResolvedValue(ANNOTATOR);
    expect(await rejection(requireApiAdmin)).toMatchObject({ status: 403 });
  });

  it('标注员不被当成未登录', async () => {
    currentUser.mockResolvedValue(ANNOTATOR);
    expect(await rejection(requireApiAdmin)).not.toBeInstanceOf(UnauthorizedError);
  });

  it('未登录抛 UnauthorizedError 而不是 ForbiddenError', async () => {
    currentUser.mockResolvedValue(null);
    expect(await rejection(requireApiAdmin)).toMatchObject({ name: 'UnauthorizedError', status: 401 });
  });

  it('管理员访问时返回当前用户', async () => {
    currentUser.mockResolvedValue(ADMIN);
    expect((await requireApiAdmin()).id).toBe(ADMIN.id);
  });

  it('不触发页面重定向（API 不返回 HTML 跳转）', async () => {
    currentUser.mockResolvedValue(ADMIN);
    await requireApiAdmin();
    expect(mockedRedirect).not.toHaveBeenCalled();
  });
});

describe('isTenantUser', () => {
  it('标注员返回 true', () => {
    expect(isTenantUser(ANNOTATOR)).toBe(true);
  });

  it('管理员返回 false', () => {
    expect(isTenantUser(ADMIN)).toBe(false);
  });

  it('role 为 annotator 但 tenantId 为 null 的畸形身份返回 false', () => {
    expect(isTenantUser({ ...ANNOTATOR, tenantId: null })).toBe(false);
  });

  it('窄化后 tenantId 的类型即为 string', () => {
    // 编译期即验证：守卫若退化成返回 boolean，下面这行会因 string | null 不可赋给 string 报错
    const tenantId: string = isTenantUser(ANNOTATOR) ? ANNOTATOR.tenantId : '';
    expect(tenantId).toBe(ANNOTATOR.tenantId);
  });

  it('role 为 annotator 但 tenantId 为空串的脏数据返回 false', () => {
    // 空串不是「没有租户」而是脏数据：放过去会让 WHERE tenant_id = '' 静默返空集，
    // 比 null 更难发现——null 至少会在判空处暴露
    expect(isTenantUser({ ...ANNOTATOR, tenantId: '' })).toBe(false);
  });
});

describe('重定向的真实行为', () => {
  it('真实 redirect 通过抛异常中断执行，不依赖 mock', async () => {
    // 本文件的 redirect 被 mock 成「必抛」。若 Next 改成返回而非抛错，mock 会掩盖这个变化。
    // 这里绕过 mock 直接调真实实现，确认中断语义仍然成立。
    const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation');
    expect(() => actual.redirect('/login')).toThrow();
  });
});
