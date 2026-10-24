# E4 · 片段 CRUD API

**做什么**：把 E3 的 `onCommit` 接到数据库，并删掉 `?demo=1` 的假数据。

**依赖**：A1、E3

**预计**：0.5 小时

---

## 这一步第一次真正用上 `normalizeSegments`

区间校验（`14a`）写完到现在一直没人调用。E4 是它的第一个消费者。

关键设计：**单条片段的校验，靠「把候选集整体过一遍 `normalizeSegments`」完成**，
而不是另写一套单项规则。

```ts
const candidates = [...existing.filter(s => s.id !== replaces), draft];
const result = normalizeSegments(candidates, durationMs);
```

这样长度、范围、整数、重叠四组规则只有一处实现。
代价是每次写入要取一次全量片段——单个任务几十段，可以接受。

---

## 预检不是唯一防线

```
应用层预检（normalizeSegments）→ 友好错误，告诉用户「第几段重叠了」
        ↓
数据库触发器（trg_segment_no_overlap_ins）→ 最后防线，抛 'OVERLAP'
```

**两者都必须有**：

- 只有预检：两个请求并发时，都检查通过，然后都插入——合起来就重叠了
- 只有触发器：用户只看到 `SQLITE_CONSTRAINT`，不知道错在哪

所以预检与插入必须在**同一个 `writeTx`** 里，且触发器异常要翻译成 `OverlapError`。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/repos/segment-repo.ts` | 新增：list / insert / delete |
| `src/lib/services/segment-service.ts` | 新增：预检 + 归属校验 |
| `src/app/api/tasks/[id]/segments/route.ts` | GET 列表、POST 新增/替换 |
| `src/app/api/tasks/[id]/segments/[segmentId]/route.ts` | DELETE |
| `src/app/tasks/[id]/work/page.tsx` | 服务端加载片段传入 |
| `src/app/tasks/[id]/work/Workbench.tsx` | 删 `?demo=1`，接真实数据 |
| `tests/segment-api.test.ts` | 新增 |

---

## 契约（不可改动）

```ts
// segment-service.ts
export type SegmentRow = { id: string; startMs: number; endMs: number; label: string | null };

/** 列出任务的片段，按 startMs 升序。 */
export function listSegments(db: DB, actor: TenantUser, taskId: string): SegmentRow[];

/**
 * 新增或替换一个片段。
 * replaces 为原片段 id 时执行「先删后插」，否则纯新增。
 * 任何校验失败都抛错，不做部分写入。
 */
export function upsertSegment(
  db: DB,
  actor: TenantUser,
  taskId: string,
  input: { startMs: number; endMs: number; replaces?: string | null },
): SegmentRow;

