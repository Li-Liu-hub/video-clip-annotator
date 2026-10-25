# E8a · 只读回顾

**做什么**：已提交的任务能打开看，但不能改。

**依赖**：E5

**预计**：0.3 小时

---

## 这一步要改一个 E4 时期定下的行为

E4 把「读片段」和「写片段」放进了同一个 `requireWritableTask`，
于是 `GET /api/tasks/:id/segments` 对已提交任务返回 409。
当时 Reviewer 裁决「可接受，但 E5/E8 的只读回顾不能复用它」——**现在就是兑现那句话的时候**。

改法是把状态判断从归属判断里拆出来：

```ts
/** 纯归属：租户 + 是否本人领取。不判状态 —— 状态各有各的出口。 */
function requireOwnedTask(db, actor, taskId): TaskRow

/** 可读：归属 + 状态 ∈ {claimed, submitted}。rejected 按不存在处理（404）。 */
function requireReadableTask(db, actor, taskId): TaskRow

/** 可写：归属 + 状态 === claimed。rejected 的归属成立，所以是 409 不是 404。 */
function requireWritableTask(db, actor, taskId): TaskRow
```

> **为什么 rejected 在读是 404、在写是 409**：退货后 `claimed_by` 仍是本人
> （schema 强制非 pending 必须有归属），所以「归属」这一关它是过的。
> 读路径拒绝它，理由是「退回的任务已回到池子，打开会看到过期数据」——按不存在处理；
> 写路径拒绝它，理由是「状态不允许改」——那是 409。两者不矛盾，是两个不同的问题。

`listSegments` 改用 `requireReadableTask`（归属 + 状态 ∈ `claimed | submitted`），
`upsertSegment` / `deleteSegment` 仍用 `requireWritableTask`（只认 `claimed`）。

**注意**：这一节原本写的是 `requireOwnedTask`（只判归属、不判状态），是错的 ——
照那样实现的话 rejected 任务也能读到片段，与本文件 :162 的验收项直接冲突。

**这不只是加个参数**：`submitted` 任务从此可读，写仍然 409。
E4 那条「已提交的任务列片段抛 StateConflictError」的用例要改成「可以列出来」，
并在 commit message 里写明这是需求驱动的行为变更，不是回归。

---

## 只读模式要禁掉什么

只读不是「看起来不能点」，而是**所有写入路径都断掉**：

| 路径 | 只读时 |
|---|---|
| 时间轴拖拽 | `onPointerDown` 直接 return，连草案都不出现 |
| 列表删除按钮 | 整列不渲染（不是 disabled——不存在的功能不该留一个灰按钮） |
| 快捷键 | `useShortcuts` 的 `enabled: false`，整组不绑 |
| `commitSegment` / `removeSegment` | 入口 `if (readOnly) return`，防止将来有别的调用点绕过 |

最后一条容易被忽略：只要有一个调用点没被 UI 挡住，服务端会回 409，
用户看到一个和「只读」无关的错误。**双层都要断**。

---

## 页面要显示什么

```
┌────────────────────────────────────────┐
│ ← 任务列表                              │
│ 城市道路早高峰行车记录            [已提交] │
│ 03:42 · city-drive.mp4                  │
├────────────────────────────────────────┤
│                                        │
│  [视频播放器 —— 正常可播]                 │
│                                        │
│  时间轴（色块可见，不可拖）                │
│                                        │
│  片段 3       ← 只读，无删除按钮          │
└────────────────────────────────────────┘
```

