import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getDb } from '@/lib/db';
import { createSession, SESSION_COOKIE, verifyPassword, type Role } from '@/lib/auth';

type Row = { id: string; password_hash: string; role: Role };

export async function POST(request: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const username = (body.username ?? '').trim();
  const password = body.password ?? '';

  if (!username || !password) {
    return NextResponse.json({ error: '请填写用户名和密码' }, { status: 400 });
  }

  const row = getDb()
    .prepare('SELECT id, password_hash, role FROM users WHERE username = ?')
    .get(username) as Row | undefined;

  // 用户不存在与密码错误返回同一句话，避免枚举用户名
  if (!row || !verifyPassword(password, row.password_hash)) {
    return NextResponse.json({ error: '用户名或密码不正确' }, { status: 401 });
  }

  const sessionId = createSession(row.id);
  const response = NextResponse.json({ ok: true, role: row.role });

  response.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
    secure: process.env.NODE_ENV === 'production',
  });

  return response;
}

export async function DELETE() {
  const store = await cookies();
  const sid = store.get(SESSION_COOKIE)?.value;
  if (sid) {
    const { destroySession } = await import('@/lib/auth');
    destroySession(sid);
    store.delete(SESSION_COOKIE);
  }
  return NextResponse.json({ ok: true });
}
