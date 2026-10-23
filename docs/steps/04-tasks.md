# STEP 04 · 任务与领取

**目标**：管理员能建任务分配给别人，标注员能看到自己池子里的任务并领取。

**前置**：02、03 完成

**预计**：1.5 小时

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/services/taskService.ts` | 列表、创建、领取、退回、超时回收 |
| `src/lib/db/repos/taskRepo.ts` | 所有 SQL |
| `src/app/api/tasks/route.ts` | `GET` 列表 / `POST` 创建 |
| `src/app/api/tasks/[id]/claim/route.ts` | 领取 |
| `src/app/tasks/page.tsx` | 标注员任务列表 |
| `src/app/admin/tasks/page.tsx` | 管理员任务列表 + 创建表单 |

---

## 关键实现

### 1. 列表查询必须按角色收窄

```ts
export function listTasks(db: DB, actor: SessionUser, filter: TaskFilter) {
  const scope = actor.role === 'admin'
    ? { clause: '1=1', params: [] }                       // 管理员看全部
    : { clause: 't.tenant_id = ?', params: [actor.tenantId] };  // 标注员只看自己
  ...
}
```

**标注员传 `?tenantId=` 必须被忽略**，不能因为前端传了就采信。
这不是「信任前端」的问题，是「前端参数永远不能覆盖身份」的原则。

### 2. 领取用条件更新

```sql
UPDATE tasks
   SET status = 'claimed', claimed_by = ?, claimed_at = ?
 WHERE id = ? AND tenant_id = ? AND status = 'pending';
```

判断 `changes === 1`，否则返回 `STATE_CONFLICT`。

虽然是单标注员场景，仍不用「先查后改」——多一个 WHERE 条件，省掉将来改代码的成本。

### 3. 超时回收：读取时惰性判断，不起定时任务

在 `listTasks` 和 `getTask` 之前先跑一次：

```sql
UPDATE tasks
   SET status = 'pending', claimed_by = NULL, claimed_at = NULL
 WHERE status = 'claimed'
   AND claimed_at < ?;        -- now - 2h
```

**注意必须同时把 `claimed_by` 置 NULL**，否则会被 `CHECK` 约束拒绝
（`status='pending' AND claimed_by IS NULL`）。这不是麻烦，是约束在帮你发现遗漏。

**回收不清空已标注的片段**。因为同一租户只有一个人，他回来继续做时草稿还在，体验更好。
若将来一个租户多人，需要在这里加清空或转移逻辑。

### 4. 创建任务

```ts
POST /api/tasks  { videoId, tenantId, title, description? }
```

校验：
- `videoId` 存在
- `tenantId` 对应的租户下有一个 annotator（否则任务没人能领）
- `title` 非空且 ≤ 200 字

创建后状态 `pending`，`claimed_by` 为 NULL。

### 5. 退回

```sql
UPDATE tasks SET status='rejected', reject_reason=? WHERE id=? AND status='submitted';
```

**但退回必须同时写账本冲正**，详见 STEP 06。本步先留出接口，06 里补全事务。

---

## 验收标准

- [ ] 管理员建任务选 alice → alice 登录能在池子里看到
- [ ] bob 登录看不到 alice 的任务
- [ ] alice 点「领取」→ 状态变 `claimed`，按钮变「继续标注」
- [ ] 对同一任务重复领取 → 第二次返回 409，不产生第二条记录
- [ ] 手工把 `claimed_at` 改到 3 小时前 → 刷新列表，任务回到 `pending`
- [ ] 标注员 alice 请求 carol 的任务 id → `404`
- [ ] 管理员列表能按租户筛选，能看到全部三个人的任务

---

## 容易错的地方

| 陷阱 | 后果 |
|---|---|
| 超时回收只改 `status` 不改 `claimed_by` | 被 CHECK 拒绝，UPDATE 抛错 |
| 列表查询对 admin 也套 `tenant_id` | 管理员只能看到一条 |
| 领取用「先 SELECT 再 UPDATE」 | 将来多标注员时会重复领取 |
| 创建任务时没校验目标租户有 annotator | 任务进去没人能领，变成死任务 |
| 用 `req.nextUrl.searchParams` 直接取 tenantId 传给 SQL | 前端可越权查他人数据 |

---

## 完成后

三种角色看到的任务列表都对了。此时点「继续标注」会跳到空白页——下一步做工作台。
