# STEP 05 · 标注工作台 ★

**目标**：标注员能在视频上拖出时间段，片段能存能改能删，刷新后还在。

**前置**：04 完成

**预计**：4 小时（**最长的一步，也是最可能超时的一步**）

**这是整个产品的脸面。** 题目明确说「视觉和操作体验都会计分」，值得多花时间。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/app/tasks/[id]/page.tsx` | 页面外壳（Server Component，取数据） |
| `src/components/annotator/Workbench.tsx` | 客户端容器，持有全部状态 |
| `src/components/annotator/VideoPlayer.tsx` | 视频 + 播放控制 |
| `src/components/annotator/Timeline.tsx` | **时间轴（核心组件）** |
| `src/components/annotator/SegmentList.tsx` | 右侧片段列表 |
| `src/lib/services/annotationService.ts` | 片段 CRUD |
| `src/app/api/tasks/[id]/segments/route.ts` | `GET` / `POST` |
| `src/app/api/tasks/[id]/segments/[segId]/route.ts` | `PATCH` / `DELETE` |

---

## 布局

```
┌──────────────────────────────────────────────────────────┐
│ 顶栏  ← 返回   任务标题   状态标签            合计 4 段 18.6s │
├──────────────────────────────────────┬───────────────────┤
│                                      │ 片段列表            │
│         <video> 16:9                 │  1  0:02.1–0:06.4 │
│                                      │  2  0:09.1–0:13.8 │
│                                      │  3  0:19.2–0:24.5 │
├──────────────────────────────────────┤                   │
│ ⏮ ⏯ ⏭   00:12.4 / 00:40.0   🔊        │  [+ 用 I/O 打点]   │
├──────────────────────────────────────┤                   │
│ ▓▓▓▓░░░▓▓▓▓░░░░▓▓▓▓▓░░░░░░░░░░░░      │  [提交]            │
│ 时间轴：选区 + 片段 + 播放头              │                   │
└──────────────────────────────────────┴───────────────────┘
```

---

## 时间轴实现（最核心）

### 坐标换算

```ts
const rect = trackRef.current.getBoundingClientRect();
const toMs = (clientX: number) =>
  Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
const toPct = (ms: number) => `${(ms / duration) * 100}%`;
```

### 拖拽创建

```
mousedown  → 记录 anchorMs，进入 dragging 状态
mousemove  → 更新 draft = [min(anchor, cur), max(anchor, cur)]
mouseup    → 若 draft 长度 ≥ 100ms 且不重叠 → POST 创建；否则丢弃
```

**关键**：`mousemove` / `mouseup` 要挂在 `window` 上而不是元素上，
否则鼠标拖出时间轴外就收不到事件，选区会「粘」在屏幕上。

### 重叠实时反馈（体验分水岭）

拖拽过程中就要判断是否与已有片段重叠：

```ts
const conflict = segments.find(
  (s) => s.startMs < draft.end && s.endMs > draft.start,
);
```

- 有冲突：选区边框转 `bad` 色，显示「与 0:09.1–0:13.8 重叠」，`mouseup` 时不提交
- 无冲突：正常色

**这是「事前阻止」而不是「事后报错」**。用户不会点完提交才发现标错了。

### 播放头

```tsx
<div style={{ left: toPct(currentMs) }} className="absolute top-0 h-full w-px bg-ink/80" />
```

用 `requestAnimationFrame` 或 `timeupdate` 更新。`timeupdate` 每秒只触发 4 次左右，
播放头会一跳一跳的——用 `rAF` 读 `video.currentTime` 更平滑：

```ts
const tick = () => {
  setCurrentMs(video.currentTime * 1000);
  rafRef.current = requestAnimationFrame(tick);
};
```

暂停时要 `cancelAnimationFrame`，否则空转耗电。

---

## 快捷键

```ts
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    const el = document.activeElement;
    // 输入框聚焦时全部失效
    if (el && /INPUT|TEXTAREA|SELECT/.test(el.tagName)) return;

    switch (e.code) {
      case 'Space':  e.preventDefault(); togglePlay(); break;
      case 'KeyI':   setInPoint(currentMs); break;
      case 'KeyO':   if (inPoint != null) createSegment(inPoint, currentMs); break;
      case 'ArrowLeft':  seek(currentMs - (e.shiftKey ? 1000 : 100)); break;
      case 'ArrowRight': seek(currentMs + (e.shiftKey ? 1000 : 100)); break;
      case 'Delete':
      case 'Backspace':  if (selectedId) removeSegment(selectedId); break;
      case 'Escape': clearDraft(); setSelectedId(null); break;
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [currentMs, inPoint, selectedId]);
```

`Space` 必须 `preventDefault()`，否则页面会滚动。
**输入框判断不能省**，否则在「片段标签」输入框里打空格会触发播放。

---

## 撤销 / 重做

用**反向操作栈**，不用全量快照（快照恢复后 id 会变，麻烦）。

```ts
type Op =
  | { type: 'create'; id: string }
  | { type: 'delete'; data: Segment }
  | { type: 'update'; id: string; before: Segment };

