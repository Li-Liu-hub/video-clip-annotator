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

  it('4 小时视频用 30 分钟步长，刻度不超 12 个', () => {
    // 候选表原本只到 5 分钟，导致 4 小时会画出 48 个刻度、间距 22px 必然重叠。
    // 步长上界补到 1 小时后，4 小时落在 30 分钟档，共 8 个刻度。
    expect(pickTickStepMs(4 * 3_600_000)).toBe(1_800_000);
    expect(buildTicks(4 * 3_600_000).length).toBeLessThanOrEqual(12);
  });

  it('超过 12 小时的素材退回 1 小时步长', () => {
    expect(pickTickStepMs(20 * 3_600_000)).toBe(3_600_000);
  });

  it('非法时长返回最小步长而非最大步长', () => {
    // 返回最大步长会让「NaN」看起来像「素材很长」，掩盖调用方的错误
    expect(pickTickStepMs(Number.NaN)).toBe(1000);
    expect(pickTickStepMs(0)).toBe(1000);
    expect(pickTickStepMs(-5000)).toBe(1000);
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
