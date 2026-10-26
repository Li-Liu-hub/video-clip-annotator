/**
 * 统计导出接口（GET /api/stats/export，管理员与标注员皆可）。
 *
 * 复用 stats-service 的查询，不另写 SQL：导出与页面各查一次，
 * 一次 schema 变更后两份数字就会分叉，而「导出和页面对不上」是最难查的一类问题。
 * 本文件只负责把统计结果摆成表格、转成 CSV 文本。
 */
import { NextResponse } from 'next/server';
import { toCsv } from '@/lib/csv';
import { toErrorResponse } from '@/lib/errors';
import { requireApiUser } from '@/lib/server/api-guard';
import { getDb } from '@/lib/server/db';
import { listStats, type StatsDimension, type StatsResult } from '@/lib/services/stats-service';

// service 直接写 SQLite（better-sqlite3），Edge runtime 没有这个模块
export const runtime = 'nodejs';

const MS_PER_SECOND = 1_000;

/** 缺少的参数给空串，格式判断统一交给 service。 */
function readQuery(request: Request): { dimension: string; from: string; to: string } {
  const { searchParams } = new URL(request.url);
  return {
    dimension: searchParams.get('dim') ?? '',
    from: searchParams.get('from') ?? '',
    to: searchParams.get('to') ?? '',
  };
}

/** 毫秒与秒两列都给：程序读毫秒不丢精度，人看秒有直觉。 */
function toSeconds(totalMs: number): number {
  // 只保留三位小数（毫秒精度），避免浮点除法带出 5.700000000000001 这类尾巴
  return Math.round(totalMs) / MS_PER_SECOND;
}

/**
 * 统计结果 → 表头与数据行。
 *
 * 列的含义属于导出格式，放在 HTTP 层；转义与 BOM 属于 CSV 语法，放在 lib/csv。
 */
function toTable(result: StatsResult): {
  headers: string[];
  rows: (string | number | null)[][];
} {
  switch (result.dimension) {
    case 'day':
      return {
        headers: ['日期', '总时长(毫秒)', '总时长(秒)', '条目数'],
        rows: result.rows.map((row) => [
          row.date,
          row.totalMs,
          toSeconds(row.totalMs),
          row.entryCount,
        ]),
      };
    case 'annotator':
      return {
        headers: ['标注员ID', '姓名', '提交日期', '任务ID', '任务', '有效片段数', '总时长(毫秒)', '总时长(秒)', '提交次数', '退回次数', '账本条目数'],
        rows: result.rows.map((row) => [
          row.annotatorId,
          row.displayName,
          row.date,
          row.taskId,
          row.title,
          row.segmentCount,
          row.totalMs,
          toSeconds(row.totalMs),
          row.submitCount,
          row.revokeCount,
          row.entryCount,
        ]),
      };
    case 'task':
      return {
        headers: ['任务ID', '标题', '总时长(毫秒)', '总时长(秒)', '提交次数', '退回次数'],
        rows: result.rows.map((row) => [
          row.taskId,
          row.title,
          row.totalMs,
          toSeconds(row.totalMs),
          row.submitCount,
          row.revokeCount,
        ]),
      };
  }
}

export async function GET(request: Request) {
  try {
    const actor = await requireApiUser();
    const { dimension, from, to } = readQuery(request);
    const result = listStats(getDb(), actor, { dimension: dimension as StatsDimension, from, to });
    const { headers, rows } = toTable(result);

    // 文件名只用 ASCII：中文文件名在部分浏览器/代理下会被截断或乱码
    const filename = `stats-${result.dimension}-${from}_${to}.csv`;
    return new NextResponse(toCsv(headers, rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
