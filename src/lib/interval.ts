/**
 * 区间数学的唯一实现处。全项目判定「两段是否重叠」都走这里，
 * 保证应用层预检与 schema.sql 里触发器的结论永远一致。
 *
 * 语义是半开区间 [start, end)：首尾相接是正常的连续标注，不是冲突。
 */

export const MS_PER_SECOND = 1000;

/** 时间轴吸附步长。100ms 是播放器上人手能稳定落点的最小刻度。 */
export const SNAP_STEP_MS = 100;

/**
 * 单个片段最短时长。比一个吸附步长更短的片段拖不稳，也无法用键盘微调。
 * 库里的 CHECK 只保证 end > start，真正的下限由 E3 拖拽与 E4 提交校验执行。
 */
export const MIN_SEGMENT_MS = 100;

export type Interval = { startMs: number; endMs: number };

/**
 * 半开区间重叠判定。`<` / `>` 而非 `<=` / `>=`，是「首尾相接合法」的唯一实现点。
 * 零长区间视为空集（拖拽起点终点重合时不该报冲突）；库里 `end_ms > start_ms` 的 CHECK
 * 保证空区间进不了库，所以这里的特判不会与触发器结论相反。
 */
export function overlaps(a: Interval, b: Interval): boolean {
  if (a.startMs >= a.endMs || b.startMs >= b.endMs) return false;
  return a.startMs < b.endMs && a.endMs > b.startMs;
}

/** 返回第一个与候选区间冲突的片段，供 UI 指出撞到了哪一段。 */
export function findConflict(segments: Interval[], candidate: Interval): Interval | null {
  return segments.find((s) => overlaps(s, candidate)) ?? null;
}

/** 两个数字归一成 startMs <= endMs。拖拽可能从右往左框选；相等时保持零长（代表「没选中」），不放大成 1ms。 */
export function normalize(a: number, b: number): Interval {
  return a <= b ? { startMs: a, endMs: b } : { startMs: b, endMs: a };
}

/** 各片段时长求和。片段之间允许留白，所以不能用「末段 end − 首段 start」。 */
export function totalDuration(segments: Interval[]): number {
  return segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
}

/** 夹在 [min, max] 内，用于把落点限制在视频时长范围内。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 吸附到 step 的整数倍（默认 100ms）。
 * 用四舍五入而不是向下取整：向下取整会让落点永远偏左，连续拖动累积半格误差。
 *
 * 非法入参显式抛错，不返回 NaN/Infinity：NaN 会让 overlaps 恒为 false（冲突预检静默放行），
 * Infinity 能穿透库里全部 CHECK 写进账本，SUM 之后整个统计变成 Infinity。
 */
export function snapTo(ms: number, step: number = SNAP_STEP_MS): number {
  if (!Number.isFinite(ms) || !Number.isFinite(step) || step <= 0) {
    throw new RangeError(`snapTo 参数非法：ms=${ms}, step=${step}`);
  }
  return Math.round(ms / step) * step;
}
