# E3 · 拖拽创建与调整区间

**做什么**：在时间轴上拖出片段、拖动两端改边界、拖动中间平移。

**依赖**：E2

**预计**：1.5 小时

**这是全项目交互最复杂的一块，也是测试最难覆盖的一块。**
可测的部分全部下沉到纯函数，组件层只留事件转发。

---

## 四个必须先定死的点

### 1. 用 Pointer Events，不用 Mouse Events

`pointerdown` / `pointermove` / `pointerup` 一套代码同时支持鼠标、触摸板、触屏。
鼠标事件在触屏上不触发，将来要加平板支持就得重写。

配套必须用 `setPointerCapture`：

```ts
element.setPointerCapture(event.pointerId);
```

没有它，手指/鼠标拖出轨道范围后 `pointermove` 就断了，拖拽会「卡住」——
标注员把片段拖到轨道外再松手，界面会停在半途。

### 2. 点击与拖拽靠位移阈值区分

轨道上「点一下」是 seek（E2 已有），「按下并拖动」才是创建。
两者的起点都是 `pointerdown`，只能靠位移判断：

```ts
const DRAG_THRESHOLD_PX = 3;
```

位移小于 3px 就当点击，走 seek；超过才进入拖拽态。
没有这个阈值，任何一次轻微抖动都会在轨道上留下一个 200ms 的碎片。

### 3. 拖拽时暂停播放

拖动过程中播放头继续走，会让标注员一边拖一边看到画面在动，
而且松手后 `currentTime` 已经跑到别处，「拖到当前位置」的预期就落了空。

`pointerdown` 时 `video.pause()`，拖拽结束时**不要自动恢复**——
标注员通常要检查刚标的片段，自动播放反而干扰。

### 4. 拖拽中的草案用 state，提交时才落库

拖拽期间只更新一个 `draft: Segment | null`，不写任何持久层。
松手时才校验并提交（E4 接 API）。

中途放弃（Escape、拖出轨道、长度不足）就丢弃草案，原有数据不动。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/segment-drag.ts` | 纯函数：吸附、钳制、三种拖拽的计算与判定 |
| `src/app/tasks/[id]/work/useSegmentDrag.ts` | 拖拽状态机（事件转发 + 草案状态） |
| `src/app/tasks/[id]/work/Timeline.tsx` | 接入：色块可拖、空白可创建、拖拽预览 |
| `tests/segment-drag.test.ts` | 纯函数用例 |

---

## 契约（不可改动）

### `src/lib/segment-drag.ts`

```ts
import type { Segment } from '@/lib/segment-interval';

/** 拖拽位移小于这个像素数时视为点击，不进入拖拽。 */
export const DRAG_THRESHOLD_PX = 3;

/** 色块左右边缘用于调整边界的热区宽度（像素）。 */
export const EDGE_HIT_PX = 6;

/** 吸附到 SNAP_STEP_MS 的整数倍（SNAP_STEP_MS 来自 lib/interval）。 */
export function snapMs(ms: number): number;

/** 钳制到 [min, max]。 */
export function clampMs(ms: number, min: number, max: number): number;

/**
 * 创建：从锚点拖到当前点。
 * 两端都吸附并钳制到 [0, durationMs]，返回的区间保证 start < end。
 */
export function draftFromDrag(anchorMs: number, currentMs: number, durationMs: number): Segment;

/**
 * 平移：整体移动 deltaMs，长度不变，结果钳制在 [0, durationMs] 内。
 * 触到边界时停止移动，**不缩短长度**。
 */
export function draftFromMove(origin: Segment, deltaMs: number, durationMs: number): Segment;

/**
 * 调整端点：只动一端。
 * start 端不得越过 endMs - MIN_SEGMENT_MS；end 端不得早于 startMs + MIN_SEGMENT_MS。
 */
export function draftFromResize(
  origin: Segment,
  edge: 'start' | 'end',
  deltaMs: number,
  durationMs: number,
): Segment;

