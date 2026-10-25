/**
 * 片段列表与新增/替换（GET / POST /api/tasks/:id/segments，仅标注员）。
 *
 * 只做请求上下文与 HTTP 契约：取身份、把请求体解析成 service 的输入。
 * 归属校验、区间预检与事务边界都在 segment-service —— 写在这里就无人单测。
 */
import { NextResponse } from 'next/server';
import { ValidationError, toErrorResponse } from '@/lib/errors';
import { requireApiAnnotator } from '@/lib/server/api-guard';
import { requireSameOrigin } from '@/lib/server/require-same-origin';
import { getDb } from '@/lib/server/db';
import { listSegments, upsertSegment } from '@/lib/services/segment-service';

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

type UpsertBody = {
  startMs: number;
  endMs: number;
  replaces: string | null;
  /** 缺省 = 不指定（替换时继承）；null = 显式清空。类型收窄在路由，长度校验在 service。 */
  label?: string | null;
};

/** 只取允许的字段；其余一律忽略，避免调用方以为它们能生效。 */
function readUpsertBody(payload: unknown): UpsertBody {
  if (typeof payload !== 'object' || payload === null) {
    throw new ValidationError(INVALID_BODY_MESSAGE);
  }
  const { startMs, endMs, replaces, label } = payload as Record<string, unknown>;
  // 类型先收窄：非数字（含字符串 "1200"）在这里就拒，不留给 service 去猜
  if (typeof startMs !== 'number' || typeof endMs !== 'number') {
    throw new ValidationError(INVALID_BODY_MESSAGE);
  }
  if (replaces !== undefined && replaces !== null && typeof replaces !== 'string') {
    throw new ValidationError(INVALID_BODY_MESSAGE);
  }
  // label 允许「没这个键」（继承旧值），但不允许数字/对象这类会让 service 猜的类型
  if (label !== undefined && label !== null && typeof label !== 'string') {
    throw new ValidationError(INVALID_BODY_MESSAGE);
  }
  const body: UpsertBody = { startMs, endMs, replaces: replaces ?? null };
  // 只有请求里真的带了 label 才写进 body：区分「没提」与「显式 null」是继承/清空的分界
  if (label !== undefined) body.label = label;
  return body;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiAnnotator();
    const { id } = await context.params;
    return NextResponse.json({ ok: true, segments: listSegments(getDb(), actor, id) });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiAnnotator();
    requireSameOrigin(request);
    const { id } = await context.params;
    const body = readUpsertBody(await readJson(request));
    return NextResponse.json({ ok: true, segment: upsertSegment(getDb(), actor, id, body) });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
