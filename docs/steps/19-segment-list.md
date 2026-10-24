# E5 · 片段列表

**做什么**：右侧栏从「还没有片段」变成真正的列表——序号、时间、时长、删除按钮，
点击选中联动视频与时间轴。

**依赖**：E2、E4

**预计**：0.5 小时

---

## 一个必须先说清的问题：选中态用 id，不用 index

E4 的替换是「先删后插」，**片段 id 会变**：

```
拖动片段 [1000, 5000) → DELETE 旧行 → INSERT 新行（新 id）
```

如果选中态存的是数组下标，拖动第 0 段之后下标 0 仍然存在，
但指向的是另一个片段——用户看到「我选中的那个」和「实际选中」不是同一个。

存 id 就没这个问题：拖动后 id 变了，**选中态跟着新 id 走**（E4 的 POST 返回新 id）。
代价是 `onCommit` 成功回调里要判断「被替换的是不是当前选中项」，是则改选中到新 id。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/app/tasks/[id]/work/SegmentList.tsx` | 列表组件 |
| `src/app/tasks/[id]/work/Workbench.tsx` | 接入选中态、删除、替换后迁移选中 |
| `src/app/tasks/[id]/work/Timeline.tsx` | 选中片段高亮 |

---

## 契约（不可改动）

### `SegmentList.tsx`

```tsx
type Props = {
  segments: SegmentRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  /** 有请求在途时禁用删除按钮，避免连点产生两次 DELETE */
  busy: boolean;
};

export default function SegmentList(props: Props): JSX.Element;
```

### Timeline 新增 prop

```tsx
selectedId?: string | null;
```

选中的片段加一圈描边（`ring-2 ring-ink`），其余不变。

---

## 交互规格

| 操作 | 结果 |
|---|---|
| 点击列表项 | 选中该片段；视频 seek 到 `startMs`；时间轴高亮 |
| 点击时间轴上的色块 | 选中该片段（但不 seek——拖拽优先，点击未过阈值时按 E3 的规则 seek） |
| 点击删除按钮 | 调 DELETE；成功后从数组移除；**选中态迁移到下一项**（无下一项则上一项，都没有则 null） |
| 删除进行中 | 该行按钮显示「删除中…」，全部按钮禁用 |
| 空列表 | 显示「还没有片段。在下方时间轴上拖动即可标注。」 |
| 选中项被拖动（替换） | 选中态迁移到新 id，不丢失 |

---

## 视觉要求

```
┌─────────────────────────────┐
│ 片段                    3   │  ← 标题 + 数量
├─────────────────────────────┤
│ 1  0:01 – 0:05    4.6s   ✕  │  ← 选中：左侧 2px 竖条 + 底色
│ 2  0:07 – 0:12    5.6s   ✕  │
│ 3  0:15 – 0:17    2.0s   ✕  │
└─────────────────────────────┘
```

- 行高 40px，序号用 `tnum` 淡色，时间用 `tnum` 主色，时长用 `tnum` 淡色右对齐
- 删除按钮 `✕` 平时 `opacity-0`，行 hover 或行选中时 `opacity-100`
- 选中行：左侧 3px `--color-accent-2` 竖条 + `--color-panel-2` 底色
- 列表区可滚动（`overflow-y-auto`），标题栏固定
- 有 `label` 时在时间下方显示，没有则不占行高

---

## 实现要点

### 1. 替换成功后迁移选中

```tsx
// onCommit 成功回调
setSegments((prev) => {
  const next = replaces
    ? prev.filter((s) => s.id !== replaces).concat(created)
    : prev.concat(created);
  return next.sort((a, b) => a.startMs - b.startMs);
});
// 被替换的正是当前选中项 → 选中迁移到新 id
if (replaces && selectedId === replaces) setSelectedId(created.id);
```

两件事必须一起做：**选中迁移**与**数组更新**。只做数组更新的话，
`selectedId` 指向一个已经不存在的 id，列表里没有任何行高亮，
用户会以为选中丢了。

### 2. 删除后选中去哪

```tsx
const index = segments.findIndex((s) => s.id === id);
const next = segments.filter((s) => s.id !== id);
// 优先选原位置的下一个（连续删除的常见动作），没有则退回上一个
const fallback = next[index] ?? next[index - 1] ?? null;
```

用删除前的下标去取 `next[index]`，正好是「原位置的下一个」。
没有它就取 `next[index - 1]`（原位置的上一项）。

### 3. 删除要有在途保护

```tsx
const [busy, setBusy] = useState(false);
```

不加的话，连点两次会发两个 DELETE，第二个返回 404（E4 已保证），
用户看到一条莫名其妙的「片段不存在」错误。

### 4. 列表项的 key 必须是 id

```tsx
{segments.map((s, i) => <li key={s.id}>)}
```

用 index 做 key，替换后 React 会复用错误的 DOM 节点，
表现为「删了第 2 行，第 3 行的内容跳到了第 2 行但序号没变」。

### 5. seek 用 `startMs`，不是中点

标注员点列表是为了**看这个片段的开头**，不是看中间。

---

## 验收

**自动**

E5 是纯展示 + 交互，没有新增服务端逻辑。测试重点在纯函数部分：

- [ ] `pickNextSelection(segments, removedId)` 返回原位置的下一个 id
- [ ] 删除最后一项时返回前一项的 id
- [ ] 删除唯一一项时返回 `null`
- [ ] 现有 445 例全绿

> 把这几个判定抽成 `src/lib/segment-selection.ts` 的纯函数，
> 否则「删除后选中去哪」这条规则没有任何测试守着。

**手工**

- [ ] 有三个片段时，列表显示 1/2/3，时间与时长正确
- [ ] 点击第 2 项 → 视频跳到它的起点，时间轴该片段有描边
- [ ] 拖动选中的片段 → 松手后它仍然高亮（选中迁移到新 id）
- [ ] 删除第 2 项 → 第 3 项顶上来并成为选中项
- [ ] 删除唯一一项 → 回到空态
- [ ] 连点删除两次 → 只有一个请求，按钮在第一次点击后禁用
- [ ] 空态文案完整

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 选中态存 index | 拖动后选中指向别的片段 |
| 替换后不迁移选中 | 高亮消失，用户以为选中丢了 |
| 列表 key 用 index | 删除后行内容错位 |
| 删除后不更新选中 | 选中一个不存在的 id，列表全不高亮 |
| 删除无在途保护 | 连点产生 404 错误提示 |
| seek 到中点 | 标注员看不到片段开头 |

---

## 完成后

```bash
git add -A && git commit -m "feat(E5): 片段列表，选中态按 id 迁移"
```

**下一步**：E6 冲突实时反馈（拖拽过程中就变红，而不是松手才知道）。
