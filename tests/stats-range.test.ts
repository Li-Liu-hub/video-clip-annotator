/**
 * G3 统计页的区间与维度归一：预设区间、跨月/跨年边界、URL 兜底。
 *
 * 只测纯函数。区间差一天，整张报表就整体偏移，且不会有任何报错 ——
 * 这类错只能靠边界用例拦住（月初、跨月、跨年、闰年）。
 */
import { describe, expect, it } from 'vitest';
import {
  countDays,
  datesInRange,
  normalizeDimension,
  queryOf,
  rangeOf,
  resolveRange,
} from '@/lib/stats-range';

const TODAY = '2026-10-25';

describe('个人工作量维度', () => {
  it('个人访问旧按人链接时回落按日，管理员仍保留按人维度', () => {
    expect([normalizeDimension('annotator', false), normalizeDimension('annotator', true)]).toEqual(['day', 'annotator']);
  });
});

describe('rangeOf：预设区间都含今天', () => {
  it('最近 7 天从 6 天前到今天', () => {
    expect(rangeOf('last7', TODAY)).toEqual({ from: '2026-10-19', to: '2026-10-25' });
  });

  it('最近 30 天从 29 天前到今天，共 30 天', () => {
    expect(rangeOf('last30', TODAY)).toEqual({ from: '2026-09-26', to: '2026-10-25' });
  });

  it('本月从 1 号到今天', () => {
    expect(rangeOf('thisMonth', TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-25' });
  });

  it('本月在 1 号当天不越界到上个月', () => {
    // 用「减一个月」的日期运算会在这里退到 9 月 1 日
    expect(rangeOf('thisMonth', '2026-10-01')).toEqual({
      from: '2026-10-01',
      to: '2026-10-01',
    });
  });

  it('最近 7 天跨月时退到上个月，不截断在 1 号', () => {
    expect(rangeOf('last7', '2026-11-02')).toEqual({ from: '2026-10-27', to: '2026-11-02' });
  });

  it('最近 7 天跨年时退到上一年', () => {
    expect(rangeOf('last7', '2027-01-03')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
  });

  it('闰年 3 月 1 日往前 6 天落在 2 月 24 日', () => {
    expect(rangeOf('last7', '2024-03-01')).toEqual({ from: '2024-02-24', to: '2024-03-01' });
  });
});

describe('normalizeDimension：非法或缺失一律 day', () => {
  it('拼错的维度回 day', () => {
    expect(normalizeDimension('week')).toBe('day');
  });

  it('缺失的维度回 day', () => {
    expect(normalizeDimension(undefined)).toBe('day');
  });

  it('空串回 day', () => {
    expect(normalizeDimension('')).toBe('day');
  });

  it('重复给同一个键时取第一个', () => {
    expect(normalizeDimension(['task', 'day'])).toBe('task');
  });

  it('合法维度原样返回', () => {
    expect(normalizeDimension('annotator')).toBe('annotator');
  });
});

describe('resolveRange：URL 区间不合法就回落最近 7 天', () => {
  it('缺省区间回 last7，且不算「已调整」', () => {
    expect(resolveRange(undefined, undefined, TODAY)).toEqual({
      range: { from: '2026-10-19', to: '2026-10-25' },
      adjusted: false,
    });
  });

  it('合法区间原样采用', () => {
    expect(resolveRange('2026-09-01', '2026-09-30', TODAY)).toEqual({
      range: { from: '2026-09-01', to: '2026-09-30' },
      adjusted: false,
    });
  });

  it('不存在的日历日（2 月 31 日）回落并标记已调整', () => {
    expect(resolveRange('2026-02-31', '2026-03-05', TODAY)).toEqual({
      range: { from: '2026-10-19', to: '2026-10-25' },
      adjusted: true,
    });
  });

  it('起始晚于结束回落并标记已调整', () => {
    expect(resolveRange('2026-10-25', '2026-10-01', TODAY)).toEqual({
      range: { from: '2026-10-19', to: '2026-10-25' },
      adjusted: true,
    });
  });

  it('只给了一端也回落', () => {
    expect(resolveRange('2026-10-01', undefined, TODAY).adjusted).toBe(true);
  });
});

describe('日期铺格：图表按天对齐', () => {
  it('单日区间算 1 天', () => {
    expect(countDays('2026-10-01', '2026-10-01')).toBe(1);
  });

  it('闭区间含两端，跨月连续不断日', () => {
    expect(datesInRange('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('区间反了不产生任何一天', () => {
    expect(datesInRange('2026-10-25', '2026-10-01')).toEqual([]);
  });
});

describe('边界：月末、年初、闰年', () => {
  it('last7 跨月：2026-11-02 的七天前是 10-27', () => {
    expect(rangeOf('last7', '2026-11-02')).toEqual({ from: '2026-10-27', to: '2026-11-02' });
  });

  it('last7 跨年：2026-01-03 的七天前是 2025-12-28', () => {
    expect(rangeOf('last7', '2026-01-03')).toEqual({ from: '2025-12-28', to: '2026-01-03' });
  });

  it('last7 落在平年 2 月：2026-03-02 的七天前是 2 月 24 日', () => {
    expect(rangeOf('last7', '2026-03-02')).toEqual({ from: '2026-02-24', to: '2026-03-02' });
  });

  it('last7 落在闰年 2 月：2028-03-01 的七天前是 2 月 24 日（29 天月）', () => {
    expect(rangeOf('last7', '2028-03-01')).toEqual({ from: '2028-02-24', to: '2028-03-01' });
  });

  it('last30 跨平年 2 月：2026-03-01 的三十天前是 1 月 31 日', () => {
    expect(rangeOf('last30', '2026-03-01')).toEqual({ from: '2026-01-31', to: '2026-03-01' });
  });

  it('last30 跨闰年 2 月：2028-03-01 的三十天前是 2 月 1 日', () => {
    // 与上一条只差一天 —— 专门杀「30 × 86400000 硬减」这类半错实现
    expect(rangeOf('last30', '2028-03-01')).toEqual({ from: '2028-02-01', to: '2028-03-01' });
  });

  it('last30 跨年：2026-01-01 的三十天前是 2025-12-03', () => {
    expect(rangeOf('last30', '2026-01-01')).toEqual({ from: '2025-12-03', to: '2026-01-01' });
  });

  it('thisMonth 在 1 号不越界到上个月', () => {
    expect(rangeOf('thisMonth', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-01' });
  });

  it('thisMonth 在月末只到当天', () => {
    expect(rangeOf('thisMonth', '2026-02-28')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
});

describe('性质：连续 730 天不漂移', () => {
  it('last7 的 from 逐日推进时恰好后移一天', () => {
    // 锚点表定常数，性质扫描定漂移。两者缺一都会留下「某个日期算错」的盲区
    let prev = rangeOf('last7', '2026-01-01').from;
    for (let day = 2; day <= 730; day += 1) {
      const date = datesInRange('2026-01-01', '2027-12-31')[day - 1];
      const current = rangeOf('last7', date).from;
      expect(datesInRange(prev, '2027-12-31')[1]).toBe(current);
      prev = current;
    }
  });

  it('thisMonth 的区间天数等于当天的日号', () => {
    for (const [date, days] of [
      ['2026-10-01', 1],
      ['2026-10-25', 25],
      ['2026-10-31', 31],
      ['2028-02-29', 29],
    ] as const) {
      const range = rangeOf('thisMonth', date);
      expect(countDays(range.from, range.to)).toBe(days);
    }
  });
});

describe('导出与视图的查询串同源', () => {
  it('三个维度各自产出带 dim 的查询串', () => {
    // 「导出的必须是当前视图」这句话的唯一实现点。
    // 把 dimension 写死成 'day' 时，页面照常、导出全错，且不会有别的用例变红
    const range = { from: '2026-10-19', to: '2026-10-25' };
    expect(queryOf('annotator', range)).toBe('dim=annotator&from=2026-10-19&to=2026-10-25');
  });

  it('按任务视图的导出不会退回成按日', () => {
    expect(queryOf('task', { from: '2026-10-01', to: '2026-10-31' })).toContain('dim=task');
  });
});
