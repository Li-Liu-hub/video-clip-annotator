/** 区间数学的边界用例：半开 [start, end) 语义是库里重叠触发器的应用层镜像。 */
import { describe, expect, it } from 'vitest';
import {
  MIN_SEGMENT_MS,
  MS_PER_SECOND,
  SNAP_STEP_MS,
  clamp,
  findConflict,
  normalize,
  overlaps,
  snapTo,
  totalDuration,
} from '@/lib/interval';

describe('常量', () => {
  it('毫秒与秒的换算系数是 1000', () => {
    expect(MS_PER_SECOND).toBe(1000);
  });

  it('吸附步长与最短片段时长都是 100ms', () => {
    expect(SNAP_STEP_MS).toBe(100);
    expect(MIN_SEGMENT_MS).toBe(100);
  });
});

describe('overlaps：半开区间 [start, end)', () => {
  it('首尾相接 [10,20) 与 [20,30) 不重叠', () => {
    expect(overlaps({ startMs: 10, endMs: 20 }, { startMs: 20, endMs: 30 })).toBe(false);
  });

  it('1ms 交叠 [10,20) 与 [19,30) 重叠', () => {
    expect(overlaps({ startMs: 10, endMs: 20 }, { startMs: 19, endMs: 30 })).toBe(true);
  });

  it('完全相同 [10,20) 与 [10,20) 重叠', () => {
    expect(overlaps({ startMs: 10, endMs: 20 }, { startMs: 10, endMs: 20 })).toBe(true);
  });

  it('被包含 [10,20) 与 [5,25) 重叠', () => {
    expect(overlaps({ startMs: 10, endMs: 20 }, { startMs: 5, endMs: 25 })).toBe(true);
  });

  it('完全分离 [10,20) 与 [30,40) 不重叠', () => {
    expect(overlaps({ startMs: 10, endMs: 20 }, { startMs: 30, endMs: 40 })).toBe(false);
  });

  it('另一侧首尾相接 [10,20) 与 [0,10) 不重叠', () => {
    expect(overlaps({ startMs: 10, endMs: 20 }, { startMs: 0, endMs: 10 })).toBe(false);
  });

  it('零长区间 [15,15) 与 [10,20) 不重叠', () => {
    expect(overlaps({ startMs: 15, endMs: 15 }, { startMs: 10, endMs: 20 })).toBe(false);
  });
});

describe('findConflict', () => {
  it('候选区间与所有片段都无交集时返回 null', () => {
    const segments = [
      { startMs: 0, endMs: 10 },
      { startMs: 10, endMs: 20 },
    ];
    expect(findConflict(segments, { startMs: 20, endMs: 30 })).toBeNull();
  });

  it('返回第一个冲突的片段', () => {
    const segments = [
      { startMs: 0, endMs: 10 },
      { startMs: 15, endMs: 25 },
      { startMs: 30, endMs: 40 },
    ];
    expect(findConflict(segments, { startMs: 5, endMs: 35 })).toEqual({ startMs: 0, endMs: 10 });
  });

  it('空片段列表永远无冲突', () => {
    expect(findConflict([], { startMs: 0, endMs: 100 })).toBeNull();
  });
});

describe('normalize', () => {
  it('倒序入参归一成 startMs < endMs', () => {
    expect(normalize(5000, 1000)).toEqual({ startMs: 1000, endMs: 5000 });
  });

  it('正序入参原样返回', () => {
    expect(normalize(1000, 5000)).toEqual({ startMs: 1000, endMs: 5000 });
  });
});

describe('totalDuration', () => {
  it('空列表总时长为 0', () => {
    expect(totalDuration([])).toBe(0);
  });

  it('各段长度求和，不看片段之间的间隙', () => {
    const segments = [
      { startMs: 0, endMs: 1000 },
      { startMs: 5000, endMs: 6500 },
    ];
    expect(totalDuration(segments)).toBe(2500);
  });
});

describe('clamp', () => {
  it('低于下界取下界', () => {
    expect(clamp(-5, 0, 100)).toBe(0);
  });

  it('高于上界取上界', () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });

  it('区间内原样返回', () => {
    expect(clamp(42, 0, 100)).toBe(42);
  });
});

describe('snapTo', () => {
  it('1234 向下吸附到 1200', () => {
    expect(snapTo(1234)).toBe(1200);
  });

  it('1286 向上吸附到 1300', () => {
    expect(snapTo(1286)).toBe(1300);
  });

  it('正中间 1250 向上吸附，避免两个方向的临界抖动', () => {
    expect(snapTo(1250)).toBe(1300);
  });

  it('已经落在网格上时保持不变', () => {
    expect(snapTo(1300)).toBe(1300);
  });

  it('可以指定自定义步长', () => {
    expect(snapTo(1234, 500)).toBe(1000);
  });
});

