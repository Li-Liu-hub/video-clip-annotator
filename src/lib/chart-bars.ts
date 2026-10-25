/**
 * 柱状图的槽位计算：区间内每一天一个槽，缺的日子补 0。
 *
 * 为什么单独成一个模块而不是留在 DailyChart 里：
 * 1. 补零是这条业务规则的核心，必须能被测试守住 —— 组件文件带 JSX，
 *    node 环境加载不了，测试拿不到它（实际发生过：reviewer 删掉补零，630 例全绿）。
 * 2. 纯函数不该住在组件里。
 */
import type { DayTotal } from '@/lib/services/stats-service';
import { datesInRange } from '@/lib/stats-range';

export type BarSlot = { date: string; totalMs: number; ratio: number };

/**
 * 把「区间内的每一天」与「有数据的那些天」对齐成固定数量的槽位。
 *
 * 只按有数据的行画柱子的话，8 天区间里只有 2 天有账会变成「2 根均匀铺满」，
 * 横轴被压缩成 2 天，比不画更误导。
 */
export function barSlots(from: string, to: string, rows: readonly DayTotal[]): BarSlot[] {
  const dates = datesInRange(from, to);
  const totalByDate = new Map(rows.map((row) => [row.date, row.totalMs]));
  const peakMs = rows.reduce((max, row) => Math.max(max, row.totalMs), 0);
  // peakMs 为 0（有账目但净额全被冲平）时用 1 兜底，避免除零把柱高变成 NaN
  const scale = peakMs > 0 ? peakMs : 1;
  return dates.map((date) => {
    const totalMs = totalByDate.get(date) ?? 0;
    return { date, totalMs, ratio: totalMs > 0 ? totalMs / scale : 0 };
  });
}