const undoStack: Op[] = [];
const redoStack: Op[] = [];
```

| 原操作 | 撤销时执行 | 记入 redo 的反向 |
|---|---|---|
| create | `DELETE /segments/:id` | `{type:'create'}` |
| delete | `POST` 重建（**新 id**） | `{type:'delete', data: 新数据}` |
| update | `PATCH` 回旧值 | `{type:'update', before: 新值}` |

**只支持草稿态**（`claimed` / `rejected`）。已提交的任务不能编辑，自然也不需要撤销。

栈上限 50 条，超出丢弃最早的。

---

## 自动保存

没有「保存草稿」按钮。每次增删改立即调 API：

```ts
async function createSegment(startMs: number, endMs: number) {
  const optimistic = { id: `tmp-${nanoid()}`, startMs, endMs };
  setSegments((prev) => [...prev, optimistic]);        // 乐观更新
  try {
    const saved = await api.createSegment(taskId, { startMs, endMs });
    setSegments((prev) => prev.map((s) => (s.id === optimistic.id ? saved : s)));
  } catch (err) {
    setSegments((prev) => prev.filter((s) => s.id !== optimistic.id));  // 回滚
    toast(err.message);
  }
}
```

乐观更新 + 失败回滚，用户感觉是瞬时的。**回滚必须做**，否则界面上会出现不存在的片段。

---

## 验收标准

- [ ] 视频能播，拖动进度条正常（走 206）
- [ ] 在时间轴拖拽：出现选区预览，松手创建片段
- [ ] 拖到与已有片段重叠：选区变红，提示具体冲突对象，松手不创建
- [ ] 拖片段两端能调整，调整到重叠时被拒绝
- [ ] 单击片段：选中 + 播放头跳到入点
- [ ] 片段列表点条目：视频跳转到该片段
- [ ] `空格` 播放暂停、`I`/`O` 打点、`←/→` 微调、`Delete` 删除
- [ ] 在输入框里按空格**不触发**播放
- [ ] 删除后 `Ctrl+Z` 能恢复；恢复后片段仍不重叠
- [ ] 刷新页面，片段还在
- [ ] 用 bob 的账号访问 alice 的任务 → `404`

---

## 容易错的地方

| 陷阱 | 后果 |
|---|---|
| `mousemove` 挂在元素上 | 拖出边界就丢失事件，选区卡住 |
| 用 `timeupdate` 驱动播放头 | 每秒跳 4 次，观感很差 |
| 忘了 `preventDefault()` 空格 | 页面跟着滚动 |
| 快捷键没排除输入框 | 打字触发播放/删除 |
| 乐观更新没回滚 | 界面显示虚假片段，刷新后才消失 |
| `DELETE` 触发器没排除自己（STEP 01） | 改不了任何片段 |
| 时长用 `video.duration` 但视频未加载完 | `NaN`，时间轴宽度算成 0 |

---

## 降级预案

若 3 小时后拖拽仍不稳定，**立刻降级**：

1. 保留 `I` / `O` 键盘打点（最可靠）
2. 片段列表里给两个数字输入框（起止毫秒）
3. 拖拽作为增强，做不完就先关掉

**先保证「能标注」这个功能成立，再追求「好用」。** 数据正确是硬指标，拖拽手感是加分项。

---

## 完成后

M2 达成。此时产品的核心价值已经成立——即使后面全部做砸，这个演示也能看。