/** 草案是否可提交：长度达标且不与 others 中任何一段重叠。 */
export function isAcceptableDraft(draft: Segment, others: readonly Segment[]): boolean;
```

### `useSegmentDrag.ts`

```ts
export type DragState =
  | { kind: 'idle' }
  | { kind: 'pending'; mode: DragMode; originMs: number; startX: number; origin: Segment | null }
  | { kind: 'dragging'; mode: DragMode; draft: Segment };

export type DragMode = 'create' | 'move' | 'resize-start' | 'resize-end';

export function useSegmentDrag(args: {
  trackRef: RefObject<HTMLDivElement | null>;
  durationMs: number;
  segments: readonly Segment[];
  onCommit: (draft: Segment, replacedIndex: number | null) => void;
  onSeek: (ms: number) => void;
}): {
  drag: DragState;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>, hit: Segment | null, hitIndex: number) => void;
};
```

`replacedIndex`：平移或调整端点时是原片段下标，新建时为 `null`。

---

## 状态机

```
pointerdown
    │  记录起点像素、模式、原片段
    ▼
 pending ──── 位移 < 3px 且 pointerup ────▶ idle（走 onSeek）
    │
    │ 位移 >= 3px
    ▼
 dragging ─── pointermove：重算 draft ───▶ dragging
    │
    ├── pointerup 且 isAcceptableDraft ──▶ onCommit → idle
    ├── pointerup 但不合格 ─────────────▶ idle（丢弃草案）
    └── Escape ────────────────────────▶ idle（丢弃草案）
```

**模式判定**（`pointerdown` 落在色块上时）：

| 落点 | 模式 |
|---|---|
| 距左边界 ≤ `EDGE_HIT_PX` | `resize-start` |
| 距右边界 ≤ `EDGE_HIT_PX` | `resize-end` |
| 其余 | `move` |

片段宽度小于 `2 × EDGE_HIT_PX` 时左右热区会重叠——此时**只认 `move`**，
否则极短片段几乎无法平移，一按就变成调整边缘。

---

## 实现要点

### 1. 吸附要作用在「结果」上，不是「增量」上

```ts
// ✓ 先算绝对位置再吸附，边界永远落在整百毫秒上
const next = snapMs(anchorMs + deltaMs);

