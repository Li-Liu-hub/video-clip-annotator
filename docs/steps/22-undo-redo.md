# E8 · 撤销与重做（草稿态）

**做什么**：`Ctrl+Z` 撤回上一步片段改动，`Ctrl+Shift+Z` 重做。

**依赖**：E5、E8a

**预计**：1 小时

---

## 难点不在栈，在「服务端也要跟着回退」

片段不是纯前端状态——每一次改动都已经落库（E4）。所以撤销不能只改本地数组，
否则刷新一下就回来了，而用户以为已经撤回了。

但也不能简单地「把整个任务重置成快照」：服务端没有这样的接口，
只能通过 `POST /segments` 与 `DELETE /segments/:id` 逐条调整。

于是撤销 = **算出「当前」与「目标」的差，再按差调接口**。

---

## 历史栈存区间，不存 id

这是本功能最关键的一个决定。

E4 的替换是「先删后插」，**片段 id 会变**：

```
拖动 [1000, 5000) → DELETE 旧行 → INSERT 新行（新 id）
```

如果历史栈存的是 `SegmentRow[]`（带 id），那么：

1. 撤销一次 → 按 id 调接口 → 服务端又生成一批新 id
2. 栈里下一层的 id 全部失效
3. 再按一次 `Ctrl+Z` → 404

所以栈里存**区间集合**（`{startMs, endMs}[]`），应用时按区间对齐：

```ts
// 当前有、目标没有 → 删
// 目标有、当前没有 → 建
// 两边都有（区间完全相同）→ 不动
```

片段之间互不重叠（触发器保证），所以区间就是天然的唯一键。

---

## 什么算「一步」

只在**服务端确认成功之后**记一步，且记的是**操作前**的状态：

| 操作 | 成功后的动作 |
|---|---|
| 拖拽创建 | 把操作前的区间集合压入 undo 栈 |
| 拖拽平移/调边（替换） | 同上 |
| 删除片段 | 同上 |
| 打字创建（I/O） | 同上 |

**失败的操作不记步**——请求被拒（重叠、太短）时状态没变，
记一步只会让用户按 `Ctrl+Z` 看到"无事发生"。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/history.ts` | `diffIntervals`、栈操作（纯函数） |
| `src/lib/segment-payload.ts` | 接口响应解析（POST 单条 / GET 列表 / 错误文案），从 Workbench 抽出 |
| `src/app/tasks/[id]/work/use-history.ts` | 栈状态 + 应用差异 |
| `src/app/tasks/[id]/work/Workbench.tsx` | 接入；四处改动后记步 |
| `src/app/tasks/[id]/work/use-shortcuts.ts` | `Ctrl+Z` / `Ctrl+Shift+Z` |
| `tests/history.test.ts` | 新增 |

---

## 契约（不可改动）

```ts
// lib/history.ts
export type Interval = { startMs: number; endMs: number };

/** 把当前状态变成目标状态，需要哪些写操作。按区间对齐，与 id 无关。 */
export function diffIntervals(
  current: readonly Interval[],
  target: readonly Interval[],
): { toDelete: string[]; toCreate: Interval[] };

/**
 * 历史栈。栈里每一项都是「某一时刻的完整区间集合」。
 * limit 用于限制深度，超出的从底部丢弃。
 */
export type History = { past: Interval[][]; future: Interval[][] };
export const HISTORY_LIMIT = 50;

