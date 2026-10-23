/**
 * 片段区间校验的边界表测试。
 *
 * 先于实现书写：`normalizeSegments` 尚未存在时这些用例应当全部失败。
 * 每条 it 对应 docs/steps/14a-segment-interval.md 边界表的一行。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SEGMENTS,
  MIN_SEGMENT_MS,
  normalizeSegments,
  type Segment,
} from '@/lib/segment-interval';

/** 边界表的基准时长：30 秒。 */
const DURATION = 30_000;

const seg = (startMs: number, endMs: number): Segment => ({ startMs, endMs });

describe('正常路径', () => {
  it('单个合法片段原样通过', () => {
    expect(normalizeSegments([seg(0, 1000)], DURATION)).toEqual({
      ok: true,
      segments: [seg(0, 1000)],
      totalMs: 1000,
    });
  });

  it('终点等于视频时长是合法的（左闭右开）', () => {
    const result = normalizeSegments([seg(0, DURATION)], DURATION);
    expect(result.ok).toBe(true);
  });

  it('恰好等于最小长度是合法的', () => {
    const result = normalizeSegments([seg(0, MIN_SEGMENT_MS)], DURATION);
    expect(result.ok).toBe(true);
  });

  it('乱序输入会被重排成升序', () => {
    const result = normalizeSegments([seg(5000, 9000), seg(1000, 3000)], DURATION);
    expect(result).toEqual({
      ok: true,
      segments: [seg(1000, 3000), seg(5000, 9000)],
      totalMs: 6000,
    });
  });
});

describe('端点相接不算重叠', () => {
  it('两段首尾相接放行', () => {
    expect(normalizeSegments([seg(0, 2000), seg(2000, 4000)], DURATION)).toEqual({
      ok: true,
      segments: [seg(0, 2000), seg(2000, 4000)],
      totalMs: 4000,
    });
  });

  it('三段连续相接放行', () => {
    const result = normalizeSegments([seg(0, 2000), seg(2000, 4000), seg(4000, 6000)], DURATION);
    expect(result).toEqual({
      ok: true,
      segments: [seg(0, 2000), seg(2000, 4000), seg(4000, 6000)],
      totalMs: 6000,
    });
  });
});

describe('空与数量', () => {
  it('空数组返回 empty', () => {
    expect(normalizeSegments([], DURATION)).toEqual({ ok: false, issue: { code: 'empty' } });
  });

  it('超过上限返回 too-many', () => {
    const many = Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) =>
      seg(i * 300, i * 300 + 200),
    );
    const result = normalizeSegments(many, 1_000_000);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issue.code).toBe('too-many');
  });
});

describe('单项非法值', () => {
  it('零长度视为 reversed', () => {
    expect(normalizeSegments([seg(0, 0)], DURATION)).toEqual({
      ok: false,
      issue: { code: 'reversed', index: 0 },
    });
  });

  it('终点在起点之前是 reversed', () => {
    expect(normalizeSegments([seg(1000, 500)], DURATION)).toEqual({
      ok: false,
      issue: { code: 'reversed', index: 0 },
    });
  });

  it('负起点是 negative', () => {
    expect(normalizeSegments([seg(-100, 500)], DURATION)).toEqual({
      ok: false,
      issue: { code: 'negative', index: 0 },
    });
  });

  it('终点超出视频是 out-of-range', () => {
    expect(normalizeSegments([seg(0, DURATION + 1)], DURATION)).toEqual({
      ok: false,
      issue: { code: 'out-of-range', index: 0 },
    });
  });

  it('短于最小长度是 too-short', () => {
    expect(normalizeSegments([seg(0, MIN_SEGMENT_MS - 1)], DURATION)).toEqual({
      ok: false,
      issue: { code: 'too-short', index: 0 },
    });
  });

  it('NaN 起点是 not-finite', () => {
    expect(normalizeSegments([seg(Number.NaN, 1000)], DURATION)).toEqual({
      ok: false,
      issue: { code: 'not-finite', index: 0 },
    });
  });

  it('Infinity 终点是 not-finite', () => {
    expect(normalizeSegments([seg(0, Number.POSITIVE_INFINITY)], DURATION)).toEqual({
      ok: false,
      issue: { code: 'not-finite', index: 0 },
    });
  });

  it('时长为 0 时任何片段都 out-of-range', () => {
    expect(normalizeSegments([seg(0, 100)], 0)).toEqual({
      ok: false,
      issue: { code: 'out-of-range', index: 0 },
    });
  });
});

describe('重叠', () => {
  it('有交集时拒绝', () => {
    expect(normalizeSegments([seg(0, 2000), seg(1000, 3000)], DURATION)).toEqual({
      ok: false,
      issue: { code: 'overlap', index: 1, previousIndex: 0 },
    });
  });

  it('完全重复的两段拒绝', () => {
    expect(normalizeSegments([seg(5000, 6000), seg(5000, 6000)], DURATION)).toEqual({
      ok: false,
      issue: { code: 'overlap', index: 1, previousIndex: 0 },
    });
  });

  it('乱序输入的重叠报原始下标', () => {
    // 入参第 0 项是 1000-3000，第 1 项是 0-2000；排序后 0-2000 在前。
    // 后一段的原始下标是 0，前一段是 1 —— 报的是入参位置，不是排序后位置。
    expect(normalizeSegments([seg(1000, 3000), seg(0, 2000)], DURATION)).toEqual({
      ok: false,
      issue: { code: 'overlap', index: 0, previousIndex: 1 },
    });
  });
});

describe('不可变性', () => {
  it('调用后入参数组顺序不变', () => {
    const raw = [seg(5000, 9000), seg(1000, 3000)];
    normalizeSegments(raw, DURATION);
    expect(raw[0]).toEqual(seg(5000, 9000));
    expect(raw[1]).toEqual(seg(1000, 3000));
  });

  it('返回的片段与入参不是同一个对象', () => {
    const raw = [seg(0, 1000)];
    const result = normalizeSegments(raw, DURATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segments[0]).not.toBe(raw[0]);
  });

  it('修改返回值不影响入参', () => {
    const raw = [seg(0, 1000)];
    const result = normalizeSegments(raw, DURATION);
    if (!result.ok) throw new Error('应当通过');
    result.segments[0].startMs = 999;
    expect(raw[0].startMs).toBe(0);
  });
});
