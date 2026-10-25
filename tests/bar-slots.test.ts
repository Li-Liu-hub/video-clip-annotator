/**
 * 柱状图的补零：区间内每一天都要有槽位。
 *
 * 只按有数据的行画柱子的话，8 天里只有 2 天有账会变成「2 根均匀铺满」，
 * 横轴被压缩成 2 天，比不画更误导。
 */
import { describe, expect, it } from 'vitest';
import { barSlots } from '@/lib/chart-bars';

const row = (date: string, totalMs: number) => ({ date, totalMs, entryCount: 1 });

describe('柱状图补零', () => {
  it('7 天区间里只有 2 天有数据时，仍然产出 7 个槽位', () => {
    const slots = barSlots('2026-10-19', '2026-10-25', [row('2026-10-19', 5_000), row('2026-10-25', 10_000)]);
    expect(slots.length).toBe(7);
  });

  it('没有数据的那几天 totalMs 是 0，不是被省略', () => {
    const slots = barSlots('2026-10-19', '2026-10-21', [row('2026-10-20', 5_000)]);
    expect(slots.map((slot) => slot.totalMs)).toEqual([0, 5_000, 0]);
  });

  it('有数据的那天落在正确的槽位，不是被挤到前面', () => {
    const slots = barSlots('2026-10-19', '2026-10-21', [row('2026-10-21', 5_000)]);
    expect(slots[2]?.date).toBe('2026-10-21');
    expect(slots[2]?.totalMs).toBe(5_000);
  });

  it('柱高比例以区间峰值为基：最大值那根是 1', () => {
    const slots = barSlots('2026-10-19', '2026-10-20', [row('2026-10-19', 2_000), row('2026-10-20', 8_000)]);
    expect(slots.map((slot) => slot.ratio)).toEqual([0.25, 1]);
  });

  it('全空区间不除零：比例全是 0', () => {
    const slots = barSlots('2026-10-19', '2026-10-20', []);
    expect(slots.map((slot) => slot.ratio)).toEqual([0, 0]);
  });

  it('净额为负的那天算 0 比例，不画向下的柱', () => {
    const slots = barSlots('2026-10-19', '2026-10-19', [row('2026-10-19', -1_000)]);
    expect(slots[0]?.ratio).toBe(0);
  });
});