describe('snapTo：非法入参必须显式失败', () => {
  it('step 为 0 时抛错，而不是返回 NaN', () => {
    expect(() => snapTo(1000, 0)).toThrow(RangeError);
  });

  it('step 为 NaN 时抛错', () => {
    expect(() => snapTo(1000, NaN)).toThrow(RangeError);
  });

  it('step 为 Infinity 时抛错', () => {
    expect(() => snapTo(1000, Infinity)).toThrow(RangeError);
  });

  it('ms 为 Infinity 时抛错，否则会穿透数据库约束写进账本', () => {
    expect(() => snapTo(Infinity)).toThrow(RangeError);
  });

  it('ms 为 NaN 时抛错', () => {
    expect(() => snapTo(NaN)).toThrow(RangeError);
  });
});

describe('totalDuration：逐段累加，不是并集也不是首尾差', () => {
  it('相邻片段各算各的：[0,1000) + [1000,3000) 是 3000', () => {
    expect(
      totalDuration([
        { startMs: 0, endMs: 1000 },
        { startMs: 1000, endMs: 3000 },
      ]),
    ).toBe(3000);
  });

  it('真正重叠的两段不合并：[0,1000) + [500,1500) 是 2000', () => {
    // 「合并重叠」式实现在这条上会返回 1500，这是唯一的检出点
    expect(
      totalDuration([
        { startMs: 0, endMs: 1000 },
        { startMs: 500, endMs: 1500 },
      ]),
    ).toBe(2000);
  });

  it('含零长片段时只算其余片段', () => {
    expect(
      totalDuration([
        { startMs: 0, endMs: 0 },
        { startMs: 0, endMs: 1000 },
      ]),
    ).toBe(1000);
  });
});

describe('findConflict：多冲突时的语义', () => {
  it('多段全冲突时返回数组顺序的第一个，不是时间最早的', () => {
    const existing = [
      { startMs: 45_000, endMs: 60_000 },
      { startMs: 5000, endMs: 15_000 },
      { startMs: 20_000, endMs: 25_000 },
    ];
    // 语义固化在此：改成语义时这条必须同步改，避免「返回全集」被悄悄换掉
    expect(findConflict(existing, { startMs: 10_000, endMs: 50_000 })).toEqual(existing[0]);
  });

  it('不修改传入的数组', () => {
    const existing = [
      { startMs: 45_000, endMs: 60_000 },
      { startMs: 5000, endMs: 15_000 },
    ];
    const snapshot = existing.map((s) => ({ ...s }));
    findConflict(existing, { startMs: 10_000, endMs: 50_000 });
    expect(existing).toEqual(snapshot);
  });

  it('与 overlaps 同源：有冲突当且仅当 overlaps 为真', () => {
    const pairs: [{ startMs: number; endMs: number }, { startMs: number; endMs: number }][] = [
      [{ startMs: 10, endMs: 20 }, { startMs: 20, endMs: 30 }],
      [{ startMs: 10, endMs: 20 }, { startMs: 19, endMs: 30 }],
      [{ startMs: 10, endMs: 20 }, { startMs: 10, endMs: 20 }],
      [{ startMs: 10, endMs: 20 }, { startMs: 5, endMs: 25 }],
      [{ startMs: 10, endMs: 20 }, { startMs: 30, endMs: 40 }],
    ];
    for (const [a, b] of pairs) {
      expect(findConflict([b], a) !== null).toBe(overlaps(a, b));
    }
  });
});

describe('overlaps：对称性与脏输入', () => {
  it('参数顺序不影响结论', () => {
    expect(overlaps({ startMs: 20, endMs: 30 }, { startMs: 10, endMs: 20 })).toBe(false);
    expect(overlaps({ startMs: 10, endMs: 20 }, { startMs: 20, endMs: 30 })).toBe(false);
  });

  it('零长区间与包含它的区间也不重叠', () => {
    expect(overlaps({ startMs: 10, endMs: 10 }, { startMs: 5, endMs: 15 })).toBe(false);
  });

  it('零长对零长不重叠', () => {
    expect(overlaps({ startMs: 10, endMs: 10 }, { startMs: 10, endMs: 10 })).toBe(false);
  });

  it('逆序区间视为空集，不产生冲突', () => {
    expect(overlaps({ startMs: 30, endMs: 10 }, { startMs: 0, endMs: 1000 })).toBe(false);
  });
});

describe('normalize：零长保持原样', () => {
  it('两个端点相等时返回零长，不放大成 1ms', () => {
    expect(normalize(10, 10)).toEqual({ startMs: 10, endMs: 10 });
  });
});
