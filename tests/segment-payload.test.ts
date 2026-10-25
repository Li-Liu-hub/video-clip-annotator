/**
 * 片段接口的载荷契约。
 *
 * 重点是 `upsertPayloadOf` 必须把 label 带出去：撤销回放靠它把标签放回去，
 * 漏传的表现是「时间对、标签没了」—— 只有真的跑一遍浏览器才看得出来。
 * 这里用类型 + 用例两道：返回类型 label 必填，用例断言它出现在 JSON 里。
 */
import { describe, expect, it } from 'vitest';
import { readSegment, readSegmentList, upsertPayloadOf } from '@/lib/segment-payload';

describe('upsertPayloadOf', () => {
  it('带上区间的 label，replaces 默认 null', () => {
    expect(upsertPayloadOf({ startMs: 1_000, endMs: 5_000, label: '有效操作' })).toEqual({
      startMs: 1_000,
      endMs: 5_000,
      replaces: null,
      label: '有效操作',
    });
  });

  it('label 为 null 时保留 null，而不是从载荷里消失', () => {
    const payload = upsertPayloadOf({ startMs: 0, endMs: 100, label: null });
    expect('label' in payload && payload.label === null).toBe(true);
  });

  it('替换时带上 replaces', () => {
    expect(upsertPayloadOf({ startMs: 0, endMs: 100, label: null }, 'c000000000000001').replaces).toBe(
      'c000000000000001',
    );
  });
});

describe('readSegment 的 label', () => {
  it('字符串 label 原样保留', () => {
    expect(
      readSegment({
        segment: { id: 'c000000000000001', startMs: 0, endMs: 100, label: '有效操作' },
      }),
    ).toEqual({ id: 'c000000000000001', startMs: 0, endMs: 100, label: '有效操作' });
  });

  it('缺字段或非字符串时归一成 null，不把 undefined 渲染到页面', () => {
    const row = readSegment({ segment: { id: 'c000000000000001', startMs: 0, endMs: 100 } });
    expect(row?.label).toBeNull();
  });

  it('列表里任一项不合契约就整批拒收', () => {
    expect(readSegmentList({ segments: [{ id: 'x', startMs: 0 }] })).toBeNull();
  });
});
