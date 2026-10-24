/**
 * 删除片段（DELETE /api/tasks/:id/segments/:segmentId，仅标注员）。
 *
 * 归属于本任务与否、状态是否可改，全在 segment-service 判定；
 * 本文件只把路径参数交给 service。
 */
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { requireApiAnnotator } from '@/lib/server/api-guard';
import { getDb } from '@/lib/server/db';
import { deleteSegment } from '@/lib/services/segment-service';

// service 直接写 SQLite（better-sqlite3），Edge runtime 没有这个模块
export const runtime = 'nodejs';

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; segmentId: string }> },
) {
  try {
    const actor = await requireApiAnnotator();
    const { id, segmentId } = await context.params;
    deleteSegment(getDb(), actor, id, segmentId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
