/**
 * 改密接口：POST /api/auth/password。
 *
 * 只负责 HTTP 契约：取会话身份、解析请求体、采集审计上下文。
 * 长度、同口令、旧口令校验、销毁其他会话、审计全在 auth-service —— 那些是业务规则，
 * 写在 handler 里就只能靠人眼验收（handler 不可单测）。
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getDb } from '@/lib/server/db';
import { requireApiUser } from '@/lib/server/api-guard';
import { requireSameOrigin } from '@/lib/server/require-same-origin';
import { ValidationError, toErrorResponse } from '@/lib/errors';
import { changePassword, SESSION_COOKIE, type PasswordChangeInput } from '@/lib/services/auth-service';

type AuditContext = { ip: string | null; userAgent: string | null };

/** 请求体形状在这里定死；字段用 unknown 判定，避免把 any 传进 service。口令不 trim。 */
async function readInput(request: Request): Promise<PasswordChangeInput> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('请求格式错误');
  }
  if (typeof raw !== 'object' || raw === null) throw new ValidationError('请求格式错误');

  const body = raw as { currentPassword?: unknown; newPassword?: unknown };
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!currentPassword || !newPassword) throw new ValidationError('请填写当前密码与新密码');
  return { currentPassword, newPassword };
}

/** x-forwarded-for 可被伪造，仅作审计参考，不参与任何安全判定。 */
function readContext(request: Request): AuditContext {
  const forwarded = request.headers.get('x-forwarded-for');
  return {
    ip: forwarded?.split(',')[0]?.trim() || null,
    userAgent: request.headers.get('user-agent'),
  };
}

export async function POST(request: Request) {
  const db = getDb();

  try {
    const user = await requireApiUser();
    requireSameOrigin(request);
    const input = await readInput(request);

    // 当前会话这条要留下：改完密码把自己踢回登录页是最容易被当成「改密失败」的行为
    const currentSessionId = (await cookies()).get(SESSION_COOKIE)?.value;
    await changePassword(db, user, input, readContext(request), currentSessionId);

    // 不回任何口令材料，也不回会话信息
    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
