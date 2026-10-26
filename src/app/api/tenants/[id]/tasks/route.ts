/** 发布任务页的空间任务明细：管理员鉴权后按租户分页读取。 */
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { requireApiAdmin } from '@/lib/server/api-guard';
import { getDb } from '@/lib/server/db';
import { listTenantTasks } from '@/lib/services/task-service';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiAdmin();
    const { id } = await context.params;
    const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
    return NextResponse.json({ ok: true, ...listTenantTasks(getDb(), actor, id, page) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
