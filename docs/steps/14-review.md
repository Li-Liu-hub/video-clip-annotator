# D4 · 管理员审核与退回

**做什么**：管理员查看标注员提交的结果，发现不合格就退回，并冲正已计入的工作量。

**依赖**：D2 D3

**预计**：1 小时

---

## 先说清一件事：为什么没有「通过」按钮

`tasks.status` 只有 `pending / claimed / submitted / rejected`，没有 `approved`。
`ledger_entries.kind` 只有 `submit / revoke`。

这不是遗漏，是设计选择：**提交即计入，审核只是「不退回」。**

```
标注员提交 ──▶ 写一条 submit（+时长）──▶ submitted
                                              │
                              管理员发现不合格 ──┤
                                              ▼
                                    写一条 revoke（−时长）
                                    status → rejected
```

如果要求管理员逐条点「通过」，那么未被点过的提交就永远悬着，
工作量统计不出结果——而项目的核心主张是**上班时数字就已经在那儿了**。

所以审核的动作只有两个：**看**，或者 **退回**。

代价是：管理员不看，错误数据就会留着。这一点写进 `report.md` 的已知缺口。

---

## 冲正记在哪一天

这是本步最需要想清楚的问题。

`ledger_entries.entry_date` 是「计入哪一天」。退一条 10 月 20 日提交的任务，冲正应该记在 20 日还是今天？

**必须记在原提交日。**

假设 20 日提交 5 条共 50 分钟，21 日退回其中 1 条（10 分钟）：

| 记法 | 20 日统计 | 21 日统计 | 问题 |
|---|---|---|---|
| 冲正记今天 | 50 分钟 | −10 分钟 | 20 日的报表永久偏多，且出现「负数工作量」的日期 |
| **冲正记原日期** | 40 分钟 | 0 | 20 日反映真实工作量 |

项目的痛点就是「数字对不上」。让某一天的报表显示 50 分钟而实际只该算 40，正是要消灭的那种错。

**账本管数字，审计管行为**：账本记在原日期（修正统计），审计记在今天（记录谁在何时退回了什么）。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/repos/task-repo.ts` | **追加** `rejectIfSubmitted`、`findById`（管理员全局查） |
| `src/lib/db/repos/submission-repo.ts` | **新增** `findCurrentByTask` |
| `src/lib/db/repos/ledger-repo.ts` | **新增** `insertEntry`、`sumByTask` |
| `src/lib/services/review-service.ts` | **新增** `rejectTask` |
| `src/app/api/tasks/[id]/reject/route.ts` | POST 退回 |
| `src/app/admin/tasks/page.tsx` | 状态筛选 + 退回入口 |
| `tests/review.test.ts` | 新增 |

---

## 契约（不可改动）

### `src/lib/services/review-service.ts`

```ts
export const MAX_REASON_LENGTH = 200;

/**
 * 退回一条已提交的任务。
 * 状态 → rejected，并写一条 revoke 冲正（entry_date 取原提交日）。
 * 调用方必须已确认是管理员。
 */
export function rejectTask(db: DB, actor: SessionUser, taskId: string, reason: string): void;
```

抛错：

| 情况 | 错误 | 状态码 |
|---|---|---|
| 任务不存在 | `NotFoundError` | 404 |
| 状态不是 `submitted` | `StateConflictError` | 409 |
| `reason` 为空 / 超过 200 字 | `ValidationError` | 400 |
| 找不到当前有效的 submission | `StateConflictError` | 409（数据异常） |

### 两个 repo

```ts
/** 该任务当前有效的提交（未被 superseded 的那条）。 */
export function findCurrentByTask(db: DB, taskId: string): SubmissionRow | null;

/** 写账本条目。 */
export function insertEntry(db: DB, entry: {
  id: string; tenantId: string; taskId: string; submissionId: string;
  annotatorId: string; deltaMs: number; entryDate: string; kind: 'submit' | 'revoke';
  createdAt: number;
}): void;
```

### API

**POST `/api/tasks/:id/reject`**（仅管理员）

```
请求：{ reason: string }
200  { ok: true }
400 / 404 / 409 见上表
```

---

## 实现要点

### 1. 状态跃迁与冲正必须同一个事务

```ts
return writeTx(db, () => {
  const ok = rejectIfSubmitted(db, { taskId, reason, nowMs: nowMs() });
  if (!ok) throw new StateConflictError('任务当前状态不允许退回');
  insertEntry(db, { ..., kind: 'revoke', deltaMs: -sub.total_ms, entryDate: sub.local_date });
  writeAudit(db, { ... action: 'task.reject' ... });
});
```

三者缺一都会产生不一致：

- 只改状态不冲正 → 数字虚高，正是要消灭的问题
- 冲正了但状态没改 → 标注员看不到退回，会以为自己已交
- 都没审计 → 追溯断链

### 2. `rejectIfSubmitted` 用条件更新

```sql
UPDATE tasks
   SET status = 'rejected', reject_reason = ?
 WHERE id = ? AND status = 'submitted'