export function deleteSegment(db: DB, actor: TenantUser, taskId: string, segmentId: string): void;
```

### API

```
GET    /api/tasks/:id/segments          → { ok, segments: SegmentRow[] }
POST   /api/tasks/:id/segments          body { startMs, endMs, replaces? } → { ok, segment }
DELETE /api/tasks/:id/segments/:segId   → { ok }
```

错误映射：

| 情况 | 错误 | 状态码 |
|---|---|---|
| 任务不存在 / 非本租户 / 不是自己领取 | `NotFoundError` | 404 |
| 任务状态不是 `claimed` | `StateConflictError` | 409 |
| 片段不属于该任务 | `NotFoundError` | 404 |
| 区间不合法（太短/越界/非整数） | `ValidationError` | 400 |
| 与已有片段重叠 | `OverlapError` | 409 |
| 管理员调用 | `ForbiddenError` | 403 |

`OverlapError` 已存在（`src/lib/errors.ts`），沿用。

---

## 实现要点

### 1. 归属校验要看两件事：租户 + 是不是自己领的

```ts
const task = findByIdForTenant(db, taskId, actor.tenantId);
if (!task) throw new NotFoundError('任务不存在');
if (task.claimed_by !== actor.id) throw new NotFoundError('任务不存在');  // 同样 404，不泄漏
if (task.status !== 'claimed') throw new StateConflictError('任务当前状态不允许修改片段');
```

第二行用 404 而非 403：同租户同事的任务也不该让你知道它存在。

### 2. 触发器异常要翻译

```ts
try {
  insertSegment(db, {...});
} catch (err) {
  // 触发器抛的是 'OVERLAP'，直接冒泡会让客户端收到 500
  if (err instanceof Error && err.message.includes('OVERLAP')) {
    throw new OverlapError('这个片段与已标注的区间重叠');
  }
  throw err;
}
```

### 3. `replaces` 必须校验属于本任务

```ts
const existing = listSegments(db, actor, taskId);
const target = input.replaces ? existing.find(s => s.id === input.replaces) : null;
if (input.replaces && !target) throw new NotFoundError('要替换的片段不存在');
```

不校验的话，传一个别的任务的片段 id 进去，会删掉别人的片段。

### 4. 替换是「先删后插」，不是 UPDATE

因为两端都可能变（拖左边 = 改 start，拖中间 = 两端都变），
UPDATE 要判断改哪端，而删+插天然覆盖所有情况。

代价：片段 id 会变。**这对 E5（片段列表选中态）有影响**——前端要按返回的新 id 更新选中。

事务里删+插，中途失败整体回滚，不会出现「删了但没插上」。

### 5. 时长为 0 的任务不该有片段

`durationMs` 来自 `videos.duration_ms`，有 `CHECK (> 0)` 保证。
但 `normalizeSegments` 现在会返回 `invalid-duration`，要翻译成 `ValidationError` 而非 500。

### 6. 删掉 `?demo=1`

`Workbench.tsx` 里的 `DEMO_SEGMENTS` 与读取 `window.location.search` 的 effect 全部删除。
初始 `segments` 改为来自服务端传入的 `initialSegments` prop。

`00-INDEX.md` 里 E4 行的「删掉 E2 的 `?demo=1` 演示片段」一并勾掉。

---

## 页面要求

`Workbench` 的 `onCommit` 改成异步：

```tsx
async function handleCommit(draft: Segment, replacedIndex: number | null) {
  const replaces = replacedIndex === null ? null : segments[replacedIndex]?.id ?? null;
  const res = await fetch(`/api/tasks/${task.id}/segments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...draft, replaces }),
  });
  // 成功：用返回的真实 id 更新本地数组（替换或追加，再按 startMs 重排）
  // 失败：不修改本地数组，把 message 显示在时间轴上方，3 秒后消失
}
```

- 提交中显示一个细的进行态（不要用全屏遮罩，标注时会被打断）
- 失败提示要能被下一次操作清除，不要堆叠
- 本地数组与服务器不一致时以服务器返回为准

---

## 验收

**自动**

- [ ] 新增合法片段 → 落库，返回带 id 的行
- [ ] 新增与已有片段重叠的 → `OverlapError`，库中行数不变
- [ ] 新增太短的片段（< `MIN_SEGMENT_MS`）→ `ValidationError`
- [ ] 新增越界片段（end > 视频时长）→ `ValidationError`
- [ ] 小数毫秒 → `ValidationError`
- [ ] `replaces` 指向别的任务的片段 → `NotFoundError`，两个任务的数据都不变
- [ ] `replaces` 正常替换 → 旧行消失、新行存在，总数不变
- [ ] 替换成重叠的区间 → 抛错且**旧片段仍在**（整体回滚）
- [ ] 删除自己的片段 → 成功；删除别人的片段 → `NotFoundError`
- [ ] 未领取（pending）/ 别人领取 / 已提交的任务 → 改片段一律 404 或 409
- [ ] 管理员调三个接口 → 403
- [ ] 直接绕过应用层插重叠片段（裸 SQL）→ 触发器抛 `OVERLAP`
- [ ] 现有 397 例全绿

**手工**

- [ ] 工作台加载后，`?demo=1` 不再有任何效果，片段来自数据库
- [ ] 拖出新片段后刷新页面，片段还在
- [ ] 拖动已有片段后刷新，位置是新位置
- [ ] 重叠时提示出现且 3 秒后消失
- [ ] 网络失败时（可断开服务）本地数组不变，有错误提示

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 预检在事务外 | 并发时两人都通过检查，插入后重叠 |
| 只靠触发器不给预检 | 用户看到 `SQLITE_CONSTRAINT`，不知道错在哪 |
| `replaces` 不校验归属 | 传别的任务的 id 能删掉别人的片段 |
| 用 UPDATE 而非删+插 | 两端都变的场景要写分支，且容易漏掉重叠检查 |
| 触发器异常直接冒泡 | 客户端收 500，前端无法区分「重叠」与「服务器炸了」 |
| 失败时也更新本地数组 | 界面显示成功，刷新后消失 |
| 忘记删 `?demo=1` | 演示数据永久留在代码里 |

---

## 完成后

```bash
git add -A && git commit -m "feat(E4): 片段 CRUD API，预检 + 触发器双层防线"
```

**下一步**：E5 片段列表（选中、编辑、删除）。E4 的「替换会换 id」对 E5 的选中态有直接影响。
