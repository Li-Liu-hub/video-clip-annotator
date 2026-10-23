/**
 * 当前请求的登录用户。薄适配：读 cookie → 调 authService → 返回。
 *
 * 这一层允许 next/headers 与 getDb，但只做请求上下文适配，
 * 不含任何业务判断 —— 判定逻辑留在 authService，才可单测。
 */
import { cookies } from 'next/headers';
import { getDb } from '@/lib/db';
import { resolveSession, SESSION_COOKIE, type SessionUser } from '@/lib/services/auth-service';

/** 当前请求的登录用户。只读 cookie 并转调 authService，不含任何业务判断。 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const sessionId = store.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;
  return resolveSession(getDb(), sessionId);
}
