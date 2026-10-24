# F2 · 退回与重新打开（冲正）

**做什么**：管理员退回已提交的任务（冲正记账），标注员重新打开继续改。

**依赖**：F1

**预计**：0.5 小时

---

## 退回本身早就写好了

`review-service.ts` 的 `rejectTask` 在 D 组就完成了，做得比预期细：

- 用「带谓词的单条 UPDATE + changes 判定」而不是先查后改（并发下不会写两条冲正）
- 冲正金额 `-submission.total_ms`，指向 `findCurrentByTask` 而不是被取代的那条
- `entry_date` 记**原提交日**，不是退回当天
- 审计 `strict`，`detail` 里带 `reason` / `submissionId` / `deltaMs` / `entryDate`
- 40 例测试，含「退回 200 字原因仍能成功」「冲正指向当前有效提交」

所以本步只补一个缺口。

---

## 缺口：`rejected` 是个死状态

```sql
-- claimIfPending 只认 pending
UPDATE tasks SET status = 'claimed', claimed_by = ?
  WHERE id = ? AND tenant_id = ? AND status = 'pending'
```

退回后任务变成 `rejected`，于是：

| 动作 | 结果 |
|---|---|
| 标注员在列表里看到它 | ✅ 能（`ANNOTATOR_SCOPE` 含 `claimed_by = ?`） |
| 看到「已退回」与原因 | ✅ 能（TaskList 有对应展示） |
| 点进去改 | ❌ 打不开（`getWorkTask` 只放行 `claimed \| submitted`） |
| 重新领取 | ❌ 领不了（只认 `pending`） |
| 再次提交 | ❌ 提交要求 `claimed` |

**标注员能看见自己有个任务被退回、也知道了原因，但改不了。** 这是闭环的最后一环。

---

## 做法：`reopenTask`（rejected → claimed，仅原领取人）

不把 `rejected` 改回 `pending` 的原因：

- `pending` 意味着「谁都能领」，但退回的任务应该优先由原作者修改——他知道当时为什么那么标
- 退回原因 `reject_reason` 要一直显示到重新提交为止，回 `pending` 会让它变成池子里的公共信息
- 真要让别人接，是「重新分配给他人」，那是另一件事（管理员操作），不该混进退回

```sql
UPDATE tasks SET status = 'claimed', claimed_at = ?
  WHERE id = ? AND tenant_id = ? AND claimed_by = ? AND status = 'rejected'
```

四个谓词一个都不能少：租户防止跨租户、`claimed_by` 防止同事抢走别人的退回任务、
`status` 防止对已提交/待领取的任务误用。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/repos/task-repo.ts` | 新增 `reopenIfRejected` |
| `src/lib/services/review-service.ts` | 新增 `reopenTask` |
| `src/app/api/tasks/[id]/reopen/route.ts` | `POST` |
| `tests/review.test.ts` | 新增 10 例 |

---

## 契约（不可改动）

```ts
// repos/task-repo.ts
/**
 * 仅当任务仍为 rejected 且属于该标注员时，改回 claimed。
 * 返回是否命中 —— 调用方只看 changes，不做先查后改。
 */
export function reopenIfRejected(
  db: DB,
  args: { taskId: string; tenantId: string; userId: string; nowMs: number },
): boolean;
```

```ts
// services/review-service.ts
/**
 * 重新打开被退回的任务。仅限原领取人。
 *
 * 只有 claimed 才能进工作台、才能再次提交，所以这是退回后唯一的出路。
 * 不写账本、不写审计之外的业务数据：账已经在退回时冲正过了。
 */
export function reopenTask(db: DB, actor: TenantUser, taskId: string): void;
```

---

## 实现要点

### 1. 不写账本

冲正在退回时就做了（`kind='revoke'`，`delta_ms = -total`）。重新打开只是把状态改回 `claimed`，
**不能补一条 `submit`**——那等于凭空把工作量又记一遍。

净额的变化路径应当是：

```
提交     +5000
退回     -5000  → 净额 0
重新打开  0     → 净额 0
再次提交 +8000  → 净额 8000
```

### 2. 审计记 `task.reopen`

`detail` 里带 `previousStatus: 'rejected'`。不记的话，账本上看不出「这一天为什么先归零又涨上去」。

### 3. 错误优先级

- 任务不存在 / 别的租户 → `NotFoundError`（404）
- 存在但不是自己的 → 也是 404（不承认存在）
- 待领取（`claimed_by` 为 NULL）→ 404：没有领取人，归属不成立，轮不到判状态
- 是自己的，但状态不是 `rejected` → `StateConflictError`（409）

**先归属后状态**，与其余四个动作一致。

### 4. `reject_reason` 保留到重新提交

重新打开时**不清空** `reject_reason`。它要一直显示在工作台上，
直到下一次提交（F1 的 `submitIfClaimed` 里已经 `reject_reason = NULL`）。

清早了，标注员打开任务就忘了要改什么。

### 5. `claimed_at` 要刷新

用 `nowMs()` 覆盖。否则「领取时长」这类统计会把第一次领取到退回之间的时间也算进去。

---

## 验收

**自动**

- [ ] 退回自己的任务后 `reopenTask` → 状态变 `claimed`，`reject_reason` 仍在
- [ ] `reopenTask` 后该任务净额仍是 0（不补 submit 条目）
- [ ] 别人的 rejected 任务 → `NotFoundError`
- [ ] 别的租户 → `NotFoundError`
- [ ] 已提交（submitted）的任务 → `StateConflictError`
- [ ] 待领取（pending）的任务 → `NotFoundError`（`claimed_by` 是 NULL，归属这一关就过不了）
- [ ] 重新打开后再提交成功，净额变为新 total
- [ ] 审计记了一条 `task.reopen`
- [ ] 现有 538 例全绿

**手工**

- [ ] 管理员退回 → 标注员列表看到「已退回」+ 原因 → 点「重新打开」→ 能进工作台
- [ ] 打开后顶部仍显示退回原因（`WorkTask.rejectReason` 由服务端带下来，
      列表页只在 `rejected` 时显示，重新打开后要靠工作台自己显示）
- [ ] 改完再提交 → 净额正确

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 重新打开时补一条 `submit` 账目 | 工作量凭空翻倍 |
| 把 `rejected` 改回 `pending` | 退回原因变成公共信息，且同事能抢先领走 |
| 重新打开时清空 `reject_reason` | 标注员忘了要改什么 |
| 谓词漏了 `claimed_by` | 同事能抢走别人被退回的任务 |
| 谓词漏了 `status` | 对已提交任务调用会把状态打回 `claimed` |
| `claimed_at` 不刷新 | 领取时长统计把退回前的也算进去 |

---

## 完成后

```bash
git add -A && git commit -m "feat(F2): 重新打开被退回的任务，补上退回闭环"
```

**下一步**：F3 提交/退回的界面入口。
