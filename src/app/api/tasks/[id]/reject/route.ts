/**
 * 退回任务（POST /api/tasks/:id/reject，仅管理员）。
 *
 * 只做请求上下文与 HTTP 契约：取身份、把请求体解析成 service 的输入。
 * 校验规则与「状态 + 冲正 + 审计」的事务边界都在 review-service —— 写在这里就无人单测。
 */
import { NextResponse } from 'next/server';
import { ValidationError, toErrorResponse } from '@/lib/errors';
import { requireApiAdmin } from '@/lib/server/api-guard';
import { requireSameOrigin } from '@/lib/server/require-same-origin';
import { getDb } from '@/lib/server/db';
import { rejectTask } from '@/lib/services/review-service';

// service 直接写 SQLite（better-sqlite3），Edge runtime 没有这个模块
export const runtime = 'nodejs';

const INVALID_BODY_MESSAGE = '请求参数不合法';

/** JSON 解析失败由语法错误变成 400：请求体坏掉是客户端问题，不是 500。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new ValidationError('请求体不是合法的 JSON');
  }
}

/** 审核页携带已看的提交版本，旧列表仍可只传原因。 */
function readInput(payload: unknown): { reason: string; submissionId?: string } {
  if (typeof payload !== 'object' || payload === null) {
    throw new ValidationError(INVALID_BODY_MESSAGE);
  }
  const { reason, submissionId } = payload as Record<string, unknown>;
  // 空串留给 service 判：那里是「退回原因」唯一知道该多长的层
  if (typeof reason !== 'string') throw new ValidationError(INVALID_BODY_MESSAGE);
  if (submissionId !== undefined && typeof submissionId !== 'string') throw new ValidationError(INVALID_BODY_MESSAGE);
  return { reason, submissionId };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiAdmin();
    requireSameOrigin(request);
    const { id } = await context.params;
    const input = readInput(await readJson(request));
    rejectTask(getDb(), actor, id, input.reason, input.submissionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
