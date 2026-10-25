/**
 * 写接口同源校验的四条规则。
 *
 * 每条都直接构造 Request 而不是起 HTTP 服务：判定的输入只有三个头（Origin / Referer / Host）
 * 与请求 URL，中间加一层路由只会让用例依赖 Next 行为，测不到这条规则本身。
 *
 * 「放行」用 not.toThrow 断言，「拒绝」用 toThrow(ForbiddenError) ——
 * 只断言「抛了」的话，把它改成 401 或 500 也不会有任何用例变红。
 */
import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '@/lib/errors';
import { requireSameOrigin } from '@/lib/server/require-same-origin';

const URL_UNDER_TEST = 'http://localhost:3000/api/tasks';

function requestWith(headers: Record<string, string>): Request {
  return new Request(URL_UNDER_TEST, { method: 'POST', headers });
}

describe('有 Origin 时按 Origin 判定', () => {
  it('同源 Origin 放行', () => {
    expect(() => requireSameOrigin(requestWith({ origin: 'http://localhost:3000' }))).not.toThrow();
  });

  it('跨源 Origin 抛 ForbiddenError', () => {
    expect(() => requireSameOrigin(requestWith({ origin: 'http://evil.example' }))).toThrow(ForbiddenError);
  });

  it('同主机不同端口视为跨源', () => {
    // SameSite 忽略端口，正是这条校验要补的缺口
    expect(() => requireSameOrigin(requestWith({ origin: 'http://localhost:8080' }))).toThrow(
      ForbiddenError,
    );
  });

  it('协议不同视为跨源', () => {
    expect(() => requireSameOrigin(requestWith({ origin: 'https://localhost:3000' }))).toThrow(
      ForbiddenError,
    );
  });

  it('Origin 为 null（沙箱 iframe / file://）按跨源拒绝', () => {
    expect(() => requireSameOrigin(requestWith({ origin: 'null' }))).toThrow(ForbiddenError);
  });

  it('有 Origin 时不再参考 Referer', () => {
    // 攻击页面能控制 Referer（可被 referrer-policy 降级），但控制不了 Origin：
    // 若这里回落到 Referer，就等于给伪造留下了余地
    expect(() =>
      requireSameOrigin(
        requestWith({ origin: 'http://evil.example', referer: 'http://localhost:3000/tasks' }),
      ),
    ).toThrow(ForbiddenError);
  });
});

describe('无 Origin 时按 Referer 判定', () => {
  it('同源 Referer 放行', () => {
    expect(() =>
      requireSameOrigin(requestWith({ referer: 'http://localhost:3000/tasks?page=2' })),
    ).not.toThrow();
  });

  it('跨源 Referer 抛 ForbiddenError', () => {
    expect(() =>
      requireSameOrigin(requestWith({ referer: 'http://evil.example/attack.html' })),
    ).toThrow(ForbiddenError);
  });

  it('Referer 无法解析时按跨源拒绝', () => {
    expect(() => requireSameOrigin(requestWith({ referer: 'not a url' }))).toThrow(ForbiddenError);
  });
});

describe('两个头都没有时放行', () => {
  it('不抛错（老浏览器与部分代理不发 Origin）', () => {
    expect(() => requireSameOrigin(requestWith({}))).not.toThrow();
  });
});

describe('代理终结 TLS 的情形', () => {
  it('x-forwarded-proto 为 https 时接受 https 的 Origin', () => {
    // 应用看到的是 http，浏览器发出的是 https：不看这个头会把正常写入全判成跨源
    expect(() =>
      requireSameOrigin(
        requestWith({ origin: 'https://example.com', host: 'example.com', 'x-forwarded-proto': 'https' }),
      ),
    ).not.toThrow();
  });

  it('x-forwarded-proto 与 Origin 协议不符时仍拒绝', () => {
    expect(() =>
      requireSameOrigin(
        requestWith({ origin: 'http://example.com', host: 'example.com', 'x-forwarded-proto': 'https' }),
      ),
    ).toThrow(ForbiddenError);
  });
});
