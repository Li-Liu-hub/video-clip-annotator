/** 时间轴刻度与坐标映射的契约用例：步长选择、终点排除、比例钳制。 */
import { describe, expect, it } from 'vitest';
import { buildTicks, pickTickStepMs, ratioToMs } from '@/lib/timeline-scale';

describe('pickTickStepMs：按总时长选步长，刻度数不超过 12', () => {
  it('30 秒的视频取 5 秒步长，屏幕上 6 个刻度', () => {
    expect(pickTickStepMs(30_000)).toBe(5000);
  });

  it('42 分钟的视频取 5 分钟步长，避免刻度挤成一团', () => {
    expect(pickTickStepMs(2_565_000)).toBe(300_000);
  });

  it('1 秒的视频取最小步长 1000', () => {
    expect(pickTickStepMs(1000)).toBe(1000);
  });

  it('超出候选表覆盖范围的 4 小时视频退回最大步长 300000', () => {
    expect(pickTickStepMs(4 * 3_600_000)).toBe(300_000);
  });
});

describe('buildTicks：含 0，不含终点', () => {
  it('30 秒视频的刻度到 25000 为止，不生成 30000', () => {
    expect(buildTicks(30_000)).toEqual([0, 5000, 10_000, 15_000, 20_000, 25_000]);
  });

  it('42 分钟视频生成 9 个刻度（8.5 个整段向上取整）', () => {
    expect(buildTicks(2_565_000)).toHaveLength(9);
  });

  it('时长为 0 时不生成刻度，也不进入死循环', () => {
    expect(buildTicks(0)).toEqual([]);
  });
});

describe('ratioToMs：像素比例换算成时间并钳制', () => {
  it('比例 0 对应视频起点 0', () => {
    expect(ratioToMs(0, 30_000)).toBe(0);
  });

  it('比例 1 对应视频终点，即总时长本身', () => {
    expect(ratioToMs(1, 30_000)).toBe(30_000);
  });

  it('比例 0.5 落在正中间 15000', () => {
    expect(ratioToMs(0.5, 30_000)).toBe(15_000);
  });

  it('负比例钳制到 0，点中轨道左侧留白不会跳到视频首帧之前', () => {
    expect(ratioToMs(-0.5, 30_000)).toBe(0);
  });

  it('超过 1 的比例钳制到总时长，不会 seek 到视频之外', () => {
    expect(ratioToMs(1.5, 30_000)).toBe(30_000);
  });
});
