/**
 * 时间轴刻度与坐标映射。
 *
 * 纯函数零依赖：不读 DOM、不读时钟、不改入参，可在内存里直接测。
 * Timeline 只负责把这里算出的位置画出来，换算规则不散在组件里。
 */

/**
 * 刻度步长候选，单位毫秒。从「1 秒」到「1 小时」。
 *
 * 上界必须够大：候选表只到 5 分钟时，超过 60 分钟的素材会让刻度数随片长
 * 线性增长（4 小时 = 48 个刻度，在 1098px 轨道上间距 22px，10px 字号必然重叠）。
 * 补到 1 小时后，12 小时以内都能保持在 12 个刻度以内。
 */
const TICK_STEPS_MS = [
  1000,
  2000,
  5000,
  10_000,
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
  600_000,
  1_800_000,
  3_600_000,
];

/** 轨道上最多容纳的刻度数。再多，1180px 宽的轨道里 10px 字号就会挤在一起。 */
const MAX_TICKS = 12;

/** 依据总时长选刻度步长，目标是屏幕上出现 8~12 个刻度。 */
export function pickTickStepMs(durationMs: number): number {
  // 非法时长没有「合适的步长」，返回最小步长让调用方拿到确定值；
  // 不返回最大步长，是因为那会让 `pickTickStepMs(NaN)` 看起来像「素材很长」
  if (!Number.isFinite(durationMs) || durationMs <= 0) return TICK_STEPS_MS[0];

  for (const step of TICK_STEPS_MS) {
    if (durationMs / step <= MAX_TICKS) return step;
  }
  // 超过 12 小时的素材（监控长录、延时摄影拼接）不再加密候选表：
  // 此时刻度必然超出 MAX_TICKS，但至少步长是稳定的 1 小时整点
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
