# E6 · 冲突实时反馈

**做什么**：拖拽过程中就把冲突指出来——不是"变红了"，而是"和哪一段撞了"。

**依赖**：E3

**预计**：0.5 小时

---

## 从「合格 / 不合格」到「不合格的原因」

E3 的 `isAcceptableDraft` 只返回布尔值，所以拖拽时只能把草案变红。
用户看到红色，但不知道是太短还是撞了别人，更不知道撞的是哪一段。

E6 把判定细化为一个可区分的结果：

```ts
type DraftVerdict =
  | { kind: 'ok' }
  | { kind: 'too-short' }                 // 短于 MIN_SEGMENT_MS
  | { kind: 'overlap'; with: Segment };   // 撞到了 with 这一段
```

有了 `with`，界面才能同时做三件事：
**草案描边变红** + **撞到的那一段也高亮** + **提示写清是哪个区间**。

`interval.ts` 里的 `findConflict`（A4 就写好了）正好是这一步要找的东西——
它返回第一个冲突的片段，之前一直没被调用过。

---

## 顺带修两个并发窗口

INDEX 的「未修项」表里记着两条，都属于 E 组并发，放在这里一起处理：

### O1 · `commitSegment` 读到过期的 `deleting`

`deleting` 是渲染闭包值。拖拽的 `onCommit` 在 `pointerdown` 那一刻就连同
`segments` 一起被 `useCallback` 捕获；若手势先于删除开始（触屏两指、按住鼠标时
另一只手按 Enter），`if (deleting) return` 读到的是过期的 `false`，
仍会发出一个注定 404 的 POST。

### O2 · `committing` 之间没有互斥

同一片段在 RTT 内连拖两次，第二次带着已经失效的 id，同样 404。

### 修法：入口守卫读 ref，不读 state

```ts
const deletingRef = useRef(false);
const committingRef = useRef(false);

// 置位时同时写两处：state 负责渲染，ref 负责同步判断
function setDeleting(next: boolean) {
  deletingRef.current = next;
  setDeletingState(next);
}
```

入口判断用 ref ——它在事件回调里是同步可见的，不受渲染时机影响。

**为什么不干脆全用 ref**：`busy` 要驱动按钮禁用，必须有 state 触发渲染。
两个都要，且必须同时更新，否则又是一处「两个真源」。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/segment-drag.ts` | 新增 `assessDraft`，`isAcceptableDraft` 改为委托它 |
| `src/app/tasks/[id]/work/use-segment-drag.ts` | overlay 增加 `verdict`；`committing` 守卫 |
| `src/app/tasks/[id]/work/Timeline.tsx` | 冲突段高亮、提示文案 |
| `src/app/tasks/[id]/work/Workbench.tsx` | O1/O2 的 ref 守卫 |
| `tests/segment-drag.test.ts` | 新增 4 例 |

---

## 契约（不可改动）

```ts
// segment-drag.ts
export type DraftVerdict =
  | { kind: 'ok' }
  | { kind: 'too-short' }
  | { kind: 'overlap'; with: Segment };

/**
 * 判定草案。比 isAcceptableDraft 多给出「为什么不合格」。
 * 同时违反两条时按「先长度、后重叠」的顺序报 —— 太短的片段谈不上和谁重叠。
 */
export function assessDraft(draft: Segment, others: readonly Segment[]): DraftVerdict;

