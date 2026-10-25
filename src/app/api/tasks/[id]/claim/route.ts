/**
 * 领取任务（POST /api/tasks/:id/claim，仅标注员）。
 *
 * 只做请求上下文与 HTTP 契约：取身份、取路径参数、调 service。
 * 404 / 409 的判定与文案都在 task-service —— 写在这里就无人单测。
 */
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { requireApiAnnotator } from '@/lib/server/api-guard';
import { requireSameOrigin } from '@/lib/server/require-same-origin';
import { getDb } from '@/lib/server/db';
import { claimTask } from '@/lib/services/task-service';

// service 直接写 SQLite（better-sqlite3），Edge runtime 没有这个模块
export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiAnnotator();
    requireSameOrigin(request);
    const { id } = await context.params;

    const task = claimTask(getDb(), actor, id);
    // 契约只回三格：调用方拿状态与归属做按钮判定，其余字段由列表查询提供
    return NextResponse.json({
      ok: true,
      task: { id: task.id, status: task.status, claimedBy: task.claimed_by },
    });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
