/**
 * 撤销 / 重做的纯函数：区间差异 + 历史栈。
 *
 * 栈里存区间而非片段行：E4 的替换是「先删后插」，每写一次片段 id 就会变；
 * 存 id 的话撤销一次后栈里下一层全部失效，第二次撤销必然 404。
 * 片段之间互不重叠（触发器保证），区间因此是天然唯一键。
 */
import type { Interval } from '@/lib/interval';
import type { SegmentRow } from '@/lib/services/segment-service';

// 区间语义的唯一实现处是 lib/interval（半开 [start, end)），这里只转出，
// 不另写一份结构相同的类型 —— 两份定义迟早会有一份被改歪。
export type { Interval };

/**
 * 历史栈里的区间：几何两端 + 标签。
 *
 * 标签必须跟着栈走：删除后撤销时被删的那行已经不存在，没有「被替换项」可以继承，
 * 只能由历史自己带回来。匹配仍只比两端（片段不重叠，区间即唯一键），
 * 标签只是随创建一起回放的负载。
 *
 * 不把它塞进 lib/interval 的 Interval：拖拽与重叠判定不该关心展示字段，
 * 两个类型混用会让「几何相等」与「内容相等」变成同一个判断。
 */
export type HistoryInterval = Interval & { label: string | null };

/** 片段互不重叠，区间即唯一键：对齐只比两端，与 id 无关。 */
function sameInterval(a: Interval, b: Interval): boolean {
  return a.startMs === b.startMs && a.endMs === b.endMs;
}

/**
 * 把当前状态变成目标状态需要哪些写操作。
 *
 * current 必须带 id（DELETE 接口只认 id），target 只要区间 + 标签
 * （POST 的 id 由服务端生成）—— 这也是「栈里存区间」的另一半理由。
 */
export function diffIntervals(
  current: readonly SegmentRow[],
  target: readonly HistoryInterval[],
): { toDelete: string[]; toCreate: HistoryInterval[] } {
  return {
    // 当前有、目标没有 → 删
    toDelete: current
      .filter((row) => !target.some((interval) => sameInterval(row, interval)))
      .map((row) => row.id),
    // 目标有、当前没有 → 建；两边完全相同的区间不动（标签不同也不动：
    // 界面没有标签编辑入口，能出现差异只说明历史里带着旧值，不值得为它重建一行）
    toCreate: target.filter((interval) => !current.some((row) => sameInterval(row, interval))),
  };
}

/**
 * 历史栈。栈里每一项都是「某一时刻的完整区间集合」。
 * 存的是一个快照，不与调用方手里的数组共享引用。
 */
export type History = { past: HistoryInterval[][]; future: HistoryInterval[][] };

export const HISTORY_LIMIT = 50;

/** 快照：只留两端与标签。入参可能带着 id，而栈里存的不能带 id（替换会换 id）。 */
function snapshot(intervals: readonly HistoryInterval[]): HistoryInterval[] {
  return intervals.map(({ startMs, endMs, label }) => ({ startMs, endMs, label }));
}

/** 追加一层，超过 HISTORY_LIMIT 时从**底部**丢弃最旧的一层。 */
function appendPast(
  past: readonly HistoryInterval[][],
  entry: HistoryInterval[],
): HistoryInterval[][] {
  const next = [...past, entry];
  return next.slice(Math.max(0, next.length - HISTORY_LIMIT));
}

/**
 * 记一步：before 是操作**之前**的区间集合。
 *
 * 存「操作前」而不是「操作后」，是因为应用时能直接拿到「该回到哪里」；
 * 存「操作后」的话撤销一步等于没动，两步才退回去。
 */
export function pushHistory(
  history: History,
  before: readonly HistoryInterval[],
): History {
  // future 必须清空：它指向的分支已被这次新编辑覆盖，
  // 留着重做会把用户送进一个从未存在过的状态
  return { past: appendPast(history.past, snapshot(before)), future: [] };
}

/**
 * 撤销一层。restore 为 null 表示栈空，调用方连请求都不该发。
 *
 * 栈顶是「操作前」，所以撤销就是回到它本身，而不是再往前取一层。
 */
export function undo(
  history: History,
  current: readonly HistoryInterval[],
): { next: History; restore: HistoryInterval[] | null } {
  const before = history.past[history.past.length - 1];
  // 空数组是真值，这里判的是「根本没有这一层」
  if (!before) return { next: history, restore: null };
  return {
    next: { past: history.past.slice(0, -1), future: [...history.future, snapshot(current)] },
    restore: snapshot(before),
  };
}

/** 重做一层：把当前状态压回 past，取出 future 栈顶作为目标。 */
export function redo(
  history: History,
  current: readonly HistoryInterval[],
): { next: History; restore: HistoryInterval[] | null } {
  const after = history.future[history.future.length - 1];
  if (!after) return { next: history, restore: null };
  return {
    next: { past: appendPast(history.past, snapshot(current)), future: history.future.slice(0, -1) },
    restore: snapshot(after),
  };
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

export function canRedo(history: History): boolean {
  return history.future.length > 0;
}