```

`changes === 0` 说明状态已被别人改过（比如标注员刚好在重新提交）。**靠它判定，不靠先查后改。**

### 3. 冲正金额取「当前有效提交」的 `total_ms`

不能取任务的 `estimated_ms`——标注员实际标了多少就是多少。
`findCurrentByTask` 用 `superseded_by IS NULL` 定位当前有效的那条。

### 4. `delta_ms` 是负值

schema 有 CHECK：`kind='revoke'` 时 `delta_ms < 0`。
所以传 `-sub.total_ms`，不是 `Math.abs()`。

如果 `total_ms` 是 0 会怎样？`submissions` 的 CHECK 保证它 > 0，所以不会出现 0。

### 5. 退回后标注员能重新提交

`rejected` 状态下标注员应该能再次提交（E3 实现）。D4 只保证状态是 `rejected`
且 `reject_reason` 已写入，让标注员在列表里看到原因。

---

## 页面要求

`/admin/tasks` 增加状态筛选（`?status=submitted`），默认「全部」：

- 筛选条：全部 / 待审核（submitted）/ 已退回（rejected）
- `submitted` 行末尾显示「退回」按钮
- 点「退回」弹出输入框填原因（必填，≤200 字）
- 退回成功后该行状态变为「已退回」，并就地显示原因
- 已退回的行显示退回原因（截断，`title` 显示全文）

**没有「通过」按钮**——文档开头解释了原因。可以在筛选条旁加一句提示：
「提交即计入工作量，发现问题时退回并冲正」。这句话能避免使用者困惑。

---

## 验收

**自动**

- [ ] 退回 `submitted` 任务 → 状态变 `rejected`，`reject_reason` 写入
- [ ] 同时写一条 `kind='revoke'` 且 `delta_ms = -total_ms` 的账本条目
- [ ] 该条目的 `entry_date` **等于原提交的 `local_date`**，不是今天
- [ ] 冲正后该任务的账本净额归零
- [ ] 退回 `pending` / `claimed` / `rejected` 任务 → `StateConflictError`，账本无新增
- [ ] `reason` 为空 → `ValidationError`，状态不变
- [ ] `reason` 超过 200 字 → `ValidationError`
- [ ] 非管理员调 API → 403
- [ ] 记一条 `task.reject` 审计，失败路径不写
- [ ] 现有 295 例全绿

**手工**

- [ ] `/admin/tasks?status=submitted` 只显示待审核任务
- [ ] 点「退回」填原因后，行变为「已退回」并显示原因
- [ ] 用 alice 登录看 `/tasks`，能看到退回原因
- [ ] 统计页（G 阶段）该任务的工作量在**原提交日**减少，而非今天

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 冲正记在今天 | 原提交日的报表永久偏多，还会出现负工作量的日期 |
| 冲正金额用 `estimated_ms` | 与实际提交的时长不符，账不平 |
| `delta_ms` 传正数 | 撞 schema 的 CHECK，直接 500 |
| 只改状态不写账本 | 数字虚高 |
| 只写账本不改状态 | 标注员看不到退回 |
| 用 `findCurrentByTask` 时不加 `superseded_by IS NULL` | 拿到历史提交，冲正金额错 |
| 退回时允许 `claimed` 状态 | 标注员工作到一半被别人把任务退掉 |

---

## 实测记录

用种子数据里的一条 submitted 任务（总时长 14300ms，提交日 `2026-10-17`）：

| # | 场景 | 结果 |
|---|---|---|
| 1 | 退回 | 200，`status=rejected`，`reject_reason` 写入 |
| 2 | 账本 | 两条：`submit +14300 @2026-10-17`、`revoke -14300 @2026-10-17` |
| 3 | 净额 | **0** |
| 4 | 重复退回 | 409 `STATE_CONFLICT` |
| 5 | 空理由 | 400 `VALIDATION` |
| 6 | 标注员可见 | alice 的 `/tasks` 页面能看到「起止时间偏移」 |

**第 2 条是重点**：冲正条目的 `entry_date` 是 `2026-10-17`（原提交日），
不是操作当天 `2026-10-23`。若记在今天，10-17 的报表会永久偏多 14300ms，
而 10-23 会凭空出现一段负数工作量——正是「数字对不上」的典型来源。

变异验证：把冲正日期改成今天，只有那条日期用例变红，其余全绿——
说明这条断言锁定的是唯一行为，没有冗余覆盖。

## 完成后

```bash
git add -A && git commit -m "feat(D4): 管理员退回与账本冲正"
```

**完成后状态**：`D` 阶段收尾。闭环还差「提交」一环（E3），
它是整个系统唯一会写账本正向条目的动作。
