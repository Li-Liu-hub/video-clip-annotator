# D2 · 管理员建任务

**做什么**：选一个视频，勾选若干租户，填标题，一次为每个租户建一条任务。

**依赖**：D1 C2

**预计**：1 小时

---

## 为什么是「一次建多条」

一段视频要发给 3 个租户标注。若一次只能建一条，管理员要点 3 遍、容易漏。
所以输入是 `tenantIds: string[]`，一次产出 N 条任务。

这带来两个必须处理的问题：

1. **事务性**：第 2 个租户失败时，第 1 个不能留下——要么全成，要么全不成
2. **重复提交**：网络慢时管理员连点两下，会产生两套任务

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/repos/task-repo.ts` | **追加** `insertTask` |
| `src/lib/services/task-service.ts` | **追加** `createTasks` |
| `src/app/api/tasks/route.ts` | POST 建任务（管理员） |
| `src/app/admin/tasks/new/page.tsx` | 页面（Server Component） |
| `src/app/admin/tasks/new/TaskForm.tsx` | 客户端表单 |
| `src/app/admin/tasks/page.tsx` | 加「新建任务」入口 |
| `tests/task-create.test.ts` | 新增 |

---

## 契约（不可改动）

### `src/lib/services/task-service.ts` 追加

```ts
export type CreateTasksInput = {
  videoId: string;
  tenantIds: string[];
  title: string;
  description?: string;
};

export const MAX_TITLE_LENGTH = 100;

/**
 * 为每个租户各建一条任务，全部成功或全部不落库。
 * 调用方必须已确认是管理员。
 */
export function createTasks(db: DB, actor: SessionUser, input: CreateTasksInput): { ids: string[] };
```

抛错约定：

| 情况 | 错误 | 状态码 |
|---|---|---|
| title 为空 / 超过 100 字 | `ValidationError` | 400 |
| `tenantIds` 为空 | `ValidationError` | 400 |
| 视频不存在 | `NotFoundError` | 404 |
| 任一租户不存在 | `NotFoundError` | 404 |

### `src/lib/db/repos/task-repo.ts` 追加

```ts
export function insertTask(db: DB, row: {
  id: string;
  tenantId: string;
  videoId: string;
  title: string;
  description: string | null;
  createdBy: string;
  createdAt: number;
}): void;
```

### API

**POST `/api/tasks`**（仅管理员）

```
请求：{ videoId, tenantIds: string[], title, description? }
成功：200 { ok: true, ids: string[] }
400 / 404 见上表
403 非管理员
```

---

## 实现要点

### 1. 一个事务包住所有插入

```ts
return writeTx(db, () => {
  const ids = tenantIds.map((tenantId) => {
    const id = newId();
    insertTask(db, { id, tenantId, videoId, title, description: description ?? null, createdBy: actor.id, createdAt: nowMs() });
    return id;
  });
  return { ids };
});
```

`writeTx` 已在 `lib/db` 里，直接复用。
**不要**在循环里各自提交——第 3 个租户不存在时，前两个已经落库了。

### 2. 先整体校验，再写入

```ts
// 先查一遍，别在事务里靠抛错回滚来校验
const video = findVideoById(db, videoId);
if (!video) throw new NotFoundError('视频不存在');

