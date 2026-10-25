/**
 * 工作量时长的展示格式。
 *
 * 规则来自 28-stats-page 的「实现要点 4」：按人话进位，不出现小数小时。
 * 与 lib/time 的媒体时间轴格式并存：那两个是播放器坐标，不能改。
 */
import { describe, expect, it } from 'vitest';
import { formatHumanDuration } from '@/lib/duration-format';

describe('工作量时长格式', () => {
  it('不足一分钟按秒显示，保留一位小数', () => {
    expect(formatHumanDuration(5_700)).toBe('5.7s');
  });

  it('0 显示 0.0s 而不是空串', () => {
    expect(formatHumanDuration(0)).toBe('0.0s');
  });

  it('满一分钟进位到分秒，不再显示小数', () => {
    expect(formatHumanDuration(90_000)).toBe('1分30秒');
  });

  it('整分钟不带秒', () => {
    expect(formatHumanDuration(60_000)).toBe('1分');
  });

  it('满一小时进位到时分', () => {
    expect(formatHumanDuration(3_900_000)).toBe('1小时5分');
  });

  it('整小时不带分', () => {
    expect(formatHumanDuration(3_600_000)).toBe('1小时');
  });

  it('负数保留符号：净额被冲正压下去时不能假装成正的', () => {
    expect(formatHumanDuration(-1_000)).toBe('-1.0s');
  });
});
