# D3 · 标注员领取与归还

**做什么**：把任务从 `pending` 认领到自己名下，或把不想做的归还回池子。

**依赖**：D1

**预计**：1 小时

---

## 为什么这一步不含「提交」

原计划 D3 是「领取与提交」，实现前改掉了。原因是 schema 说了算：

```sql
CREATE TABLE submissions (
  ...
  CHECK (total_ms > 0),
  CHECK (segment_count > 0)
);
```

**空提交在数据库层面就插不进去。** 而片段录入是 E1 的事，提交要写账本（不可逆）是 E3 的事。

现在做提交只有两个选择：

- 先跳过片段校验 → 留下一版「能提交空任务」的实现，E3 再补上
- 或者现在就把片段、区间校验、账本一起做完 → D3 变成三天的工作量

所以提交归 E3，与片段、账本一起做。**状态机在 D3 只走到 `claimed`。**

---

## 状态流转（本步覆盖的部分）

```
pending ──claim──▶ claimed
   ▲                  │
   └─────release──────┘

claimed ──submit──▶ submitted   （E3）
submitted ──reject──▶ rejected  （D4）
rejected ──resubmit──▶ submitted（E3）
```

**只有 `pending` 能被领取，只有 `claimed` 能被归还。** 其余组合一律拒绝。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/repos/task-repo.ts` | **追加** `claimIfPending`、`releaseIfOwned` |
| `src/lib/services/task-service.ts` | **追加** `claimTask`、`releaseTask` |
| `src/app/api/tasks/[id]/claim/route.ts` | POST 领取 |
| `src/app/api/tasks/[id]/release/route.ts` | POST 归还 |
| `src/app/tasks/TaskList.tsx` | 行内操作按钮 |
| `tests/task-claim.test.ts` | 新增 |

---

## 契约（不可改动）

### `src/lib/db/repos/task-repo.ts` 追加

```ts
/** 仅当任务仍为 pending 且属于该租户时改为 claimed。返回是否命中。 */
export function claimIfPending(db: DB, args: {
  taskId: string;
  tenantId: string;
  userId: string;
  nowMs: number;
}): boolean;

/** 仅当任务由该用户领取且状态为 claimed 时归还。返回是否命中。 */
export function releaseIfOwned(db: DB, args: {
  taskId: string;
  tenantId: string;
  userId: string;
  nowMs: number;
}): boolean;
```

返回值就是 `changes > 0`——**调用方靠它判断输赢，不靠先查后判**。

### `src/lib/services/task-service.ts` 追加

```ts
/** 领取任务。失败时抛错，成功返回更新后的行。 */
export function claimTask(db: DB, actor: TenantUser, taskId: string): TaskRow;

/** 归还任务。 */
export function releaseTask(db: DB, actor: TenantUser, taskId: string): void;
```

抛错约定：

| 情况 | 错误 | 状态码 |
|---|---|---|
| 任务不存在 / 不属于本租户 | `NotFoundError` | 404 |
| 任务已被别人领取 | `StateConflictError` | 409 |
| 归还时任务不是自己领取的 | `StateConflictError` | 409 |
| 归还时状态已不是 `claimed` | `StateConflictError` | 409 |

### API

**POST `/api/tasks/:id/claim`**（标注员）

```
200 { ok: true, task: { id, status, claimedBy } }
404 任务不存在
409 { ok: false, error: { code: 'STATE_CONFLICT', message: '这条任务已被其他人领取' } }
```

**POST `/api/tasks/:id/release`**（标注员）

```
200 { ok: true }
404 / 409 同上
```

**管理员调用这两个接口 → 403。** 管理员不参与标注。

---

## 实现要点

### 1. 判输赢靠 `changes`，不靠「先查再改」

```sql
UPDATE tasks
   SET status = 'claimed', claimed_by = ?, claimed_at = ?
 WHERE id = ? AND tenant_id = ? AND status = 'pending'
```

`changes === 0` 就是「没抢到」。这里**不需要显式事务**——单条 UPDATE 本身就是原子的。

**不要**写成：

```ts
const task = findById(db, id);          // ✗ 查的时候还是 pending
if (task.status !== 'pending') throw ...;
updateTask(...);                         // 这中间可能已经被别人领了
```

先查后改在并发下必输。查只为**生成准确的错误信息**，判定输赢必须靠 UPDATE 的返回值。

### 2. 错误信息要准确，不能一律 409

「任务不存在」和「已被别人领取」是两件事：

- 前者说明 id 错了或越权 → 404
- 后者说明你来晚了 → 409，且这是**正常竞争**，不该报错为异常

所以流程是：

```ts
const existing = findByIdForTenant(db, taskId, actor.tenantId);   // 带租户条件
if (!existing) throw new NotFoundError('任务不存在');
if (!claimIfPending(...)) throw new StateConflictError('这条任务已被其他人领取');
```

注意 `findByIdForTenant` 带租户条件——**不能先查全局再判租户**，
否则「任务存在但属于别人」会走到 409 分支，泄漏存在性。

### 3. 归还的条件必须包含 `claimed_by = 自己`

```sql
UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL
 WHERE id = ? AND tenant_id = ? AND claimed_by = ? AND status = 'claimed'