const unique = [...new Set(tenantIds)];
for (const id of unique) {
  if (!findTenantById(db, id)) throw new NotFoundError('租户不存在');
}
```

事务回滚能保证一致性，但「先校验」能让错误信息更准（哪个租户不存在），
也避免在事务里做无谓的写入再撤销。

### 3. `tenantIds` 必须去重

前端多选可能因为 React key 问题传上重复 id。不去重会建出两条一模一样的任务。

```ts
const unique = [...new Set(tenantIds)];
if (unique.length === 0) throw new ValidationError('请至少选择一个租户');
```

### 4. 重复提交的防护放在前端

后端**不做**「同视频+同租户+同标题」的唯一约束——业务上允许同名任务（比如重标）。

前端用 `disabled` 锁住按钮，提交中不接受第二次点击。
这属于体验优化，不是安全边界：真正重复了也能在列表里看到两条，管理员可核对。

### 5. 审计：每条任务一条记录

```ts
writeAudit(db, {
  actorId: actor.id, actorRole: actor.role, tenantId,
  action: 'task.create', targetType: 'task', targetId: id,
  detail: { videoId, title },
});
```

审计在事务内（`writeTx` 里调用），保证「任务存在」与「审计存在」一致。

---

## 页面要求

**布局**（`/admin/tasks/new`）：

```
┌─ 新建任务 ─────────────────────────┐
│ ① 选择视频                          │
│   [卡片] aloha-coffee.mp4  00:30 2MB│
│   [卡片] pusht-pushblock.mp4 ...    │
│                                     │
│ ② 发布给哪些租户（可多选）           │
│   ☑ 林小雨的工作空间                 │
│   ☐ 陈默的工作空间                   │
│                                     │
│ ③ 任务标题  [___________________]   │
│   描述（可选）[________________]     │
│                                     │
│              [取消]  [创建 N 条任务] │
└─────────────────────────────────────┘
```

- 视频卡片单选，选中态明显
- 租户多选，每个显示该租户当前任务数（帮助管理员判断负载）
- 按钮文案随选中租户数变化：「创建 3 条任务」
- 未选视频或未选租户时按钮禁用
- 成功后跳转 `/admin/tasks` 并刷新

**空态**：没有视频时提示先去上传，并给链接。

---

## 验收

**自动**

- [ ] 给 2 个租户建任务 → 返回 2 个 id，库中新增 2 行
- [ ] 其中 1 个租户不存在 → 抛 `NotFoundError`，**库中一行都没新增**
- [ ] 视频不存在 → `NotFoundError`，无写入
- [ ] `title` 为空 → `ValidationError`
- [ ] `title` 超过 100 字 → `ValidationError`
- [ ] `tenantIds` 为空数组 → `ValidationError`
- [ ] `tenantIds` 含重复项 → 只建 1 条
- [ ] 非管理员调用 API → 403
- [ ] 创建的任务 `status` 为 `pending`、`claimed_by` 为 null
- [ ] 每条任务都写了一条 `task.create` 审计
- [ ] 现有 248 例全绿

**手工**

- [ ] 管理员在页面能选视频、勾租户、建任务
- [ ] 建完后 `/admin/tasks` 能看到新任务
- [ ] 标注员在 `/tasks` 能看到发给自己的新任务（`pending`）
- [ ] 未选租户时按钮禁用
- [ ] 连续点击创建按钮只产生一批任务

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 循环里各自提交 | 中途失败留下半批任务，管理员不知道哪些建了 |
| 事务里靠抛错做校验 | 错误信息只能给「失败」，说不出是哪个租户不存在 |
| `tenantIds` 不去重 | 前端 bug 导致同一租户建出两条 |
| 把 `tenantId` 从表单里当权限依据 | 这不是越权——管理员本来就能建任意租户的任务；但**不能**让标注员调这个接口 |
| 审计写在事务外 | 任务建了但审计没写，追溯断链 |
| 成功后不刷新列表 | 返回上一页看不到新任务，以为失败了 |

---

## 实测记录

| # | 场景 | 结果 |
|---|---|---|
| 1 | 为 2 个租户建任务 | 200，返回 2 个 id，库中新增 2 行（`pending`，`claimed_by` 为 null） |
| 2 | 审计 | 17 条种子 + 2 条新建 = 19 条 `task.create` |
| 3 | 标注员能否看到 | alice 的 `/tasks` 从 7 行增至 8 行，新任务出现在列表里 |
| 4 | 混入不存在的租户 | 404 `NOT_FOUND`，**任务数 19 → 19 不变** |

第 4 条是事务的实证：单测里验过，真实请求下再验一次。

## 实现时发现并修掉的两个问题

### 1. `createTasks` 声称有事务，实际没有

初版写成了立即执行函数，但漏了末尾的 `()`，结果 `return` 的是函数本身而非结果——
`tsc` 报 `Type '() => {...}' is not assignable to '{ ids }'`。

更值得注意的是：注释里写着「所有插入与审计共用一个事务」，
但代码里**根本没有调用 `writeTx`**。补上之后做了变异验证：
把 `writeTx` 换回普通 IIFE，「任一租户不存在时任务表的行数与调用前完全相同」
立刻变红——说明这条断言确实有牙。

### 2. 任务列表看不出任务之间的区别

D1 的表格只有「视频」列。种子任务都引用同一个 `aloha-coffee.mp4`，
新建任务之后，列表里每行长得一模一样，**管理员无法确认自己刚建的是哪一条**。

已把列改为「任务」：标题作主行，视频名作副行。同素材多任务是常态，
文件名不足以区分。

## 完成后

```bash
git add -A && git commit -m "feat(D2): 管理员建任务，支持一次发布给多个租户"
```