export function pushHistory(history: History, before: readonly Interval[]): History;
export function undo(history: History, current: readonly Interval[]): { next: History; restore: Interval[] | null };
export function redo(history: History, current: readonly Interval[]): { next: History; restore: Interval[] | null };
export function canUndo(history: History): boolean;
export function canRedo(history: History): boolean;
```

```ts
// use-history.ts
export function useHistory(args: {
  /** 每次写操作成功、状态已更新后调用，传入操作前的区间集合 */
  record: (before: readonly Interval[]) => void;
}): {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** 正在回退时禁用输入 */
  busy: boolean;
};
```

---

## 实现要点

### 1. `diffIntervals` 的删除项要返回 id

契约里 `toDelete` 是 `string[]`（片段 id），因为它要传给 DELETE 接口。
所以函数签名要能拿到 id：实际实现里 `current` 用 `SegmentRow[]`，`target` 用 `Interval[]`。

> 这条与契约标题的 `Interval[]` 有出入，以「删除必须按 id」为准，
> 实现时用 `readonly SegmentRow[]` 作为 `current`。文档这里的 `Interval` 泛指。

### 2. 撤销是异步的，必须串行

一次撤销可能产生多个请求（删两条、建一条）。它们必须**串行**执行，
且期间禁止新的编辑动作——否则用户在中途拖一下，diff 就算错了。

`busy` 时：`commitSegment` / `removeSegment` 入口 return，快捷键里的写键也失效。

### 3. 撤销完成后重新拉取，不要自己拼

```ts
// 应用完 diff 之后
const res = await fetch(`/api/tasks/${task.id}/segments`);
const { segments } = await res.json();
applySegments(segments);
```

自己按 diff 拼本地数组的话，id 与 `label` 都会和服务端对不上；
而撤销本来就是低频操作，多一次请求换一份真值，值得。

### 4. 栈里存的是「操作前」

`pushHistory(history, before)` —— before 是操作**之前**的区间集合。

于是 `undo` 的第一步就是「回到 before」，而不是「回到上一步之后」。

这个约定容易搞反，测试里要用一个能区分方向的三段序列锁住
（A → B → C，撤销一次应回到 B 的形态，不是 A）。

### 5. `Ctrl+Z` 不拦输入框

在输入框里按 `Ctrl+Z` 应该是浏览器/输入法的撤销，不是片段的。
`isTypingTarget` 已有，直接复用。

### 6. 只读任务禁用

`readOnly` 时 `canUndo` 恒 false，且不绑快捷键。

---

## 验收

**自动**

- [ ] `diffIntervals([a,b], [a])` → `{ toDelete: [b.id], toCreate: [] }`
- [ ] `diffIntervals([a], [a,b])` → `{ toDelete: [], toCreate: [b] }`
- [ ] `diffIntervals([a], [a'])`（区间变了）→ 删 a、建 a'
- [ ] `diffIntervals([], [])` → 两者皆空
- [ ] `pushHistory` 超过 `HISTORY_LIMIT` 时丢弃最旧的一项
- [ ] `undo` 空栈返回 `restore: null`
- [ ] 三段序列 A→B→C，`undo` 一次得到 B（不是 A）——锁住「存操作前」的方向
- [ ] `redo` 在 `undo` 之后可用，`redo` 后 `future` 清空
- [ ] 新的写操作会清空 `future`
- [ ] 现有 481 例全绿

**手工**

- [ ] 拖一个片段 → `Ctrl+Z` → 回到原位（刷新后也是原位）
- [ ] 再 `Ctrl+Shift+Z` → 又回到新位置
- [ ] 连续创建三段 → 连按三次 `Ctrl+Z` → 逐段消失
- [ ] 撤销到底后再按 `Ctrl+Z` → 无反应、无报错
- [ ] 在任务标题输入框里按 `Ctrl+Z` → 不触发片段撤销
- [ ] 只读任务按 `Ctrl+Z` → 无反应
- [ ] 撤销进行中拖拽 → 不产生请求

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 历史栈存 `SegmentRow[]`（带 id） | 撤销一次后 id 全变，第二次撤销 404 |
| 撤销只改本地数组 | 刷新就回来，用户以为撤销了 |
| 撤销后自己拼数组 | id/label 与服务端不一致 |
| 撤销途中允许编辑 | diff 基于的 current 已失效，算错 |
| 栈里存「操作后」 | 撤销一步等于没动，两步才退回 |
| 不拦输入框 | 输入框里按 Ctrl+Z 把片段撤了 |
| 失败的操作也记步 | 按 Ctrl+Z 出现「无事发生」 |

---

## 完成后

```bash
git add -A && git commit -m "feat(E8): 撤销与重做，历史栈存区间不存 id"
```

**下一步**：F1 提交事务。