```

少了 `claimed_by = ?`，任何同租户的人都能把别人正在做的任务打回池子。

### 4. 归还时 `claimed_at` 要一起清空

schema 的 CHECK 要求 `status='pending'` 时 `claimed_by IS NULL`。
`claimed_at` 没有约束，但留着会让「领取时间」与状态矛盾，后续统计会算错。

### 5. 审计

```ts
writeAudit(db, {
  actorId, actorRole: 'annotator', tenantId,
  action: 'task.claim', targetType: 'task', targetId: taskId,
  detail: { previousStatus: 'pending' },
});
```

归还记 `task.release`。两条都要在 UPDATE 成功之后写，失败路径不写。

---

## 页面要求

`TaskList` 每行末尾加操作列：

| 状态 | 条件 | 按钮 |
|---|---|---|
| `pending` | — | 「领取」 |
| `claimed` | `claimed_by` 是自己 | 「继续标注」（E2 接）、“归还” |
| `claimed` | 别人 | 不显示按钮，显示「进行中」 |
| `submitted` / `rejected` | 自己 | 无操作（E3/D4 接） |

- 领取/归还成功后**局部刷新列表**，不整页跳转
- 冲突（409）时就地提示「这条任务刚被其他人领走了」，并把该行刷新成最新状态
- 按钮点击后立即禁用，防重复提交

---

## 验收

**自动**

- [ ] 标注员领取本租户 `pending` 任务 → 成功，`status='claimed'`、`claimed_by=自己`、`claimed_at` 有值
- [ ] 再领取同一条 → `StateConflictError`
- [ ] 领取其他租户的任务 → `NotFoundError`（不是 409）
- [ ] 领取不存在的 id → `NotFoundError`
- [ ] 领取 `submitted` 状态的任务 → `StateConflictError`
- [ ] 归还自己领取的任务 → `status='pending'`、`claimed_by` 与 `claimed_at` 都为 null
- [ ] 归还别人领取的任务 → `StateConflictError`，且**任务状态不变**
- [ ] 归还 `submitted` 的任务 → `StateConflictError`
- [ ] 管理员调 claim API → 403
- [ ] 领取成功写一条 `task.claim` 审计，失败路径**不写**
- [ ] 现有 264 例全绿

**手工**

- [ ] 标注员在 `/tasks` 点「领取」，行状态变为「已领取」
- [ ] 刷新页面，状态保持
- [ ] 点「归还」，回到待领取
- [ ] 用两个浏览器分别登录 alice 和 bob，同时点同一条任务 → 只有一个成功，另一个看到冲突提示

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 先查 `status` 再无条件 UPDATE | 并发下两人都领到（后写的覆盖前面的） |
| 用 `findById` 而非带租户条件查 | 跨租户任务返回 409，泄漏存在性 |
| 归还漏 `claimed_by = 自己` | 同租户任何人都能打回别人的任务 |
| 归还漏 `status = 'claimed'` | 已提交的任务被退回成 pending，账本与状态脱节 |
| 失败路径也写审计 | 审计里出现大量「领取失败」，掩盖真实操作 |
| 管理员能领取 | 管理员没有租户，`TenantUser` 类型会拦住——但要确保 API 层不给管理员开口子 |

---

## 实测记录

| # | 场景 | 结果 |
|---|---|---|
| 1 | 领取本租户 pending 任务 | 200，`status=claimed`，`claimed_by` 为自己 |
| 2 | 自己再领一次 | 409，`STATE_CONFLICT`，提示「你已经领取了这条任务」 |
| 3 | 库中状态 | `claimed_by` 仍是首次领取的人，**没被改写** |
| 4 | 归还 | 200，`status=pending`、`claimed_by` 与 `claimed_at` 均为 null |
| 5 | 跨租户领取 | 404 `NOT_FOUND`（不是 409） |
| 6 | 审计 | 成功路径 `task.claim` / `task.release` 各 1 条，失败路径不写 |

**变异验证**：
- 删掉 `claimIfPending` 的 `AND status = 'pending'` → **5 例变红**，
  含「B 领取失败后任务仍归 A」
- 把归还的 `claimed_by = ?` 改成 `(claimed_by = ? OR 1=1)` → **3 例变红**，
  含「归还越权后任务仍归原主」

第二条变异最初写成直接删除条件，结果因 SQL 参数数量不匹配而全红，
测出来的是「参数个数错」而不是「越权」——改成保留参数、让条件恒真才测到真东西。

## 一处文案改进

原实现对所有失败都提示「这条任务已被其他人领取」。但演示时最容易触发的是
**自己连点两次**，对着自己说「被其他人领取」会让人以为数据错了。

已在 `!claimed` 分支区分：

```ts
existing.claimed_by === actor.id ? '你已经领取了这条任务' : '这条任务已被其他人领取'
```

事务拿的是写锁，`existing` 与 `UPDATE` 之间不会被其他写事务插入，所以这个判断是准的。

## 完成后

```bash
git add -A && git commit -m "feat(D3): 任务领取与归还，可判定并发输赢"
```
