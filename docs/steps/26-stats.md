# G1 · 统计查询

**做什么**：从账本按「日」「人」「任务」三个维度聚合工作量，供 G3 的看板与 G2 的导出使用。

**依赖**：F1、F2

**预计**：1 小时

---

## 账本是唯一数据源

统计**不允许**从 `submissions` 或 `segments` 反推。理由：

- 退回是冲正（记一条负的 `revoke`），不是删记录。从 `submissions` 数行数会得到「提交过 3 次」，
  而真实工作量可能是 0（全退回了）
- 冲正记在**原提交日**，所以「某一天的净额」随时可能因为一次退回而变小。
  这是设计选择（见 `schema.sql` 里 `ledger_entries` 的注释），不是 bug

`SUM(delta_ms)` 天然处理这两点：正的加、负的减，不用额外判 `kind`。

---

## 三个维度

| 维度 | 回答的问题 | 分组键 |
|---|---|---|
| 按日 | 这几天的总量走势 | `entry_date` |
| 按人 | 每个人的工作量排名 | `annotator_id` |
| 按任务 | 这条任务被提交/退回过几次，各多少 | `task_id` |

三者的 `totalMs` 都必须是 `SUM(delta_ms)`，**包括负数**。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/repos/ledger-repo.ts` | 新增三个聚合查询 |
| `src/lib/services/stats-service.ts` | `listStats`（统一入口 + 参数校验） |
| `src/app/api/stats/route.ts` | `GET`，`?dim=day\|annotator\|task&from=&to=` |
| `tests/stats.test.ts` | 新增 |

---

## 契约（不可改动）

```ts
// repos/ledger-repo.ts
export type DayTotal = { date: string; totalMs: number; entryCount: number };
export type AnnotatorTotal = { annotatorId: string; displayName: string; totalMs: number; entryCount: number };
export type TaskTotal = {
  taskId: string;
  title: string;
  totalMs: number;
  submitCount: number;
  revokeCount: number;
};

/**
 * 三个查询的签名一致：`tenantId` 为 null 表示管理员（不加租户谓词），
 * `annotatorId` 非空时追加第二道谓词（标注员只看自己）。
 *
 * 为什么不用 `(? IS NULL OR tenant_id = ?)`：那会把「标注员因数据损坏拿到 null」
 * 静默升级成跨租户全量。null 只允许管理员传，由 service 显式决定。
 */
export function dailyTotals(db: DB, tenantId: string | null, range: DateRange, annotatorId?: string): DayTotal[];
export function annotatorTotals(db: DB, tenantId: string | null, range: DateRange, annotatorId?: string): AnnotatorTotal[];
export function taskTotals(db: DB, tenantId: string | null, range: DateRange, annotatorId?: string): TaskTotal[];

export type DateRange = { from: string; to: string };
```

```ts
// services/stats-service.ts
export type StatsDimension = 'day' | 'annotator' | 'task';

export type StatsResult =
  | { dimension: 'day'; rows: DayTotal[] }
  | { dimension: 'annotator'; rows: AnnotatorTotal[] }
  | { dimension: 'task'; rows: TaskTotal[] };

/**
 * 统计查询。
 *
 * 管理员看全租户；标注员只能看自己的（`annotatorId` 固定为自己）。
 * 这个限制在 repo 层用额外谓词实现，不在 service 里过滤结果 ——
 * 后者会先把别人的数据读进内存再丢弃，日志与性能都说不过去。
 */
export function listStats(
  db: DB,
  actor: SessionUser,
  args: { dimension: StatsDimension; from: string; to: string },
): StatsResult;
```

---

## 实现要点

### 1. 日期是字符串，按字典序比较

`entry_date` 落库就是 `YYYY-MM-DD`，所以 `WHERE entry_date >= ? AND entry_date <= ?` 直接比字符串。
**不要** `date(entry_date)` 或 `strftime`：那会让索引失效，而且等于在查询期又做一次日期换算（F1 已定：落库即定型）。

### 2. 零结果的行不补

某天没有任何账目就不出现在结果里。**不要**用 `generate_series` 之类补零 ——
SQLite 没有这个函数，而且补零是展示层的事（G3 的图表可以自己补）。

### 3. 排序固定

- 按日：`entry_date ASC`
- 按人：`totalMs DESC`（排行榜）
- 按任务：`totalMs DESC`

排序写进 SQL，不靠调用方排。两个视图各排一次必然漂移。

### 4. 标注员的可见范围

```ts
// 管理员：全部
// 标注员：自己的
const extra = actor.role === 'admin' ? '' : 'AND annotator_id = ?';
```

这条是**租户隔离之外的第二道**。少了它，标注员能看到同事的工作量——
不算严重泄漏，但「谁这周干得多」是管理信息。

### 5. 参数校验

- `dimension` 不在三个值里 → `ValidationError`
- `from` / `to` 不是 `YYYY-MM-DD` → `ValidationError`
- `from > to` → `ValidationError`（不是返回空数组：那是调用方写错了，静默返回空会让人以为"这段时间没数据"）

正则：`/^\d{4}-\d{2}-\d{2}$/`。**不要**用 `new Date(x)` 判有效性（`2026-13-45` 会变成非法 Date 但它不抛）。

---

## 验收

**自动**

- [ ] 某天两条 submit（1000 + 2000）→ `totalMs = 3000`，`entryCount = 2`
- [ ] 同一天一条 revoke（-1000）→ `totalMs` 变成 2000
- [ ] 退回后净额可以为 0，该日仍出现在结果里（`entryCount` 反映实际条目数）
- [ ] `from` / `to` 是闭区间：边界那天的账要算进来
- [ ] 区间外的不算
- [ ] 按人：两个人各自的总量正确，按 `totalMs` 降序
- [ ] 按任务：`submitCount` / `revokeCount` 分别计数正确
- [ ] **别的租户的账不计入**（构造两租户同日数据）
- [ ] 标注员只能看到自己的（同一租户两个标注员，各自的查询只出自己的）
- [ ] 管理员看到两个标注员的合计
- [ ] 非法 `dimension` / 非法日期格式 / **不存在的日历日**（`2026-02-31`、`2025-02-29`）/ `from > to` → `ValidationError`
- [ ] 现有 547 例全绿

**手工**

- [ ] `GET /api/stats?dim=day&from=2026-10-01&to=2026-10-31` 返回按日数组
- [ ] 标注员访问 `dim=annotator` 只看到自己一行

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 从 `submissions` 数行数 | 退回后仍算「干过活」，看板虚高 |
| `SUM` 时加 `WHERE kind='submit'` | 冲正被忽略，退回的活照样计数 |
| 用 `date()` / `strftime` 包裹 | 索引失效，且等于二次换算 |
| 补零填充缺失日期 | 展示层的事，混进查询层后 CSV 里全是 0 行 |
| 标注员的可见范围在 service 里过滤 | 先把别人的数据读进内存，日志与性能都不对 |
| `from > to` 返回空数组 | 调用方写错了却看不出，以为这段时间真没数据 |

---

## 完成后

```bash
git add -A && git commit -m "feat(G1): 统计查询，账本是唯一数据源"
```

**下一步**：G2 CSV 导出（复用同一套查询）。
