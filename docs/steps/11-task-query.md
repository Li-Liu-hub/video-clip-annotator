# D1 · 任务查询与列表页

**做什么**：按角色收窄的任务列表。标注员只看自己租户的，管理员看全部。

**依赖**：B2 C1

**预计**：1 小时

**这是第一个「列表级租户隔离」，此前只做过单对象查询。列表写错就是批量泄漏。**

---

## 可见范围（本步唯一的核心规则）

| 角色 | 可见任务 |
|---|---|
| 管理员 | 全部 |
| 标注员 | **本租户** 且（状态为 `pending` **或** 自己领取的） |

两个条件缺一不可：

- 只按租户过滤 → 能看到同租户其他人正在做的任务，造成重复劳动
- 只按 `claimed_by` 过滤 → 看不到待领取的池子，无法接活

`pending` 是「公开待领」，其余状态是「已有归属」——只有 `claimed_by = 自己` 才该看到。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/repos/task-repo.ts` | 两条查询：全量 / 标注员范围 |
| `src/lib/services/task-service.ts` | 角色分派 |
| `src/app/tasks/page.tsx` | 标注员列表（`/tasks`） |
| `src/app/admin/tasks/page.tsx` | 管理员列表（`/admin/tasks`） |
| `src/app/admin/layout.tsx` | 启用「任务」导航项 |
| `tests/task-query.test.ts` | 新增 |

---

## 契约（不可改动）

### `src/lib/db/repos/task-repo.ts`

```ts
export type TaskRow = {
  id: string;
  tenant_id: string;
  video_id: string;
  status: 'pending' | 'claimed' | 'submitted' | 'rejected';
  claimed_by: string | null;
  /** 取自 videos.duration_ms。tasks 表不存预估时长，语义是「这条任务涉及多长的视频」。 */
  estimated_ms: number;
  created_at: number;
  // 以下为 join 出来的展示字段
  video_filename: string;
  tenant_name: string;
  claimed_by_name: string | null;
};

export type ListOptions = { limit: number; offset: number };

/** 管理员视图：无租户谓词。 */
export function listAll(db: DB, options: ListOptions): TaskRow[];
export function countAll(db: DB): number;

/** 标注员视图：本租户 且（pending 或自己领取）。 */
export function listForAnnotator(
  db: DB,
  tenantId: string,
  userId: string,
  options: ListOptions,
): TaskRow[];
export function countForAnnotator(db: DB, tenantId: string, userId: string): number;
```

### `src/lib/services/task-service.ts`

```ts
export type TaskPage = { items: TaskRow[]; total: number; page: number; pageSize: number };