// ✗ 吸附增量会让累积误差漂移，拖十次后整体偏移
const next = anchorMs + snapMs(deltaMs);
```

### 2. 平移触边不缩短

片段长 5 秒，拖到视频末尾时应该是「停在末尾」而不是「被切成 2 秒」：

```ts
const length = origin.endMs - origin.startMs;
const start = clampMs(origin.startMs + deltaMs, 0, durationMs - length);
return { startMs: start, endMs: start + length };
```

先算 `start` 再推 `end`，长度天然守恒。

### 3. 调整端点不能把片段拖没

```ts
// resize-start
const start = clampMs(origin.startMs + deltaMs, 0, origin.endMs - MIN_SEGMENT_MS);
// resize-end
const end = clampMs(origin.endMs + deltaMs, origin.startMs + MIN_SEGMENT_MS, durationMs);
```

上界用 `endMs - MIN_SEGMENT_MS` 而不是 `endMs`——否则拖到重合就得到零长片段，
再松手会被 `normalizeSegments` 判为 `reversed`，用户看到的是「拖了一下，片段消失了」。

### 4. `pointerup` 时释放捕获

```ts
element.releasePointerCapture(event.pointerId);
```

漏了会怎样：后续的 `pointermove` 继续被这个元素捕获，鼠标在页面上随便移动
都会触发拖拽逻辑。表现为「松手后片段还在跟着鼠标跑」。

`pointercancel` 也要走同样的清理路径（系统手势中断时只发这个，不发 `up`）。

### 5. 坐标换算复用 E2 的内层 track

`clientX` → 毫秒的换算必须与 E2 的点击定位用同一个公式（无 padding 的内层元素）：

```ts
const rect = trackRef.current.getBoundingClientRect();
const ms = clampMs(((clientX - rect.left) / rect.width) * durationMs, 0, durationMs);
```

拖出轨道左右两侧时 `clientX` 会超出 `rect`，所以必须钳制，
否则草案的 `startMs` 会变成负数或超过视频长度。

### 6. 光标反馈

| 位置 | cursor |
|---|---|
| 轨道空白 | `crosshair` |
| 色块中部 | `grab`（拖拽中 `grabbing`） |
| 色块边缘 | `col-resize` |

光标不加的话，标注员不知道「这里可以拖」。

---

## 视觉要求

- 拖拽中的草案块：半透明（`opacity-70`）+ 虚线边框，与已确认的实心色块区分
- 草案不合格时（重叠 / 太短）：边框变红（`--color-danger`）
- 拖拽时在轨道上方浮出时间提示：`00:03.2 – 00:08.5 · 5.3s`，跟着鼠标水平位置走
- 平移/调整时原片段保持可见（草案叠加在它上面）

---

## 验收

**自动**（纯函数部分）

- [ ] `draftFromDrag(1200, 4600, 30000)` → `{1200, 4600}`（都已是整百）
- [ ] `draftFromDrag(1234, 4678, 30000)` → `{1200, 4700}`（吸附到 100ms）
- [ ] `draftFromDrag(5000, 1000, 30000)` → `{1000, 5000}`（反向拖拽归一）
- [ ] `draftFromDrag(-100, 40000, 30000)` → `{0, 30000}`（两端钳制）
- [ ] `draftFromMove({1000, 5000}, 2000, 30000)` → `{3000, 7000}`
- [ ] `draftFromMove({1000, 5000}, -5000, 30000)` → `{0, 4000}`（长度不变，触左边界）
- [ ] `draftFromMove({25000, 29000}, 5000, 30000)` → `{26000, 30000}`（触右边界）
- [ ] `draftFromResize({1000, 5000}, 'start', 1000, 30000)` → `{2000, 5000}`
- [ ] `draftFromResize({1000, 5000}, 'start', 9999, 30000)` → `{4900, 5000}`（留足最小长度）
- [ ] `draftFromResize({1000, 5000}, 'end', -9999, 30000)` → `{1000, 1100}`
- [ ] `draftFromResize({1000, 5000}, 'end', 99999, 30000)` → `{1000, 30000}`（钳到视频末尾）
- [ ] `isAcceptableDraft` 对重叠、太短、合法三种输入分别返回 false/false/true
- [ ] 现有 376 例全绿

**手工**

- [ ] 空白处按下拖动 → 出现虚线草案，松手后成为实心片段
- [ ] 在色块中间拖动 → 整体平移，长度不变
- [ ] 拖到轨道左右边界 → 停在边界，长度不变
- [ ] 拖色块左边缘 → 只改起点；拖右边缘 → 只改终点
- [ ] 拖出轨道外再松手 → 草案被钳制，不会出现负时间或超长片段
- [ ] 点击（不拖）→ 视频跳到该位置，不产生片段
- [ ] 拖拽中视频暂停
- [ ] 重叠加亮红色且松手后不创建
- [ ] Escape 取消拖拽
- [ ] 拖拽后鼠标移开，片段不再跟随

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 用 mouse events | 触屏/触控板失效，将来要重写 |
| 不 `setPointerCapture` | 拖出轨道就断，界面卡在半途 |
| 不 `releasePointerCapture` | 松手后片段还跟着鼠标跑 |
| 不做位移阈值 | 每次点击都留下 200ms 碎片 |
| 吸附作用在增量上 | 累积误差，拖十次整体偏移 |
| 平移用「先改 end 再推 start」 | 触边时长度被切短 |
| resize 上界用 `endMs` 而非 `endMs - MIN_SEGMENT_MS` | 拖到重合，片段消失 |
| 拖拽时视频继续播 | 播放头乱跑，「拖到当前画面」的预期落空 |
| 草案直接写进 segments | 取消拖拽后数据已被污染 |

---

## 完成后

```bash
git add -A && git commit -m "feat(E3): 拖拽创建与调整区间"
```

**下一步**：E4 片段 CRUD API（把 `onCommit` 接到持久层，并删掉 `?demo=1`）。
