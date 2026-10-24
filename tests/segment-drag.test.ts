/** 拖拽草案的契约用例：吸附、钳制、三种拖拽结果、合格判定与不合格的原因。 */
import { describe, expect, it } from 'vitest';
import {
  assessDraft,
  clampMs,
  draftFromDrag,
  draftFromMove,
  draftFromResize,
  isAcceptableDraft,
  snapMs,
} from '@/lib/segment-drag';

describe('snapMs / clampMs：吸附到 100ms 与区间钳制', () => {
  it('1234ms 吸附到 1200，4678ms 吸附到 4700', () => {
    expect([snapMs(1234), snapMs(4678)]).toEqual([1200, 4700]);
  });

  it('超出上下界的落点被钳到区间端点', () => {
    expect([clampMs(-100, 0, 30_000), clampMs(40_000, 0, 30_000)]).toEqual([0, 30_000]);
  });
});

describe('draftFromDrag：两端吸附并钳制，反向拖拽归一', () => {
  it('1200 拖到 4600 得到 {1200, 4600}，整百落点不再漂移', () => {
    expect(draftFromDrag(1200, 4600, 30_000)).toEqual({ startMs: 1200, endMs: 4600 });
  });

  it('1234 拖到 4678 吸附到 {1200, 4700}', () => {
    expect(draftFromDrag(1234, 4678, 30_000)).toEqual({ startMs: 1200, endMs: 4700 });
  });

  it('从 5000 反向拖到 1000 归一为 {1000, 5000}', () => {
    expect(draftFromDrag(5000, 1000, 30_000)).toEqual({ startMs: 1000, endMs: 5000 });
  });

  it('拖出轨道两端时钳制为 {0, 30000}，不出现负时间或超长片段', () => {
    expect(draftFromDrag(-100, 40_000, 30_000)).toEqual({ startMs: 0, endMs: 30_000 });
  });
});

describe('draftFromMove：长度守恒，触边不缩短', () => {
  it('{1000, 5000} 右移 2000ms 得到 {3000, 7000}', () => {
    expect(draftFromMove({ startMs: 1000, endMs: 5000 }, 2000, 30_000)).toEqual({
      startMs: 3000,
      endMs: 7000,
    });
  });

  it('{1000, 5000} 左移 5000ms 停在左边界，得到 {0, 4000} 而非被切短', () => {
    expect(draftFromMove({ startMs: 1000, endMs: 5000 }, -5000, 30_000)).toEqual({
      startMs: 0,
      endMs: 4000,
    });
  });

  it('{25000, 29000} 右移 5000ms 停在右边界，得到 {26000, 30000}', () => {
    expect(draftFromMove({ startMs: 25_000, endMs: 29_000 }, 5000, 30_000)).toEqual({
      startMs: 26_000,
      endMs: 30_000,
    });
  });
});

describe('draftFromResize：只动一端，且留足最小长度', () => {
  it('start 端右移 1000ms 得到 {2000, 5000}', () => {
    expect(draftFromResize({ startMs: 1000, endMs: 5000 }, 'start', 1000, 30_000)).toEqual({
      startMs: 2000,
      endMs: 5000,
    });
  });

  it('start 端右移 9999ms 停在 endMs - MIN_SEGMENT_MS，得到 {4900, 5000}', () => {
    expect(draftFromResize({ startMs: 1000, endMs: 5000 }, 'start', 9999, 30_000)).toEqual({
      startMs: 4900,
      endMs: 5000,
    });
  });

  it('end 端左移 9999ms 停在 startMs + MIN_SEGMENT_MS，得到 {1000, 1100}', () => {
    expect(draftFromResize({ startMs: 1000, endMs: 5000 }, 'end', -9999, 30_000)).toEqual({
      startMs: 1000,
      endMs: 1100,
    });
  });

  it('end 端右移 99999ms 钳到视频末尾，得到 {1000, 30000}', () => {
    expect(draftFromResize({ startMs: 1000, endMs: 5000 }, 'end', 99_999, 30_000)).toEqual({
      startMs: 1000,
      endMs: 30_000,
    });
  });
});

describe('isAcceptableDraft：重叠、太短、合法三态', () => {
  const others = [{ startMs: 5000, endMs: 9000 }];

  it('与既有片段重叠时不可提交', () => {
    expect(isAcceptableDraft({ startMs: 3000, endMs: 6000 }, others)).toBe(false);
  });

  it('短于 MIN_SEGMENT_MS 时不可提交', () => {
    expect(isAcceptableDraft({ startMs: 1000, endMs: 1050 }, others)).toBe(false);
  });

  it('不与任何片段重叠且长度达标时可提交', () => {
    expect(isAcceptableDraft({ startMs: 9000, endMs: 12_000 }, others)).toBe(true);
  });
});