/** 角色分派。标注员必须持有租户，否则抛 ForbiddenError（数据异常，非正常路径）。 */
export function listTasks(db: DB, actor: SessionUser, page: number): TaskPage;
```

`PAGE_SIZE = 20` 常量导出。

---

## 实现要点

### 1. 不要在一条 SQL 里用 `(? IS NULL OR ...)` 切换角色

```ts
// ✗ 看似优雅，实则危险
WHERE (? IS NULL OR t.tenant_id = ?)
```

这会让「标注员的 `tenantId` 因数据异常变成 null」直接升级为管理员视图——
**角色判定跑到了数据库的 NULL 语义里**，而 SQL 不会告诉你它发生了。

正确做法是 service 层显式分叉，两条 SQL 各自写死：

```ts
if (actor.role === 'admin') return listAll(db, opts);
const tenantUser = requireTenantUser(actor);   // 类型窄化，不是 if 判断
return listForAnnotator(db, tenantUser.tenantId, tenantUser.id, opts);
```

### 2. 标注员分支必须复用 `isTenantUser`

```ts
if (!isTenantUser(actor)) {
  // 走到这里说明 role=annotator 但 tenantId 为空或空串，是数据异常
  throw new ForbiddenError('账号数据异常，请联系管理员');
}
```

**不能**写 `if (!actor.tenantId) return []` —— 返回空列表会把这个 bug 永久藏起来。

### 3. 排序必须稳定

```sql
ORDER BY t.created_at DESC, t.id DESC
```

只按 `created_at` 排序时，同一毫秒创建的多行顺序不确定 → 翻页时重复或遗漏。

### 4. 分页要同时返回 total

`LIMIT/OFFSET` 与 `COUNT(*)` 必须用同一组 `WHERE` 条件。
两处条件不一致的症状是「显示 23 条，翻页只有 12 条」。

### 5. 管理员访问 `/tasks` 直接跳走

B2 当时允许管理员看空列表，现在有了 `/admin/tasks`，应该跳过去：

```ts
if (user.role === 'admin') redirect('/admin/tasks');
```

管理员没有租户，留在 `/tasks` 只会看到一个与自己无关的页面。

### 6. `estimated_ms` 不是 tasks 表的列

本文档初稿把 `estimated_ms` 写成了 `tasks` 的字段，实际 schema 里没有这一列。
实现取 `videos.duration_ms`（素材时长即任务时长）。

若要支持「预估工时与素材时长不一致」，需要另起功能点给 `tasks` 加列，
不要在查询层拼接。

---

## 验收

**自动**

- [ ] 标注员 A 查到 3 条：本租户 pending 的 2 条 + 自己 claimed 的 1 条
- [ ] 标注员 A **查不到**同租户 B 已领取的任务
- [ ] 标注员 A **查不到**其他租户的任何任务（含 pending）
- [ ] 管理员查到全部（跨 3 个租户）
- [ ] `countForAnnotator` 与 `listForAnnotator` 结果数一致
- [ ] 排序稳定：`created_at` 相同的两行，多次查询顺序一致
- [ ] `role='annotator'` 但 `tenantId=null` 时抛 `ForbiddenError`，**不是返回空数组**
- [ ] 现有 223 例全绿

**手工**

- [ ] 标注员访问 `/tasks` → 看到任务列表，只有自己该看的
- [ ] 管理员访问 `/tasks` → 307 跳 `/admin/tasks`
- [ ] 管理员 `/admin/tasks` → 看到全部任务，带租户列
- [ ] 标注员的列表**没有租户列**（他自己只有一个租户，这一列是噪音）
- [ ] 状态标签颜色：pending 中性、claimed 蓝、submitted 绿、rejected 红

---

## 实测记录

| # | 场景 | 结果 |
|---|---|---|
| 1 | 标注员访问 `/tasks` | 200，表格 **7 行数据** |
| 2 | 数据库算出的应可见数 | 7（本租户 1 pending + 6 自己领取） |
| 3 | 管理员访问 `/tasks` | 307 → `/admin/tasks` |
| 4 | 管理员 `/admin/tasks` | 200，**17 行**（全部任务） |
| 5 | alice 页面出现的租户名 | **只有「林小雨的工作空间」** |
| 6 | 管理员页面出现的租户名 | 「林小雨」「陈默」「周予安」三个都在 |

第 5 条是隔离的实证。行数相同也可能是「看到了别人的 7 条」，
所以必须按租户名核对——alice 的页面里一个其他租户名都不该出现。

**变异验证**：删掉 `ANNOTATOR_SCOPE` 的括号 → **7 例变红**，
其中包含「标注员看不到其他租户里挂在自己名下的任务」。

## 易错点

| 陷阱 | 后果 |
|---|---|
| 用 `(? IS NULL OR ...)` 切换角色 | 脏数据的 null 租户升级为全量视图 |
| 标注员分支缺 `status = 'pending'` 条件 | 看不到待领取的池子 |
| 标注员分支缺 `claimed_by = 自己` | 看到同事正在做的任务 |
| `WHERE` 写 `status = 'pending' OR claimed_by = ?` 却不加括号 | 与 `tenant_id` 的 AND 优先级错乱，变成「全库 pending 或本租户自己领取」 |
| `COUNT` 与 `LIST` 条件不一致 | 总数与实际条数对不上 |
| 排序只用 `created_at` | 同毫秒数据翻页重复 |
| 标注员分支写 `if (!tenantId) return []` | 数据异常被永久隐藏 |

**第 4 条要特别注意**：`AND` 的优先级高于 `OR`，不加括号会变成
`(tenant_id = ? AND status = 'pending') OR (claimed_by = ?)` —— 后半段**没有任何租户限制**。

---

## 完成后

```bash
git add -A && git commit -m "feat(D1): 任务列表与角色收窄查询"
```
