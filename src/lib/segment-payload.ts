/**
 * 片段接口响应体的解析：单个片段、片段列表、错误文案。
 *
 * 提交（POST）读单个片段、撤销后重拉（GET）读列表、两处的失败都要翻成人话。
 * 三份解析若各写一遍，契约加字段时只会改到其中一处，另一处静默丢数据。
 */
import type { HistoryInterval } from '@/lib/history';
import type { SegmentRow } from '@/lib/services/segment-service';

export const GENERIC_SAVE_FAILED = '保存失败，请检查网络后重试';

/**
 * 写片段的请求体。label 是**必填**的：撤销回放必须把历史里的标签带回去，
 * 少传一次就是「时间对、标签没了」—— 让它在编译期报错，而不是等浏览器里发现。
 *
 * replaces 为 null 表示纯新增；拖动替换走另一个入口（省略 label，由服务端继承旧值）。
 */
export type UpsertPayload = {
  startMs: number;
  endMs: number;
  replaces: string | null;
  label: string | null;
};

export function upsertPayloadOf(
  interval: HistoryInterval,
  replaces: string | null = null,
): UpsertPayload {
  return {
    startMs: interval.startMs,
    endMs: interval.endMs,
    replaces,
    label: interval.label,
  };
}

/** 只认契约里的四个字段；服务端多给的字段一律不带进本地状态。 */
export function readSegment(payload: unknown): SegmentRow | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { segment } = payload as Record<string, unknown>;
  if (typeof segment !== 'object' || segment === null) return null;

  const row = segment as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.startMs !== 'number' || typeof row.endMs !== 'number') {
    return null;
  }
  return {
    id: row.id,
    startMs: row.startMs,
    endMs: row.endMs,
    label: typeof row.label === 'string' ? row.label : null,
  };
}

/**
 * 列表契约是 `{ segments: [...] }`。
 *
 * 有一项不合契约就整批拒收：只接一半的话，本地数组会缺几段，
 * 而 UI 显示的是「这几段不存在」——比保持旧数组更误导。
 */
export function readSegmentList(payload: unknown): SegmentRow[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { segments } = payload as Record<string, unknown>;
  if (!Array.isArray(segments)) return null;

  const rows: SegmentRow[] = [];
  for (const item of segments) {
    const row = readSegment({ segment: item });
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

/** 错误体是 { error: { message } }；解不出来就用通用文案，绝不把整段 JSON 显示给用户。 */
export function readErrorMessage(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return GENERIC_SAVE_FAILED;
  const { error } = payload as Record<string, unknown>;
  if (typeof error !== 'object' || error === null) return GENERIC_SAVE_FAILED;
  const { message } = error as Record<string, unknown>;
  return typeof message === 'string' && message.length > 0 ? message : GENERIC_SAVE_FAILED;
}
