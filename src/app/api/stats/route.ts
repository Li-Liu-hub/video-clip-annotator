/**
 * 统计查询接口（GET /api/stats，管理员与标注员皆可）。
 *
 * 只做请求上下文与 HTTP 契约：取身份、把查询串收成 service 的输入。
 * 维度合法性、日期格式与可见范围都在 stats-service —— 写在这里就无人单测。
 */
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { requireApiUser } from '@/lib/server/api-guard';
import { getDb } from '@/lib/server/db';
import { listStats, type StatsDimension } from '@/lib/services/stats-service';

// service 直接写 SQLite（better-sqlite3），Edge runtime 没有这个模块
export const runtime = 'nodejs';

/** 缺失的参数给空串，让 service 的校验统一报「格式不对」，路由不做第二套判断。 */
function readQuery(request: Request): { dimension: string; from: string; to: string } {
  const { searchParams } = new URL(request.url);
  return {
    dimension: searchParams.get('dim') ?? '',
    from: searchParams.get('from') ?? '',
    to: searchParams.get('to') ?? '',
  };
}

export async function GET(request: Request) {
  try {
    const actor = await requireApiUser();
    const { dimension, from, to } = readQuery(request);
    // 断言只在这里发生一次：串值到 service 立刻被 isStatsDimension 收窄，非法值抛 400
    const result = listStats(getDb(), actor, { dimension: dimension as StatsDimension, from, to });
    return NextResponse.json({ ok: true, dimension: result.dimension, rows: result.rows });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
