/**
 * 建任务接口（POST /api/tasks，仅管理员）。
 *
 * 只做请求上下文与 HTTP 契约：取身份、把请求体解析成 service 的输入。
 * 校验规则与事务都在 task-service —— 写在这里就无人单测。
 */
import { NextResponse } from 'next/server';
import { ValidationError, toErrorResponse } from '@/lib/errors';
import { requireApiAdmin } from '@/lib/server/api-guard';
import { getDb } from '@/lib/server/db';
import { createTasks, type CreateTasksInput } from '@/lib/services/task-service';

// service 直接写 SQLite（better-sqlite3），Edge runtime 没有这个模块
export const runtime = 'nodejs';

const INVALID_BODY_MESSAGE = '请求参数不合法';

function readTenantIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ValidationError(INVALID_BODY_MESSAGE);

  // 逐项取字符串而不是整体断言：断言只是换个地方相信外部输入
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new ValidationError(INVALID_BODY_MESSAGE);
    ids.push(item);
  }
  return ids;
}

function parseCreateInput(payload: unknown): CreateTasksInput {
  if (typeof payload !== 'object' || payload === null) {
    throw new ValidationError(INVALID_BODY_MESSAGE);
  }

  const { videoId, tenantIds, title, description } = payload as Record<string, unknown>;
  if (typeof videoId !== 'string' || typeof title !== 'string') {
    throw new ValidationError(INVALID_BODY_MESSAGE);
  }
  // 缺省与显式 null 都按「没填描述」处理，但类型必须是字符串才收
  if (description !== undefined && description !== null && typeof description !== 'string') {
    throw new ValidationError(INVALID_BODY_MESSAGE);
  }

  return {
    videoId,
    tenantIds: readTenantIds(tenantIds),
    title,
    description: typeof description === 'string' ? description : undefined,
  };
}

/** JSON 解析失败由语法错误变成 400：请求体坏掉是客户端问题，不是 500。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new ValidationError('请求体不是合法的 JSON');
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireApiAdmin();
    const input = parseCreateInput(await readJson(request));
    const { ids } = createTasks(getDb(), actor, input);
    return NextResponse.json({ ok: true, ids });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
