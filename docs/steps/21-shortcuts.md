# E7 · 快捷键

**做什么**：空格播放 / I·O 打点 / Delete 删除选中 / 方向键微调。

**依赖**：E1、E5

**预计**：0.5 小时（含 O1b 与 O4/O5 两处债务，见下）

---

## 这一步必须顺带还两笔债

INDEX 的「未修项」表里写着两行，都指向 E7：

### O1b · 键盘删除会绕过 `disabled`

`SegmentList` 的行身份靠本地 `pendingId` + 一个修补型 effect 兜着。
这在鼠标路径下没问题——`busy` 时按钮全 `disabled`，点不到第二行。
但**键盘不经过按钮**：`Delete` 直接触发删除，`pendingId` 与真实待删行就会脱节，
表现为「删除中…」出现在错误的行上。

所以 E7 必须先把 `deleting: boolean` 改成 `deletingId: string | null`：
行身份由 Workbench 持有，`SegmentList` 不再自己维护一份。

### O4 / O5 · 下标当身份

`onCommit(draft, replacedIndex)` 用下标，而删除允许在拖拽中完成：

- **O4**：删掉 index 0 的片段后，index 1 现在指向别人
- **O5**：删掉正在被拖的那一段再松手，`segments[index]` 已被删 → 提交带一个不存在的 `replaces` → 404

键盘删除让这两个窗口从「双指操作才触发」变成「另一个键就能触发」，必须在 E7 内修。

修法：`onCommit` 的第二个参数改成 `replacedId: string | null`。
Timeline 在 `pointerdown` 时拿到的 `segment` 本来就带 id，不用额外查。

---

## 键位

| 键 | 行为 |
|---|---|
| `Space` | 播放 / 暂停 |
| `I` | 把当前播放头设为入点 |
| `O` | 如果有入点：设为出点并创建片段；没有入点：什么都不做 |
| `Delete` / `Backspace` | 删除选中片段 |
| `Escape` | 取消拖拽；没有拖拽时清除入点 |
| `←` / `→` | 播放头 −1s / +1s（按住 Shift 时 ±100ms） |

### 为什么 I/O 是「先入后出」而不是「按一次开始、再按一次结束」

后者看起来更简单，但它在「播放中按 I、播到某处按 O」这个最常见的动作里
需要用户精确控制按键时机。先入后出允许：按 I 定住起点 → 随便拖播放头找终点 →
按 O 落点。中间可以反复看，不会误创建。

**O 早于 I 时归一**（`min`/`max`），而不是报错：用户拖回放头再按 O 是常见操作，
提示「出点不能早于入点」只会让人多点一次。

---

## 绝对不能让快捷键在输入框里生效

任务标题、视频文件名、任何 `input` / `textarea` / `contenteditable` 里按空格，
必须正常输入空格，而不是播放视频。

```ts
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
  );
}
```

`contenteditable` 不能漏——富文本编辑器里 `target.tagName` 是 `DIV`。

**还要处理修饰键**：`Ctrl/Cmd/Alt` 组合键一律不拦。
`Ctrl+S`、`Cmd+R` 这些是浏览器/系统的，抢过来会让人以为页面卡死。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/shortcuts.ts` | `isTypingTarget`、`normalizeMarkRange`、`formatShortcutHint` |
| `src/app/tasks/[id]/work/use-shortcuts.ts` | 全局 keydown 绑定 |
| `src/app/tasks/[id]/work/Workbench.tsx` | `deleting` → `deletingId`；`onCommit` 传 id；接入快捷键 |
| `src/app/tasks/[id]/work/Timeline.tsx` | `onCommit` 第二参改 id；入点标记 |
| `src/app/tasks/[id]/work/SegmentList.tsx` | 删除行身份由 props 传入，去掉本地 `pendingId` |
| `tests/shortcuts.test.ts` | 新增 |

---

## 契约（不可改动）

```ts
// lib/shortcuts.ts

/** 焦点在可输入元素里时不处理全局快捷键。 */
export function isTypingTarget(target: EventTarget | null): boolean;

/**
 * 把入点与出点归一成合法区间（min/max）。
 * 两者都存在但长度不足 MIN_SEGMENT_MS 时返回 null。调用方当前**不做提示**：
 * 入点会保留，挪一下播放头再按 O 即可（见 00-INDEX 的 M6）。
 */
export function normalizeMarkRange(
  markInMs: number,
  markOutMs: number,
): { startMs: number; endMs: number } | null;