/** 保留原函数，行为不变（内部委托 assessDraft）。 */
export function isAcceptableDraft(draft: Segment, others: readonly Segment[]): boolean;
```

```ts
// use-segment-drag.ts
export type DragOverlay = {
  ratio: number;
  verdict: DraftVerdict;
  /** 正在被拖的片段 id（新建时为 null），供高亮时排除自身。 */
  movingId: string | null;
};
```

> **`movingId` 是审查后加的**，原契约只有 `{ ratio, verdict }`。
> 理由：平移与调整端点时草案必然压着自己原位，不排除的话用户会看到
> 「我拖自己，自己却变红了」。
>
> **用 id 而不是下标**：拖拽期间数组可能被删除操作改变（删除允许在拖拽中完成），
> 下标会指向另一个片段——表现为「被删的那段消失了，旁边一段凭空变红」。

---

## 视觉要求

| 状态 | 草案 | 冲突段 | 提示文案 |
|---|---|---|---|
| 合格 | 虚线 `border-accent` | 无变化 | `0:03 – 0:08 · 5.0s` |
| 太短 | 虚线 `border-bad` | 无变化 | `太短（至少 0.1s）` |
| 重叠 | 虚线 `border-bad` | `ring-2 ring-bad` | `与 0:05 – 0:12 重叠` |

- 冲突段的高亮要**同时**在时间轴上可见（否则用户得自己找）
- 提示条颜色跟随状态：合格用 `--color-panel-2`，不合格加一点 `--color-bad` 的左边框
- 多个片段同时重叠时只报第一个（`findConflict` 的既有语义），但冲突段高亮要**全部**标出来

> 最后这条是个刻意的取舍：文案只说「第一个」，是因为人一次只能修一处；
> 但视觉上把所有撞到的都标出来，用户才知道这片区域到底有多挤。

---

## 实现要点

### 1. 顺序：先长度，后重叠

```ts
if (draft.endMs - draft.startMs < MIN_SEGMENT_MS) return { kind: 'too-short' };
const conflict = findConflict(others, draft);
if (conflict) return { kind: 'overlap', with: conflict };
return { kind: 'ok' };
```

反过来先判重叠的话，一个 50ms 的草案如果正好落在一段里，会报「重叠」，
而它真正的问题是太短——用户按提示挪开位置，仍然不合格。

### 2. 冲突段高亮要用「所有冲突」，不是「第一个」

```tsx
const conflicted = verdict.kind === 'overlap'
  ? segments.filter((s) => overlaps(s, draft))
  : [];
```

`findConflict` 只返回第一个（给文案用），高亮要 `filter` 出全部。
用 `findConflict` 的结果去高亮的话，用户会以为旁边那段没问题。

### 3. 拖拽中的判定每帧都在算，别做多余的事

`assessDraft` 在 `pointermove` 里调用，60Hz。它只做一次长度比较 + 一次线性扫描，
几十个片段可忽略。**不要**在这条路径上加 `console.log`、`JSON.stringify` 或任何分配。

### 4. 冲突段高亮的层级

草案与冲突段可能重叠。冲突段用 `ring-2 ring-bad`，草案用 `border-dashed`，
两者不冲突；但草案要 `pointer-events-none`（E3 已有），否则拖到冲突段上方时
`pointermove` 命中的是冲突段而不是轨道。

### 5. ref 守卫不替代 state 渲染

```ts
// 入口：用 ref —— 事件回调里同步可见
if (deletingRef.current) return;

// 按钮禁用：用 state —— 必须触发渲染
<SegmentList busy={deleting || committing} />
```

只留 ref 的话按钮永远不禁用；只留 state 的话守卫读的是过期值。两者都要。

---

## 验收

**自动**

- [ ] `assessDraft({1000,1100}, [])` 返回 `{kind:'ok'}`（恰好最小长度）
- [ ] `assessDraft({1000,1050}, [])` 返回 `{kind:'too-short'}`
- [ ] `assessDraft({1000,5000}, [{2000,3000}])` 返回 `{kind:'overlap', with:{2000,3000}}`
- [ ] `assessDraft({1000,2000}, [{2000,3000}])` 返回 `{kind:'ok'}`（首尾相接不算冲突）
- [ ] 草案同时太短且重叠时返回 `too-short`（判据顺序）
- [ ] 撞到多段时 `with` 是数组里第一个匹配的
- [ ] `isAcceptableDraft` 对上述五种输入仍返回与 E3 一致的布尔值
- [ ] 现有 455 例全绿

**手工**

- [ ] 拖到已有片段上 → 草案变红、被撞的那段出现红圈、提示写「与 0:05 – 0:12 重叠」
- [ ] 拖得太短 → 只变红，提示「太短（至少 0.1s）」，无冲突段高亮
- [ ] 拖开后 → 立刻恢复，红圈消失
- [ ] 同时压住两段 → 两段都有红圈，文案只说第一段
- [ ] 删除进行中拖拽 → 不提交（O1）
- [ ] 提交进行中再拖同一段 → 不提交（O2）

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 先判重叠再判长度 | 50ms 的草案报「重叠」，用户挪开位置仍不合格 |
| 只用 `findConflict` 的高亮 | 只标第一段，用户以为旁边没问题 |
| 每帧都 `JSON.stringify` 调试 | 60Hz 分配 + 序列化，拖拽掉帧 |
| 只加 ref 不加 state | 按钮永不禁用 |
| 只加 state 不加 ref | 守卫读到过期值，O1 仍在 |
| 冲突段高亮挡住草案 | 拖到冲突段上方时 `pointermove` 命中错元素 |

---

## 完成后

```bash
git add -A && git commit -m "feat(E6): 冲突实时反馈，并修 O1/O2 两个并发窗口"
```

**下一步**：E7 快捷键（I/O 打点、空格播放、Delete 删除）。