/**
 * 掩蔽性测试：专门锁住「用整百数字写用例时看不出来」的错法。
 *
 * 本文件其余用例的 origin 长度、delta、起点几乎都是整百，
 * 于是「两端各自吸附」「先推 end 再算 start」「判据写成 <=」这三类错法
 * 都能全部通过 —— 变异验证时一条都不会红。
 * 下面四条分别对应 Reviewer 指出的 M1/M2/M4/M5。
 */
describe('边界：整百数据掩盖不了的错法', () => {
  it('首尾相接的草案可以提交', () => {
    // M1：把 overlaps 的 < 改成 <= 会在这里变红
    expect(isAcceptableDraft({ startMs: 5000, endMs: 8000 }, [{ startMs: 1000, endMs: 5000 }])).toBe(
      true,
    );
  });

  it('长度恰好等于最小片段时可以提交', () => {
    // M2：把 < MIN_SEGMENT_MS 改成 <= MIN_SEGMENT_MS 会在这里变红
    expect(isAcceptableDraft({ startMs: 1000, endMs: 1100 }, [])).toBe(true);
  });

  it('非整百长度的片段平移后长度严格守恒', () => {
    // M4：把 move 改成「先改 end 再推 start」会在这里变红
    // 4317ms 这种长度来自像素换算，是常态而非边角
    const moved = draftFromMove({ startMs: 1234, endMs: 5551 }, 1000, 30000);
    expect(moved.endMs - moved.startMs).toBe(4317);
  });

  it('非整百长度的片段触边平移后长度仍严格守恒', () => {
    // 同一处的另一半：触左边界时若先改 end，长度会被切短
    const moved = draftFromMove({ startMs: 1234, endMs: 5551 }, -9999, 30000);
    expect(moved.endMs - moved.startMs).toBe(4317);
  });
});

describe('平移后的落点必须落在整百网格上', () => {
  /**
   * 只断言「长度守恒」是不够的：长度对但整体偏移，仍然是错。
   * 取 origin={1234,5551}、delta=1000：
   *   正确 → start=snap(2234)=2200，end=2200+4317=6517
   *   M4（先算 end 再推 start）→ end=snap(6551)=6600，start=2283（整体右移 83ms）
   *   M5b（吸附作用在增量上）→ start=1234+snap(1000)=2234（起点脱离网格）
   * 三者长度都可能是 4317，只有断言精确值才能分辨。
   */
  it('非整百起点平移后起点落回整百网格，终点按长度推导', () => {
    expect(draftFromMove({ startMs: 1234, endMs: 5551 }, 1000, 30000)).toEqual({
      startMs: 2200,
      endMs: 6517,
    });
  });
});

describe('assessDraft：不合格时给出原因', () => {
  it('长度恰好等于最小片段时返回合格', () => {
    // 把 `<` 写成 `<=` 会在这里变红
    expect(assessDraft({ startMs: 1000, endMs: 1100 }, [])).toEqual({ kind: 'ok' });
  });

  it('短于最小片段时返回太短', () => {
    expect(assessDraft({ startMs: 1000, endMs: 1050 }, [])).toEqual({ kind: 'too-short' });
  });

  it('压住既有片段时返回重叠，并带上是哪一段', () => {
    expect(assessDraft({ startMs: 1000, endMs: 5000 }, [{ startMs: 2000, endMs: 3000 }])).toEqual({
      kind: 'overlap',
      with: { startMs: 2000, endMs: 3000 },
    });
  });

  it('首尾相接不算冲突，返回合格', () => {
    // 与 overlaps 的 < / > 同一处：改成 <= 会在这里变红
    expect(assessDraft({ startMs: 1000, endMs: 2000 }, [{ startMs: 2000, endMs: 3000 }])).toEqual({
      kind: 'ok',
    });
  });
});

describe('assessDraft：判据顺序与多冲突', () => {
  it('同时太短且重叠时报太短，挪开位置后提示仍然成立', () => {
    // 先判重叠会返回 overlap，用户按提示挪开位置后仍不合格 —— 提示指向了次要问题
    expect(assessDraft({ startMs: 1000, endMs: 1050 }, [{ startMs: 1000, endMs: 2000 }])).toEqual({
      kind: 'too-short',
    });
  });

  it('撞到多段时 with 是数组顺序的第一个，不是时间最早的', () => {
    const others = [
      { startMs: 45_000, endMs: 60_000 },
      { startMs: 5000, endMs: 15_000 },
    ];
    // 文案只说一段（人一次只能修一处），视觉另按 filter 全标；语义固化在此
    expect(assessDraft({ startMs: 10_000, endMs: 50_000 }, others)).toEqual({
      kind: 'overlap',
      with: others[0],
    });
  });
});
