/**
 * 登录与登出。
 *
 * 凭据校验、会话签发、登录审计都在 auth-service（失败也要在抛错前落审计，放在这里就晚了）；
 * 本文件只负责 HTTP 契约：解析请求体、写 / 删 cookie、采集审计上下文、按失败计数决定是否放行。
 * 状态码与错误码由 errors.ts 统一决定，不在 handler 里另拼一份。
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getDb } from '@/lib/server/db';
import { RateLimitedError, UnauthorizedError, ValidationError, toErrorResponse } from '@/lib/errors';
import { clearFailures, isLocked, noteFailure, throttleKey } from '@/lib/server/login-throttle';
import { AUTH_LOGOUT_ACTION } from '@/lib/audit-actions';
import {
  destroySession,
  loginWithFreshSession,
  resolveSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '@/lib/services/auth-service';
import { writeAudit, type AuditEntry } from '@/lib/services/audit-service';

const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/** 路由层不得 import @/lib/db，连接类型从适配层返回值推导 */
type Db = ReturnType<typeof getDb>;
type Credentials = { username: string; password: string };
type AuditContext = { ip: string | null; userAgent: string | null };

/** 请求体形状在这里定死；字段用 unknown 判定，避免把 any 传进 service。 */
async function readCredentials(request: Request): Promise<Credentials> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('请求格式错误');
  }
  if (typeof raw !== 'object' || raw === null) throw new ValidationError('请求格式错误');

  const body = raw as { username?: unknown; password?: unknown };
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) throw new ValidationError('请填写用户名和密码');
  return { username, password };
}

/**
 * x-forwarded-for 可被伪造：直接暴露时，改这个头就能换桶绕过限流。
 * 仍用它分桶：部署在反向代理之后时该头由代理覆盖；且它只决定「这次失败记到哪个桶」，
 * 不参与「能不能登录」的判定。
 */
function readContext(request: Request): AuditContext {
  const forwarded = request.headers.get('x-forwarded-for');
  return {
    ip: forwarded?.split(',')[0]?.trim() || null,
    userAgent: request.headers.get('user-agent'),
  };
}

/**
 * 审计是旁路：writeAudit 内部已兜底并记日志，这里再兜一层，
 * 让「登录结果不受审计实现影响」成为路由自身的保证，而不是依赖被调方恰好不抛。
 */
function audit(db: Db, entry: AuditEntry): void {
  try {
    writeAudit(db, entry);
  } catch {
    // 已在 audit-service 记过日志，此处不重复输出，也不改变主流程
  }
}

function errorResponse(err: unknown): NextResponse {
  const { status, body } = toErrorResponse(err);
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  const db = getDb();
  const { ip, userAgent } = readContext(request);
  // 记失败用的 key。请求体没解析出来时仍为 null —— 字段缺失是 400，不是「猜错口令」。
  let failureKey: string | null = null;

  try {
    const credentials = await readCredentials(request);

    // 先判锁再校验：被锁时连 scrypt 都不跑，拒绝必须是廉价的，否则 DoS 防线等于没做。
    // key 里带用户名，不按 IP 单独计数 —— 内网共用一个出口 IP 时，那会锁住整个办公室。
    failureKey = throttleKey(ip, credentials.username);
    if (isLocked(failureKey, Date.now())) throw new RateLimitedError();

    const staleSessionId = (await cookies()).get(SESSION_COOKIE)?.value;
    // 审计上下文一并交给 service：登录成功与三种失败的记录都在那里写，
    // 且失败记录必须先于抛错落库（顺序在 auth-service 内保证）
    const { user, sessionId } = await loginWithFreshSession(
      db,
      credentials.username,
      credentials.password,
      staleSessionId,
      { ip, userAgent },
    );
    // 成功即清零：此前错过几次不该让这个账号在窗口内更接近被锁
    clearFailures(failureKey);

    // 会话 id 只走 httpOnly cookie，不进响应体：否则 XSS 直接读得到
    const response = NextResponse.json({ ok: true, role: user.role });
    response.cookies.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      // cookie 的 maxAge 单位是秒，传毫秒等于永不过期
      maxAge: SESSION_TTL_SECONDS,
      secure: process.env.NODE_ENV === 'production',
    });
    return response;
  } catch (err) {
    // 只有「凭据不成立」计入失败：400（字段没填）与 429（已锁）都不是猜口令的证据
    if (failureKey !== null && err instanceof UnauthorizedError) {
      noteFailure(failureKey, Date.now());
    }
    return errorResponse(err);
  }
}

export async function DELETE(request: Request) {
  const db = getDb();
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value;

  // 幂等：没有 cookie、会话已不存在都返回 200。登出失败没有业务意义
  const response = NextResponse.json({ ok: true });
  if (!sessionId) return response;

  // 先解析身份再作废：删掉之后就无从知道是谁登出的，审计里只剩一个孤立 action
  const user = resolveSession(db, sessionId);
  destroySession(db, sessionId);
  if (user) {
    audit(db, {
      actorId: user.id,
      actorRole: user.role,
      tenantId: user.tenantId,
      action: AUTH_LOGOUT_ACTION,
      ...readContext(request),
    });
  }

  // 必须显式带 path：cookie 以 path=/ 写入，只按名字删只会清掉同名的其他路径
  response.cookies.delete({ name: SESSION_COOKIE, path: '/' });
  return response;
}
