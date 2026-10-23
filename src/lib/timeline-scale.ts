/**
 * 时间轴刻度与坐标映射。
 *
 * 纯函数零依赖：不读 DOM、不读时钟、不改入参，可在内存里直接测。
 * Timeline 只负责把这里算出的位置画出来，换算规则不散在组件里。
 */

/** 刻度步长候选，单位毫秒。从「1 秒」到「5 分钟」，覆盖数十秒到数小时的素材。 */
const TICK_STEPS_MS = [1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/** 轨道上最多容纳的刻度数。再多，1180px 宽的轨道里 10px 字号就会挤在一起。 */
const MAX_TICKS = 12;

/** 依据总时长选刻度步长，目标是屏幕上出现 8~12 个刻度。 */
export function pickTickStepMs(durationMs: number): number {
  for (const step of TICK_STEPS_MS) {
    if (durationMs / step <= MAX_TICKS) return step;
  }
  // 数小时以上的素材：不再加密候选表，直接用最大步长，刻度稀疏总好过糊成一片
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
}

/** 生成刻度位置（毫秒），含 0，不含终点。 */
export function buildTicks(durationMs: number): number[] {
  // NaN、Infinity、0 与负数都不生成刻度：Infinity 会让下面的 for 永远不结束
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];

  const step = pickTickStepMs(durationMs);
  const ticks: number[] = [];
  for (let ms = 0; ms < durationMs; ms += step) {
    ticks.push(ms);
  }
  return ticks;
}

/** 像素位置换算成时间，结果钳制在 [0, durationMs] 内。 */
export function ratioToMs(ratio: number, durationMs: number): number {
  // 拖到轨道外或点中圆角处会得到 <0 或 >1，钳制后等同于「跳到首帧 / 末帧」
  return Math.min(Math.max(ratio * durationMs, 0), durationMs);
}
