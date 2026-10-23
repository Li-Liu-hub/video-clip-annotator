# E2 · 时间轴渲染

**做什么**：在视频下方画一条轨道，把已标注的片段画成色块，播放头跟着视频走。

**依赖**：E1

**预计**：1 小时

**这是整个项目视觉上最关键的一块**——用户一眼看到的就是这条轨道。

---

## 三个技术决定

### 1. 播放头用 `requestAnimationFrame` 直接改 DOM

`timeupdate` 大约每 250ms 触发一次，用它驱动播放头会看到明显的跳跃。
但也不能用一个每帧 `setState` 的组件——那会让整个工作台（含 `<video>`）
每秒重渲染 60 次。

正确做法：

```tsx
useEffect(() => {
  let raf = 0;
  const tick = () => {
    const video = videoRef.current;
    const head = headRef.current;
    if (video && head && Number.isFinite(video.duration) && video.duration > 0) {
      head.style.left = `${(video.currentTime / video.duration) * 100}%`;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}, [videoRef]);
```

React 全程不参与，只有那个 div 的 `style.left` 在变。

**时间文本仍然用 `timeupdate`**：4Hz 对「00:03」这种显示足够，
没必要为它开 60 帧。

### 2. 坐标映射必须用无 padding 的内层元素

点击轨道要换算成时间：

```ts
const rect = trackRef.current.getBoundingClientRect();
const ratio = (event.clientX - rect.left) / rect.width;
const ms = ratio * durationMs;
```

`getBoundingClientRect()` 返回的是**含 padding 与 border** 的盒子。
如果轨道元素有 `padding: 8px`，那么 `rect.left` 是 padding 外沿，
用户点在轨道最左边时算出来的 `ratio` 不是 0。

所以测量必须指向一个**没有内边距的内层 track**，外层容器只管留白。

### 3. 色块用百分比定位，不用像素

```tsx
style={{ left: `${(seg.startMs / durationMs) * 100}%`, width: `${((seg.endMs - seg.startMs) / durationMs) * 100}%` }}
```

用像素的话，窗口 resize 时要重算全部色块，还得监听 `ResizeObserver`。
百分比让 CSS 自己做这件事。

**副作用**：极短的片段（200ms 在 42 分钟的视频里）宽度会趋近 0，看不见。
用 `minWidth: 2px` 兜住——宁可视觉上略微失真，也不能让用户以为那里没标。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/app/tasks/[id]/work/Timeline.tsx` | 时间轴组件 |
| `src/app/tasks/[id]/work/Workbench.tsx` | 接入 Timeline，管理 segments 状态 |
| `tests/timeline-scale.test.ts` | 刻度与映射的纯函数部分 |

---

## 契约（不可改动）

### `src/lib/timeline-scale.ts`（新建，纯函数）

```ts
/** 依据总时长选刻度步长，目标是屏幕上出现 8~12 个刻度。 */
export function pickTickStepMs(durationMs: number): number;

/** 生成刻度位置（毫秒），含 0，不含终点。 */
export function buildTicks(durationMs: number): number[];

