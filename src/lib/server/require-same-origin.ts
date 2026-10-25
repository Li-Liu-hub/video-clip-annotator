/**
 * 写接口的同源校验。
 *
 * SameSite=Lax 挡不住同主机不同端口的服务（内网常见：Wiki、Jenkins、老系统），
 * 也挡不住同父域子域。这些场景下浏览器会带上 cookie 发简单请求。
 *
 * 无 Origin 头时放行：老浏览器与部分代理不发送它，
 * 拒绝会让正常用户用不了 —— 代价是这条防线在那类客户端上不存在。
 * 这是明确的取舍，不是遗漏。
 */
import { ForbiddenError } from '@/lib/errors';

const CROSS_ORIGIN_MESSAGE = '请求来源与本站不一致';

/**
 * 本站的 origin（协议 + 主机 + 端口）。
 *
 * Host 取自请求头而不是 request.url：二者在 Next 下通常一致，
 * 但显式取头才与「浏览器看到的主机」对齐，代理改写 Host 时也仍然成立。
 *
 * 协议要看 x-forwarded-proto：TLS 常在反向代理上终结，此时应用收到的是 http，
 * 浏览器发出的 Origin 却是 https —— 只看 request.url 会把所有正常写入判成跨源。
 * 伪造这个头没有收益：攻击页面改得动它，改不动 Origin 与 Host。
 */
function originOf(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwarded ? `${forwarded}:` : url.protocol;
  // 交给 URL 归一：默认端口（https 的 443）两侧都按同一规则折叠，字符串拼接做不到
  return new URL(`${protocol}//${host}`).origin;
}

/** 解析失败（含 `Origin: null`、空串）一律按不同源处理：无效来源不该被放行。 */
function isSameOrigin(candidate: string, request: Request): boolean {
  try {
    return new URL(candidate).origin === originOf(request);
  } catch {
    return false;
  }
}

/**
 * 有 Origin 比 Origin；无 Origin 但有 Referer 比 Referer；两者都没有则放行。
 *
 * 放在 requireApiXxx 之后、业务之前：先认出是谁，再判这次请求能不能代表他动手。
 */
export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin !== null && !isSameOrigin(origin, request)) {
    throw new ForbiddenError(CROSS_ORIGIN_MESSAGE);
  }
  if (origin !== null) return;

  const referer = request.headers.get('referer');
  if (referer !== null && !isSameOrigin(referer, request)) {
    throw new ForbiddenError(CROSS_ORIGIN_MESSAGE);
  }
}
