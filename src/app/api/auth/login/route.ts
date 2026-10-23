/**
 * 登录与登出。
 *
 * 凭据校验、会话签发与作废都走 auth-service，审计走 audit-service；
 * 本文件只负责 HTTP 契约：解析请求体、写 / 删 cookie、取审计上下文。
 * 状态码与错误码由 errors.ts 统一决定，不在 handler 里另拼一份。
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getDb } from '@/lib/server/db';
import { UnauthorizedError, ValidationError, toErrorResponse } from '@/lib/errors';
import {
  destroySession,
  loginWithFreshSession,
  resolveSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '@/lib/services/auth-service';
import { writeAudit, type AuditEntry } from '@/lib/services/audit-service';

const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
const CREDENTIAL_FAILURE = 'bad_credentials';

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

/** x-forwarded-for 可被伪造，仅作审计参考，不参与任何安全判定。 */
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
  // 失败审计要能追溯「谁在试」，凭据校验一过就拿不到原始输入了
  let username = '';

  try {
    const credentials = await readCredentials(request);
    username = credentials.username;

    const staleSessionId = (await cookies()).get(SESSION_COOKIE)?.value;
    const { user, sessionId } = loginWithFreshSession(
      db,
      credentials.username,
      credentials.password,
      staleSessionId,
    );

    audit(db, {
      actorId: user.id,
      actorRole: user.role,
      tenantId: user.tenantId,
      action: 'auth.login',
      detail: { username: user.username },
      ip,
      userAgent,
    });

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
    // 只有「凭据不正确」算登录失败事件；参数缺失是请求拼错了，不是认证尝试
    if (err instanceof UnauthorizedError) {
      audit(db, {
        actorId: null, // 未通过认证，没有身份；追溯只能靠 detail.username
        actorRole: null,
        tenantId: null,
        action: 'auth.login_failed',
        detail: { username, reason: CREDENTIAL_FAILURE },
        ip,
        userAgent,
      });
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
      action: 'auth.logout',
      ...readContext(request),
    });
  }

  // 必须显式带 path：cookie 以 path=/ 写入，只按名字删只会清掉同名的其他路径
  response.cookies.delete({ name: SESSION_COOKIE, path: '/' });
  return response;
}
