/**
 * O4 安全响应头：配置本身也要有测试守着。
 *
 * 这一项最容易被「后来加一条 header 时顺手改坏」：next.config 不是业务代码，
 * 没有类型能表达「必须封住 iframe」。用例直接调用 headers()，把四条值与作用范围钉住。
 */
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('安全响应头（O4）', () => {
  it('对全部路径生效，不是只给某一组路由', async () => {
    const rules = await nextConfig.headers?.();
    expect(rules).toHaveLength(1);
    expect(rules?.[0].source).toBe('/:path*');
  });

  it('封住 iframe 嵌套：CSP frame-ancestors 与 X-Frame-Options 同时给', async () => {
    const rules = await nextConfig.headers?.();
    const headers = new Map((rules?.[0].headers ?? []).map((h) => [h.key, h.value]));

    expect(headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('禁止 MIME 嗅探与跨站 Referer', async () => {
    const rules = await nextConfig.headers?.();
    const headers = new Map((rules?.[0].headers ?? []).map((h) => [h.key, h.value]));

    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('same-origin');
  });
});
