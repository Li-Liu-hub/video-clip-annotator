/**
 * 拖拽草案的区间计算：吸附、钳制，以及创建 / 平移 / 调整端点三种模式的草案生成与合格判定。
 *
 * 纯函数零依赖：不读 DOM、不读时钟、不改入参。事件处理只负责把像素换算成毫秒，
 * 判定逻辑全部下沉到这里 —— 拖拽是全项目最容易错的一块（吸附累积误差、平移触边被切短、
 * resize 拖成零长），放在组件里就没有任何自动化手段能验。
 */

import { MIN_SEGMENT_MS, SNAP_STEP_MS, clamp, overlaps, snapTo } from '@/lib/interval';
import type { Segment } from '@/lib/segment-interval';

/** 拖拽位移小于这个像素数时视为点击，不进入拖拽。 */
export const DRAG_THRESHOLD_PX = 3;

/** 色块左右边缘用于调整边界的热区宽度（像素）。 */
export const EDGE_HIT_PX = 6;

/** 吸附到 SNAP_STEP_MS 的整数倍。步长真值源在 interval.ts，这里不再写第二份 100。 */
export function snapMs(ms: number): number {
  return snapTo(ms, SNAP_STEP_MS);
}

/** 钳制到 [min, max]。 */
export function clampMs(ms: number, min: number, max: number): number {
  return clamp(ms, min, max);
}

/**
 * 创建：从锚点拖到当前点。
 *
 * 先吸附再钳制，顺序不能反：钳制后的值可能不是 SNAP_STEP_MS 的整数倍（素材时长未必是
 * 100 的倍数），先钳后吸会让末端永远差一格。反向拖拽（从右往左框选）归一成 start <= end。
 */
export function draftFromDrag(
  anchorMs: number,
  currentMs: number,
  durationMs: number,
): Segment {
  const anchor = clampMs(snapMs(anchorMs), 0, durationMs);
  const current = clampMs(snapMs(currentMs), 0, durationMs);
  return anchor <= current
    ? { startMs: anchor, endMs: current }
    : { startMs: current, endMs: anchor };
}

/**
 * 平移：整体移动 deltaMs，长度不变。
 *
 * 吸附作用在绝对位置上（origin.startMs + deltaMs），不是吸附增量：
 * 吸附增量会让每次落点带半格误差，拖十次整体偏移。
 */
export function draftFromMove(origin: Segment, deltaMs: number, durationMs: number): Segment {
  const length = origin.endMs - origin.startMs;
  // 片段比视频还长时 maxStart 会为负，钳到 0：此时只能贴左，长度无从守恒
  const maxStart = Math.max(0, durationMs - length);
  const start = clampMs(snapMs(origin.startMs + deltaMs), 0, maxStart);
  // 先算 start 再推 end：长度天然守恒。反过来「先改 end 再推 start」触边时片段会被切短
  return { startMs: start, endMs: start + length };
}

/**
 * 调整端点：只动一端。
 *
 * start 端的上界是 endMs - MIN_SEGMENT_MS 而非 endMs：用 endMs 会拖出零长片段，
 * 提交时被判 reversed，标注员看到的是「拖了一下，片段消失了」。
 */
export function draftFromResize(
  origin: Segment,
  edge: 'start' | 'end',
  deltaMs: number,
  durationMs: number,
): Segment {
  if (edge === 'start') {
    const maxStart = Math.max(0, origin.endMs - MIN_SEGMENT_MS);
    const start = clampMs(snapMs(origin.startMs + deltaMs), 0, maxStart);
    return { startMs: start, endMs: origin.endMs };
  }
  // 同理兜住「原片段贴着时长末尾」的退化情形，避免 minEnd > max 而把 end 钳到时长外
  const minEnd = Math.min(durationMs, origin.startMs + MIN_SEGMENT_MS);
  const end = clampMs(snapMs(origin.endMs + deltaMs), minEnd, durationMs);
  return { startMs: origin.startMs, endMs: end };
}

/**
 * 草案是否可提交：长度达标且不与 others 中任何一段重叠。
 *
 * others 必须排除被拖拽的原片段本身，否则平移时草案永远和自己原来那段重叠。
 * 重叠判定复用 interval.ts，保证 UI 结论与库里触发器一致。
 */
export function isAcceptableDraft(draft: Segment, others: readonly Segment[]): boolean {
  if (draft.endMs - draft.startMs < MIN_SEGMENT_MS) return false;
  return !others.some((segment) => overlaps(segment, draft));
}