/** 页脚展示的键位提示，测试用它锁住文案不漂移。 */
export const SHORTCUT_HINTS: ReadonlyArray<{ keys: string; label: string }>;
```

```ts
// use-shortcuts.ts
export function useShortcuts(args: {
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  selectedId: string | null;
  /** 整数毫秒，与时间轴同一把尺子（不用 video.duration，见下） */
  durationMs: number;
  /** 微调播放头复用既有 seek，否则 currentMs 不更新、时间码停在旧值 */
  onSeek: (ms: number) => void;
  onDeleteSelected: () => void;
  onCreateFromMarks: (range: { startMs: number; endMs: number }) => void;
  onEscape: () => void;
}): { markInMs: number | null; clearMark: () => void };
```

```ts
// Timeline 的 onCommit 签名变更（O4/O5）
onCommit: (draft: Segment, replacedId: string | null) => void;
```

---

## 实现要点

### 1. 快捷键要绑在 `window` 上，但要能整体关掉

```ts
useEffect(() => {
  if (!enabled) return;
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [enabled, ...]);
```

`enabled` 为 false 时不绑——任务已提交（只读）时不该还能按 Delete。

### 2. 空格必须 `preventDefault`

不拦的话，浏览器会滚动页面。标注员按空格想播放，结果页面滚下去了。

### 3. `keydown` 用 `event.code` 还是 `event.key`

用 `event.key` 判字母（`'i'` / `'o'`），大小写要统一 `toLowerCase()`——
否则 CapsLock 开着时 I/O 失效。用 `event.code === 'Space'` 判空格（`key` 的值是 `' '`，不好读）。

### 4. I/O 打点的顺序在 ref 里，不在 state 里

`onCreateFromMarks` 是异步的（要发请求）。如果在回调里读 state 的 `markInMs`，
可能读到旧值。用 ref 存，回调读 ref。

### 5. 入点要画在时间轴上

只存状态不画的话，用户按了 I 没有任何反馈，会怀疑没生效。

画一条竖线（`--color-warn`），与播放头区分开。

### 6. `deleting` 改 `deletingId` 后，`SegmentList` 不再自己记

```tsx
// 传下去，而不是组件内部再存一份
deletingId: string | null;
```

这样键盘删除和鼠标删除走同一份行身份，O1b 才算真修。

---

## 验收

**自动**

- [ ] `isTypingTarget`：`input` / `textarea` / `select` / `contenteditable` 返回 true；`div` / `button` / `body` / `null` 返回 false
- [ ] `normalizeMarkRange(3000, 5000)` → `{3000, 5000}`
- [ ] `normalizeMarkRange(5000, 3000)` → `{3000, 5000}`（归一）
- [ ] `normalizeMarkRange(1000, 1050)` → `null`（不足最小长度）
- [ ] 现有 461 例全绿

**手工**

- [ ] 空格播放/暂停，页面不滚动
- [ ] 在任务标题里按空格 → 输入空格，视频不播
- [ ] 按 I → 时间轴出现入点竖线
- [ ] 按 O → 创建片段，入点竖线消失
- [ ] 先按 O → 无反应
- [ ] 播放头移到入点之前再按 O → 区间自动归一，创建成功
- [ ] Delete 删除选中片段
- [ ] 无选中时按 Delete → 无反应
- [ ] 删除在途时按 Delete → 「删除中…」出现在正确的行（O1b）
- [ ] 拖拽中按 Escape → 取消拖拽

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 不判 `isTypingTarget` | 输入标题时按空格，视频开始播 |
| 漏 `contenteditable` | 富文本里快捷键全部生效 |
| 不拦修饰键 | `Ctrl+R` 被吃掉，用户以为页面卡死 |
| 空格不 `preventDefault` | 按空格播放的同时页面滚动 |
| 用 `event.key` 判空格 | `' '` 可读性差，容易写成 `'Space'` 而失效 |
| I/O 用 state 而非 ref | 异步回调读到旧入点 |
| 入点不画在时间轴上 | 用户以为按键没生效 |
| `deleting` 仍用布尔 | 键盘删除时「删除中…」落在错行（O1b） |
| `onCommit` 仍传下标 | 拖拽中删除 → 404（O4/O5） |

---

## 完成后

```bash
git add -A && git commit -m "feat(E7): 快捷键，并还 O1b/O4/O5 三笔债"
```

**下一步**：E8 只读回顾（已提交任务的查看模式）。注意 E5 的 GET 对 submitted 返回 409，
不能复用。
