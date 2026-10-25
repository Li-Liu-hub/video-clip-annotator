/**
 * E8 撤销 / 重做的纯函数契约：区间差异、历史栈方向与深度。
 *
 * 重点是「栈里存操作前」这条方向约定 —— 存反了照样能撤销，只是撤销一步等于没动，
 * 界面上看不出错。三段序列 A→B→C 是唯一能把它锁死的用例。
 */
import { describe, expect, it } from 'vitest';
import {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  diffIntervals,
  pushHistory,
  redo,
  undo,
  type History,
  type HistoryInterval,
} from '@/lib/history';
import type { SegmentRow } from '@/lib/services/segment-service';

const EMPTY: History = { past: [], future: [] };

function at(startMs: number, endMs: number, label: string | null = null): HistoryInterval {
  return { startMs, endMs, label };
}

/** 服务端行：diff 的 current 必须带 id（DELETE 只认 id）。 */
function row(id: string, startMs: number, endMs: number): SegmentRow {
  return { id, startMs, endMs, label: null };
}

/** 三段互不重叠的区间，A ⊂ B ⊂ C，用来模拟连续三次创建。 */
const A = [at(0, 1000)];
const B = [at(0, 1000), at(2000, 3000)];
const C = [at(0, 1000), at(2000, 3000), at(4000, 5000)];

/** 依次建出 A、B、C：每次成功后记录的是**操作前**的集合。 */
function afterThreeWrites(): History {
  return pushHistory(pushHistory(pushHistory(EMPTY, []), A), B);
}

describe('diffIntervals：按区间对齐，与 id 无关', () => {
  it('当前多出一段时，删除项是被删那一段的 id', () => {
    expect(diffIntervals([row('a000000000000001', 0, 1000), row('b000000000000002', 1000, 2000)], A)).toEqual({
      toDelete: ['b000000000000002'],
      toCreate: [],
    });
  });

  it('目标多出一段时，只建这一段，不碰已有区间', () => {
    expect(diffIntervals([row('a000000000000001', 0, 1000)], B)).toEqual({
      toDelete: [],
      toCreate: [at(2000, 3000)],
    });
  });

  it('区间变了就是先删后建：id 会变，所以只能按区间认', () => {
    expect(diffIntervals([row('a000000000000001', 0, 1000)], [at(0, 1500)])).toEqual({
      toDelete: ['a000000000000001'],
      toCreate: [at(0, 1500)],
    });
  });

  it('两边都空时没有任何写操作', () => {
    expect(diffIntervals([], [])).toEqual({ toDelete: [], toCreate: [] });
  });

  it('同区间不同 id 视为同一段，不做任何写入', () => {
    expect(diffIntervals([row('ffffffffffffffff', 0, 1000)], A)).toEqual({ toDelete: [], toCreate: [] });
  });
});

describe('pushHistory / undo：栈里存的是「操作前」', () => {
  it('三段 A→B→C 之后撤销一次，回到 B 而不是 A', () => {
    // 若实现存的是「操作后」，栈顶就是 C，撤销一步等于没动 —— 这条会红
    expect(undo(afterThreeWrites(), C).restore).toEqual(B);
  });

  it('连续撤销两次，第二次回到 A', () => {
    const first = undo(afterThreeWrites(), C);
    expect(undo(first.next, B).restore).toEqual(A);
  });

  it('撤销空栈返回 restore: null，调用方连请求都不该发', () => {
    expect(undo(EMPTY, C).restore).toBeNull();
  });

  it('撤销一次会把当前状态放进 future，供重做取回', () => {
    expect(undo(afterThreeWrites(), C).next.future).toEqual([C]);
  });

  it('历史栈只保留 HISTORY_LIMIT 层', () => {
    let history = EMPTY;
    for (let i = 0; i <= HISTORY_LIMIT; i += 1) history = pushHistory(history, [at(i, i + 1)]);
    expect(history.past).toHaveLength(HISTORY_LIMIT);
  });

  it('超过深度上限时丢弃的是最旧的一层', () => {
    let history = EMPTY;
    for (let i = 0; i <= HISTORY_LIMIT; i += 1) history = pushHistory(history, [at(i, i + 1)]);
    expect(history.past[0]).toEqual([at(1, 2)]);
  });

  it('栈里存的是快照，调用方事后改动自己的数组不影响历史', () => {
    const before = [at(0, 1000)];
    const history = pushHistory(EMPTY, before);
    before.push(at(2000, 3000));
    expect(history.past[0]).toEqual([at(0, 1000)]);
  });
});

describe('redo / canUndo / canRedo', () => {
  it('撤销之后重做，恢复的是撤销前的形态', () => {
    const undone = undo(afterThreeWrites(), C);
    expect(redo(undone.next, B).restore).toEqual(C);
  });

  it('重做之后 future 清空：再按下 Ctrl+Shift+Z 不应重复回放同一层', () => {
    const undone = undo(afterThreeWrites(), C);
    expect(redo(undone.next, B).next.future).toEqual([]);
  });

  it('重做空栈返回 restore: null', () => {
    expect(redo(EMPTY, C).restore).toBeNull();
  });

  it('新的写操作会清空 future：重做分支已被这次编辑覆盖', () => {
    const undone = undo(afterThreeWrites(), C);
    expect(pushHistory(undone.next, B).future).toEqual([]);
  });

  it('初始栈既不能撤销也不能重做', () => {
    expect([canUndo(EMPTY), canRedo(EMPTY)]).toEqual([false, false]);
  });

  it('记一步之后可以撤销、还不能重做', () => {
    const history = pushHistory(EMPTY, A);
    expect([canUndo(history), canRedo(history)]).toEqual([true, false]);
  });

  it('撤销一步之后可以重做', () => {
    expect(canRedo(undo(pushHistory(EMPTY, A), A).next)).toBe(true);
  });
});

describe('历史栈只存区间与标签，不存 id', () => {
  it('快照不含 id —— 否则撤销一次换 id 后，下一层全失效', () => {
    // E4 的替换是「先删后插」，id 会变。栈里一旦带了 id，
    // 撤销一次之后，栈中其余各层的 id 全部指向不存在的行。
    const rows = [
      { id: 'c000000000000001', startMs: 0, endMs: 1_000, label: '有效操作' },
      { id: 'c000000000000002', startMs: 2_000, endMs: 3_000, label: null },
    ];
    const history = pushHistory({ past: [], future: [] }, rows);

    expect(history.past[0][0]).not.toHaveProperty('id');
  });

  it('快照保留 label：删除后撤销要靠它把标签带回去', () => {
    // 被删的那一行已经不存在，没有「被替换项」可以继承 —— 标签只能存在栈里
    const rows = [{ id: 'c000000000000001', startMs: 0, endMs: 1_000, label: '有效操作' }];
    const history = pushHistory({ past: [], future: [] }, rows);

    expect(history.past[0][0].label).toBe('有效操作');
  });
});

describe('diffIntervals 带回标签', () => {
  it('目标里新出现的段，toCreate 带着它的 label', () => {
    const { toCreate } = diffIntervals([], [at(0, 1_000, '有效操作')]);
    expect(toCreate).toEqual([at(0, 1_000, '有效操作')]);
  });

  it('删除后撤销：restore 里的标签可用于重建', () => {
    // 先有一段带标签的，删除后撤销
    const history = pushHistory(EMPTY, [at(0, 1_000, '有效操作')]);
    const step = undo(history, []);
    expect(step.restore).toEqual([at(0, 1_000, '有效操作')]);
  });
});