- 标题旁加状态徽章 `已提交`（`--color-good` 描边，仓库没有 `--color-ok`）
- 顶部一行说明「已提交，仅供查看」（不要用弹窗打断）
- 视频照常可播放、可拖动进度条——回顾就是为了看内容
- 时间轴色块保留，点击只做 seek，不选中拖拽

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/services/segment-service.ts` | 拆出 `requireReadableTask`，`listSegments` 改用它 |
| `src/lib/services/workbench-service.ts` | `getWorkTask` 放宽到 `claimed \| submitted` |
| `src/app/tasks/[id]/work/page.tsx` | 传 `readOnly` |
| `src/app/tasks/[id]/work/Workbench.tsx` | `readOnly` 的四处开关 |
| `src/app/tasks/[id]/work/Timeline.tsx` | `readOnly` 时 `onPointerDown` 直接 return |
| `src/app/tasks/[id]/work/SegmentList.tsx` | `readOnly` 时不渲染删除按钮 |
| `tests/segment-api.test.ts` | 改 1 例 + 增 2 例 |

---

## 契约（不可改动）

```ts
// workbench-service.ts
export type WorkTask = {
  id: string;
  title: string;
  description: string | null;
  status: 'claimed' | 'submitted';   // ← 从 'claimed' 放宽
  durationMs: number;
  videoFilename: string;
  streamUrl: string;
};
```

```ts
// Timeline / SegmentList / Workbench 新增
readOnly?: boolean;
```

`readOnly` 缺省按 `false` 处理——E1–E7 的调用点不用改。

---

## 实现要点

### 1. `getWorkTask` 的拒绝面收窄，但要守住两条

```ts
if (task.claimed_by !== actor.id) throw new NotFoundError('任务不存在');
if (task.status !== 'claimed' && task.status !== 'submitted') throw new NotFoundError('任务不存在');
```

- `pending`（`claimed_by` 为 NULL）仍然 404
- `rejected` 仍然 404：退回的任务已经回到池子里，标注员手里那份不该再能打开
  （打开一个已经被别人重新领取的任务，看到的是过期数据）

### 2. 只读时 Timeline 连 `cursor` 都要变

`cursor-crosshair` 会让人以为能拖。只读时整块轨道 `cursor-default`。

### 3. 快捷键不绑，但要保留播放

`enabled: false` 会让空格也失效。回顾时按空格不能播放，体验很别扭。

所以：**只读时仍绑播放/暂停与方向键，只禁 I/O、Delete、Esc**。
`enabled` 的语义是「允许写入」，不是「允许按键」——播放相关永远可用。

> 上表「快捷键 → enabled: false，整组不绑」那一行作废，以本段为准。
> 实现上监听器无条件注册，三个写键各自早退（且早退在 `preventDefault` 之前，
> 否则只读页会吞掉 Backspace 的后退功能）。

### 4. 页面标题不要重复查询

`page.tsx` 里 `getWorkTask` 已经取到 `status`，直接传给 Workbench，不要在客户端再判一次。

---

## 验收

**自动**

- [ ] 已提交的任务可以列出片段（原「抛 StateConflictError」用例改为断言返回数组）
- [ ] 已提交的任务调用 `upsertSegment` 仍抛 `StateConflictError`
- [ ] 已提交的任务调用 `deleteSegment` 仍抛 `StateConflictError`
- [ ] `rejected` 任务调 `listSegments` 抛 `NotFoundError`（不是 409，也不是空数组）
- [ ] 现有 475 例全绿

**手工**

- [ ] 打开一个已提交任务 → 能看到视频与片段，标题旁有「已提交」徽章
- [ ] 时间轴拖不动，光标是默认箭头
- [ ] 片段列表没有删除按钮
- [ ] 按 I / O 无反应，按 Delete 无反应
- [ ] 按空格能播放，方向键能微调
- [ ] 点击时间轴色块能 seek
- [ ] 打开自己领取的 claimed 任务 → 一切照旧（可拖可删）

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 只在前端禁，服务端没拦写 | 构造请求仍能改已提交任务的数据 |
| 只读时 `enabled: false` 整体不绑 | 空格不能播放，回顾体验断裂 |
| `rejected` 也放行 | 打开一个已被重新领取的任务，看到过期数据 |
| 删除按钮做成 `disabled` | 留一个永远点不了的按钮，比不渲染更困惑 |
| 时间轴仍 `cursor-crosshair` | 看起来能拖，拖了没反应 |
| 忘记改 E4 那条 409 用例 | 测试变红后误以为是回归，去改实现 |

---

## 完成后

```bash
git add -A && git commit -m "feat(E8a): 只读回顾，读路径与写路径分离"
```

**E 组到此完成**。下一步：F1 提交任务（含片段数校验、状态流转、审计）。
