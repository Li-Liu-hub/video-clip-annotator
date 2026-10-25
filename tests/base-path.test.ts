/**
 * 子路径前缀（withBasePath）的契约。
 *
 * 部署到 nginx 子路径时靠它给 fetch / <a> / redirect 补前缀；
 * 本地不设环境变量时必须退化为恒等，否则开发环境的 /api 全部 404。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  delete process.env.NEXT_PUBLIC_BASE_PATH;
});

describe('withBasePath', () => {
  it('未设置前缀时是恒等函数', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    const { withBasePath } = await import('@/lib/base-path');
    expect(withBasePath('/api/tasks')).toBe('/api/tasks');
  });

  it('设置后给绝对路径加前缀，相对路径不动', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_BASE_PATH = '/vsap';
    const { withBasePath } = await import('@/lib/base-path');
    expect(withBasePath('/api/tasks')).toBe('/vsap/api/tasks');
    expect(withBasePath('relative')).toBe('relative');
  });
});
