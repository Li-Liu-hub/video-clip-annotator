/**
 * 重新打开被退回的任务（POST /api/tasks/:id/reopen，仅标注员本人）。
 *
 * 只做请求上下文与 HTTP 契约：归属、状态、事务边界都在 review-service。
 * 没有请求体 —— 要改什么由标注员进工作台改，这一步只是把状态从 rejected 拨回 claimed。
 */
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { requireApiAnnotator } from '@/lib/server/api-guard';
import { getDb } from '@/lib/server/db';
import { reopenTask } from '@/lib/services/review-service';

// service 直接写 SQLite（better-sqlite3），Edge runtime 没有这个模块
export const runtime = 'nodejs';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiAnnotator();
    const { id } = await context.params;
    reopenTask(getDb(), actor, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
