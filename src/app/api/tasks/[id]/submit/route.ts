/**
 * 提交任务（POST /api/tasks/:id/submit，仅标注员）。
 *
 * 只做请求上下文与 HTTP 契约：取身份、取路径参数、调 service。
 * 四写入的事务边界与 404 / 409 的判定都在 submit-service —— 写在这里就无人单测。
 */
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { requireApiAnnotator } from '@/lib/server/api-guard';
import { requireSameOrigin } from '@/lib/server/require-same-origin';
import { getDb } from '@/lib/server/db';
import { submitTask } from '@/lib/services/submit-service';

// service 直接写 SQLite（better-sqlite3），Edge runtime 没有这个模块
export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiAnnotator();
    requireSameOrigin(request);
    const { id } = await context.params;
    return NextResponse.json({ ok: true, submission: submitTask(getDb(), actor, id) });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
