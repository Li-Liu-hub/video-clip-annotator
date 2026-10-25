# H2 · 审计查询页

**做什么**：管理员能看到「谁在什么时候做了什么」，能按动作与人筛选。

**依赖**：H1、B2

**预计**：0.5 小时

---

## 审计页是只读的，而且是唯一的

其他地方都允许「改错了再改回来」，这个页面不行：

- **不提供删除**，一条也不提供。审计的价值在于「不能被人事后擦掉」
- **不提供编辑**。哪怕是「补一句备注」也不行——那会让记录变成观点
- 分页而不是「加载全部」：审计只增不减，一年后这张表会很大

---

## 列表要显示什么

| 列 | 说明 |
|---|---|
| 时间 | 按租户时区显示到秒 |
| 谁 | `displayName`；`actor_id` 为 NULL 时显示 `detail.username`（登录失败） |
| 动作 | `task.submit` 这类；用中文标签，不直接把 raw action 摆给用户 |
| 对象 | 任务标题（能 join 到就显示，join 不到就显示 id 前 8 位） |
| 详情 | 折叠，展开看 `detail` 的键值 |

**「谁」这一列是本页最容易做错的地方**：登录失败的那条 `actor_id` 是 NULL，
直接显示「未知」就把唯一的线索丢了。要回落到 `detail.username`。

---

## 筛选

- 动作：下拉，选项来自 `AUDIT_ACTIONS`（不是从库里 `SELECT DISTINCT`——
  那会让一个新动作在没人用过之前不出现在筛选里）
- 人：下拉本租户用户
- 时间：默认最近 7 天

三个条件都进 URL，与 G3 同一套做法。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/repos/audit-repo.ts` | `listAudit`（分页 + 筛选）、`countAudit` |
| `src/lib/services/audit-query-service.ts` | `listAuditLogs`（只有管理员） |
| `src/app/admin/audit/page.tsx` | 页面（服务端组件） |
| `src/app/admin/audit/AuditTable.tsx` | 表格（客户端，处理折叠） |
| `src/lib/audit-labels.ts` | action → 中文标签 |
| `tests/audit-query.test.ts` | 新增 |

---

## 契约（不可改动）

```ts
// repos/audit-repo.ts
export type AuditRow = {
  id: string;
  createdAt: number;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
  /** 由 detail 解析出的用户名，登录失败时才有值 */
  attemptedUsername: string | null;
};

export type AuditFilter = {
  action?: string;
  actorId?: string;
  fromMs: number;
  toMs: number;
};

export function listAudit(db: DB, filter: AuditFilter, page: { limit: number; offset: number }): AuditRow[];
export function countAudit(db: DB, filter: AuditFilter): number;
```

```ts
// services/audit-query-service.ts
/** 只有管理员。标注员连自己的审计也看不到 —— 那是管理信息。 */
export function listAuditLogs(
  db: DB,
  actor: SessionUser,
  filter: AuditFilter,
  page: { limit: number; offset: number },
): { rows: AuditRow[]; total: number };
```

---

## 实现要点

### 1. `attemptedUsername` 在 SQL 里解不出来

`detail` 是 TEXT 存的 JSON。SQLite 的 `json_extract` 可用，但**不要在 SQL 里解**：

- 老数据的 `detail` 可能不是合法 JSON，`json_extract` 会抛错，整页 500
- 解析失败应该降级成 `null`，而不是让页面挂掉

在 repo 里读出来后用 `JSON.parse` 包 try/catch 解。

### 2. 管理员的 `tenant_id` 是 NULL

审计表里 `tenant_id` 也是 NULL（管理员全局操作）。
所以**不能**用 `WHERE tenant_id = ?` 过滤管理员的查询——那会得到空结果。

按 `action` 与 `actorId` 筛，不按租户筛。这是与其余所有查询不同的地方，注释要写清。

### 3. 时间倒序，且分页要稳定

`ORDER BY created_at DESC, id DESC`。

只按 `created_at` 排的话，同一毫秒的两条记录在两次查询里顺序可能不同，
翻页时会出现「第一条在第二页又出现一次」。

### 4. 中文标签表

```ts
const LABELS: Record<string, string> = {
  'task.create': '创建任务',
  'task.submit': '提交任务',
  ...
};
```

**未知 action 回落到 raw 值**，不是「未知动作」——库里可能有枚举之外的历史值，
直接显示原文比显示「未知」有用。

### 5. 详情默认折叠

`detail` 可能很长（`segments_json` 不在这里，但 `reason` 可以有 200 字）。
默认只显示前 60 字 + 展开按钮。

---

## 验收

**自动**

- [ ] 按时间倒序返回
- [ ] `action` 筛选生效
- [ ] `actorId` 筛选生效
- [ ] 时间区间是闭区间
- [ ] 分页：`limit/offset` 正确，`total` 是筛选后的总数
- [ ] 同一毫秒的两条记录，翻页不重复（`id` 作为二级排序键）
- [ ] 登录失败的记录 `attemptedUsername` 解出来了
- [ ] `detail` 是坏 JSON 时 `attemptedUsername` 为 null，**不抛错**
- [ ] 标注员调用 `listAuditLogs` → 403
- [ ] 现有 656 例全绿

**手工**

- [ ] 管理员打开 /admin/audit → 能看到最近的提交、退回、登录
- [ ] 故意登录失败一次 → 列表里出现「未知用户」+ 你输的用户名
- [ ] 筛选「提交任务」→ 只剩提交记录
- [ ] 展开详情 → 看到 `totalMs` / `localDate`

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 管理员的查询加了 `tenant_id = ?` | 管理员全局操作的行 `tenant_id` 是 NULL，查出来是空 |
| 在 SQL 里 `json_extract` | 一条坏数据让整页 500 |
| 只按 `created_at` 排序 | 同毫秒记录翻页重复 |
| 未知 action 显示「未知」 | 丢掉库里真实的历史值 |
| 提供删除按钮 | 审计可被擦掉，这张表就没有意义了 |
| 登录失败显示「未知」 | 丢掉唯一的线索（`detail.username`） |

---

## 完成后

```bash
git add -A && git commit -m "feat(H2): 审计查询页，只读且按动作/人筛选"
```

**H 组到此完成。项目全部功能点结束。**

**下一步**：全面测试（全链路手工验收 + 回归）。
