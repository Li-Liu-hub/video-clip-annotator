/**
 * 片段区间的校验与规范化。
 *
 * 标注员标出「机器人真正在动」的时段，每个片段是左闭右开的 [startMs, endMs)。
 * 写进库前必须保证：在视频范围内、不为空、互不重叠 —— 否则账本会算出
 * 比视频本身还长的工作量。
 *
 * 纯函数零依赖：不碰数据库、不读时钟、不改入参，可在内存里直接测。
 */

import { MIN_SEGMENT_MS, overlaps } from '@/lib/interval';

export type Segment = { startMs: number; endMs: number };

/**
 * 最短片段与重叠判定的唯一真值源在 `lib/interval.ts`（A4 就定义了，
 * 且与 `SNAP_STEP_MS` 保持一致）。这里只为调用方便而 re-export，
 * 不再各自定义一份 —— 曾经两处分别写 100 与 200，E4 落地时随手选一个就会错。
 */
export { MIN_SEGMENT_MS };

/** 单次提交的片段数上限，防滥用。interval.ts 不涉及数量，故定义在此。 */
export const MAX_SEGMENTS = 100;

export type SegmentIssue =
  | { code: 'empty' }
  | { code: 'too-many'; count: number }
  /** durationMs 本身非法：非有限值或 <= 0。此时「是否在视频范围内」无定义。 */
  | { code: 'invalid-duration' }
  | { code: 'not-finite'; index: number }
  /** 毫秒必须是整数：小数会原样落进 INTEGER 列，SQLite 实际存成 REAL。 */
  | { code: 'not-integer'; index: number }
  | { code: 'negative'; index: number }
  | { code: 'reversed'; index: number }
  | { code: 'out-of-range'; index: number }
  | { code: 'too-short'; index: number }
  | { code: 'overlap'; index: number; previousIndex: number };

export type NormalizeResult =
  | { ok: true; segments: Segment[]; totalMs: number }
  | { ok: false; issue: SegmentIssue };

/**
 * 校验并规范化片段列表。
 *
 * 校验顺序是契约的一部分：
 *   空 → 超量 → 逐项（finite/negative/reversed/range/length）→ 排序 → 查重叠
 *
 * 逐项先于排序，是因为 NaN 参与比较恒为 false，排序会把它丢到不可预期的位置，
 * 之后再判就得不出稳定的错误位置。
 *
 * 返回的 index 一律是**入参数组的下标**，不是排序后的位置 ——
 * 标注员要据此回去改第 n 段，报错位置必须是他在界面上看到的那个顺序。
 */
export function normalizeSegments(
  raw: readonly Segment[],
  durationMs: number,
): NormalizeResult {
  // 时长本身非法时，「在视频范围内」这句话无定义。
  // 不先拦掉，`endMs > NaN` 恒为 false，逐项范围检查会全部静默通过。
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { ok: false, issue: { code: 'invalid-duration' } };
  }

  if (raw.length === 0) return { ok: false, issue: { code: 'empty' } };
  if (raw.length > MAX_SEGMENTS) {
    return { ok: false, issue: { code: 'too-many', count: raw.length } };
  }

  for (let i = 0; i < raw.length; i++) {
    const { startMs, endMs } = raw[i];
    // NaN 与 ±Infinity 会让后续所有比较失去意义，必须先拦
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return { ok: false, issue: { code: 'not-finite', index: i } };
    }
    // 小数毫秒会原样进 INTEGER 列并被 SQLite 存成 REAL，账本从此出现非整数毫秒
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) {
      return { ok: false, issue: { code: 'not-integer', index: i } };
    }
    if (startMs < 0) return { ok: false, issue: { code: 'negative', index: i } };
    // 零长度也归入 reversed：起点不早于终点，没有可计的时长
    if (startMs >= endMs) return { ok: false, issue: { code: 'reversed', index: i } };
    if (endMs > durationMs) return { ok: false, issue: { code: 'out-of-range', index: i } };
    if (endMs - startMs < MIN_SEGMENT_MS) {
      return { ok: false, issue: { code: 'too-short', index: i } };
    }
  }

  // 记下原始下标：排序会打乱顺序，但报错必须指向入参位置
  const indexed = raw.map((segment, index) => ({ segment, index }));
  indexed.sort((a, b) => a.segment.startMs - b.segment.startMs);

  for (let k = 1; k < indexed.length; k++) {
    const previous = indexed[k - 1];
    const current = indexed[k];
    // 重叠判定复用 interval.ts 的唯一实现，避免「应用层预检」与
    // 「schema 触发器 / UI 拖拽冲突提示」出现两套结论
    if (overlaps(previous.segment, current.segment)) {
      return {
        ok: false,
        issue: { code: 'overlap', index: current.index, previousIndex: previous.index },
      };
    }
  }

  // 返回新对象：调用方修改返回值时不能污染自己传进来的数组
  const segments = indexed.map(({ segment }) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
  }));

  // 不做 Math.round：毫秒本就该是整数，出现小数说明调用方传错了，静默修正只会把问题推到账本里
  const totalMs = segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);

  return { ok: true, segments, totalMs };
}
