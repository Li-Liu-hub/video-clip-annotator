/**
 * 归还任务（POST /api/tasks/:id/release，仅标注员）。
 *
 * 只做请求上下文与 HTTP 契约：取身份、取路径参数、调 service。
 * 「不是自己领取的」「状态已不是 claimed」都由 service 转成 409，路由层不重复判断。
 */
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { requireApiAnnotator } from '@/lib/server/api-guard';
import { getDb } from '@/lib/server/db';
import { releaseTask } from '@/lib/services/task-service';

// service 直接写 SQLite（better-sqlite3），Edge runtime 没有这个模块
export const runtime = 'nodejs';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiAnnotator();
    const { id } = await context.params;

    releaseTask(getDb(), actor, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