/** 像素位置换算成时间，结果钳制在 [0, durationMs] 内。 */
export function ratioToMs(ratio: number, durationMs: number): number;
```

`pickTickStepMs` 从 `[1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000]`
里选第一个**使刻度数不超过 12** 的值；都不满足则返回最后一个。

### `Timeline.tsx`

```tsx
type TimelineProps = {
  durationMs: number;
  segments: Segment[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onSeek: (ms: number) => void;
};
```

---

## 页面要求

```
┌──────────────────────────────────────────────────────┐
│ 00:00    00:03    00:06    00:09    00:12    00:15   │  ← 刻度
│ ┌──────────────────────────────────────────────────┐ │
│ │  ████      ██████        ███                     │ │  ← 片段色块
│ │        │                                          │ │  ← 播放头
│ └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

- 轨道高 48px，`--color-panel-2` 底，圆角 6px
- 色块 `--color-accent-2`，圆角 3px，高度 70%，垂直居中
- 色块 hover 时提亮，`title` 显示 `00:03 – 00:08 · 5.0s`
- 播放头 2px 宽，`--color-ink`，贯穿轨道上下，顶部一个小三角
- 刻度文字 10px，`--color-ink-faint`，`tnum`
- 点击轨道任意位置 → seek 到该位置
- 底部时间轴占位块删掉（E1 的临时占位已被它取代）
- **E1 的临时 `<input type="range">` 删掉**

---

## 临时数据（E4 之前）

工作台还没有片段数据的来源（片段 CRUD 是 E4）。E2 用本地 state：
初始为空，URL 带 `?demo=1` 时注入三条示例片段，用来验证渲染。

```ts
const DEMO_SEGMENTS: Segment[] = [
  { startMs: 1200, endMs: 4600 },
  { startMs: 7200, endMs: 12800 },
  { startMs: 15400, endMs: 17200 },
];
```

**代码里必须标注**：`// E4 接入真实片段后删除`。
并在 `docs/steps/00-INDEX.md` 的 E4 行记一笔，免得忘了。

---

## 验收

**自动**

- [ ] `pickTickStepMs(30_000)` 返回 `5000`（6 个刻度）
- [ ] `pickTickStepMs(2_565_000)`（42 分钟）返回 `300000`（8.5 个，取整 9 个）
- [ ] `pickTickStepMs(1000)` 返回 `1000`
- [ ] `buildTicks(30_000)` 返回 `[0, 5000, 10000, 15000, 20000, 25000]`（不含 30000）
- [ ] `ratioToMs(0, x)` 返回 0；`ratioToMs(1, x)` 返回 x
- [ ] `ratioToMs(-0.5, 30000)` 返回 0（负比例钳制）
- [ ] `ratioToMs(1.5, 30000)` 返回 30000（溢出钳制）
- [ ] 现有 356 例全绿

**手工**

- [ ] 进工作台，轨道显示刻度，播放头在左端
- [ ] 点播放，播放头平滑移动（不是一跳一跳）
- [ ] 点轨道中间，视频跳到中间
- [ ] `?demo=1` 时看到三个色块
- [ ] 拖动浏览器窗口改变宽度，色块与播放头比例保持正确
- [ ] 用 42 分钟的 `pusht-pushblock.mp4` 建任务，刻度合理不拥挤

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 用 `timeupdate` 驱动播放头 | 只在 4Hz 更新，播放头一跳一跳 |
| 每帧 `setState(currentMs)` | 整个工作台 60fps 重渲染，视频卡顿 |
| 用含 padding 的盒子算坐标 | 点击位置整体偏移，点开头跳到 3% 处 |
| 色块用 px 定位 | 窗口 resize 后全部错位 |
| 极短片段不设 `minWidth` | 用户看到空白，以为没标上 |
| `rAF` 的 cleanup 忘记 `cancelAnimationFrame` | 切任务后旧循环还在跑，内存与 CPU 双涨 |
| `duration` 为 0 时做除法 | `left: NaN%`，播放头消失 |

---

## 实测记录

| # | 场景 | 结果 |
|---|---|---|
| 1 | 工作台页面（`?demo=1`） | 200 |
| 2 | 刻度 SSR 输出 | `00:00 00:05 00:10 00:15 00:20 00:25`（30 秒视频，5 秒步长，6 个） |
| 3 | E1 的临时 `<input type="range">` | 已删除（页面中匹配数为 0） |
| 4 | 底部占位「时间轴（下一版）」 | 已删除 |

色块与播放头是客户端渲染，`curl` 拿不到，靠代码审查确认：
色块用百分比 + `minWidth: 2`，播放头 `w-0.5` + `pointer-events-none` + 顶部小三角。

## 一处比文档更正确的实现

文档的示例代码用 `video.duration` 作分母，实现改成了 `durationMs`：

```ts
head.style.left = `${((video.currentTime * 1000) / durationMs) * 100}%`;
```

两个理由：

1. **色块按 `durationMs` 定位，播放头必须用同一把尺子**。混用两个来源，
   服务端记录的时长与浏览器解析的时长只要差一点，播放头就会与色块错位。
2. `moov` 在文件尾的 mp4 读到的 `video.duration` 可能是 `Infinity`，
   此时按它算会得到 `NaN%`，播放头直接消失——而这份素材就在仓库里。

## 完成后

```bash
git add -A && git commit -m "feat(E2): 时间轴渲染，播放头用 rAF 直写 DOM"
```

**下一步**：E3 拖拽创建与调整区间。
