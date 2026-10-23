/**
 * 登录与登出。
 *
 * 凭据校验与会话签发都走 auth-service；本文件只负责 HTTP 契约：
 * 解析请求体、写 / 删 cookie。状态码与文案由 errors.ts 统一决定，
 * 不在 handler 里另拼一份 401。
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getDb } from '@/lib/server/db';
import { ValidationError, toErrorResponse } from '@/lib/errors';
import {
  authenticate,
  createSession,
  destroySession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '@/lib/services/auth-service';

const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

type Credentials = { username: string; password: string };

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

/** 前端 LoginForm 只读 `error` 字符串字段，响应体保持这一形状，内容取统一错误映射。 */
function errorResponse(err: unknown): NextResponse {
  const { status, body } = toErrorResponse(err);
  return NextResponse.json({ error: body.error.message }, { status });
}

export async function POST(request: Request) {
  try {
    const { username, password } = await readCredentials(request);

    const db = getDb();
    const user = authenticate(db, username, password);
    const sessionId = createSession(db, user.id);

    const response = NextResponse.json({ ok: true, role: user.role });
    response.cookies.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
      secure: process.env.NODE_ENV === 'production',
    });
    return response;
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  const store = await cookies();
  const sessionId = store.get(SESSION_COOKIE)?.value;
  if (sessionId) {
    destroySession(getDb(), sessionId);
    store.delete(SESSION_COOKIE);
  }
  return NextResponse.json({ ok: true });
}
