# F1 · 提交事务

**做什么**：把草稿态片段固化成一个提交，写进账本，任务转 `submitted`。

**依赖**：E4

**预计**：1.5 小时

---

## 这是第一个「不可逆」的操作

E 组的所有改动都是草稿态，改坏了再拖一次就行。F1 不一样：

- 片段被**固化**进 `submissions.segments_json`，之后的任务与它无关
- 账本**只追加**，记了就记了（撤销靠 F2 的冲正，不是删除）
- 任务转 `submitted`，标注员改不了了

所以这一步的核心不是「怎么写数据」，而是**这四件事必须在同一个事务里，
要么全成，要么全不成**：

| # | 写什么 | 失败后果（若不原子） |
|---|---|---|
| 1 | `submissions` 一行（含片段快照） | — |
| 2 | `ledger_entries` 一行（`kind='submit'`, `delta_ms=total_ms`） | 有提交无账 → 统计少算 |
| 3 | `tasks.status = 'submitted'` | 有提交但任务还能改 → 数据与快照分叉 |
| 4 | `audit_logs` 一行 | 事后查不到谁提交的 |

---

## 三个必须想清楚的点

### 1. 时区：`local_date` 按租户时区算，不按服务器

`submissions.local_date` 与 `ledger_entries.entry_date` 都是「哪一天的工作量」。

服务器可能在 UTC，标注员在 Asia/Shanghai。用服务器时区算的话，
晚上 8 点之后的提交会算到"昨天"——而人明明是今天干的活。

`tenants.timezone` 字段就是为这个存在的（A1 建的表）。
用 `Intl.DateTimeFormat` 按该时区格式化，不要手写时区偏移。

### 2. `total_ms` 是片段时长之和，不是视频时长

一条 30 分钟的视频只标了 3 分钟有效操作，计入的是 3 分钟。

```ts
const totalMs = segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
```

这也解释了 `submissions` 的 `CHECK (total_ms > 0)`：
没标任何片段就不该提交（`segment_count > 0` 同理）。

### 3. 空片段必须拒绝，且在事务之前

`CHECK` 约束会拦住，但那时事务已经开了、错误信息是 SQLite 的。

在 service 层先判：`if (segments.length === 0) throw new StateConflictError('还没有标注任何片段')`。

**这条判据要在事务外**：它只读不写，没必要持锁。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/repos/submission-repo.ts` | `insertSubmission`、`findLatestByTask` |
| `src/lib/db/repos/ledger-repo.ts` | `insertEntry`、`sumByDate`（后者给 G3 用，本步可先只写 insert） |
| `src/lib/services/submit-service.ts` | `submitTask`（编排 + 事务） |
| `src/lib/services/daily-date.ts` | `localDateOf(instant, timezone)` 纯函数 |
| `src/app/api/tasks/[id]/submit/route.ts` | `POST` |
| `tests/submit.test.ts` | 新增 |

---

## 契约（不可改动）

```ts
// services/daily-date.ts
/**
 * 某一瞬间在指定时区是哪一个日历日（YYYY-MM-DD）。
 * 不依赖服务器本地时区：同一份代码在 UTC 机器与 Asia/Shanghai 机器上必须给出相同结果。
 */
export function localDateOf(instantMs: number, timezone: string): string;
```

```ts
// services/submit-service.ts
export type SubmitResult = {
  submissionId: string;
  totalMs: number;
  segmentCount: number;
};

/**
 * 提交任务。
 *
 * 前置：本人领取、状态 claimed、至少有 1 个片段。
 * 四写入同一事务：submissions + ledger_entries + tasks.status + audit_logs。
 */
export function submitTask(db: DB, actor: TenantUser, taskId: string): SubmitResult;
```

```ts
// repos/submission-repo.ts
export type SubmissionInsert = {
  id: string;
  taskId: string;
  tenantId: string;
  annotatorId: string;
  submittedAt: number;
  localDate: string;
  totalMs: number;
  segmentCount: number;
  segmentsJson: string;
  createdAt: number;
};
export function insertSubmission(db: DB, row: SubmissionInsert): void;
export function findLatestByTask(db: DB, tenantId: string, taskId: string): SubmissionRow | null;
```

---

## 实现要点

### 1. 事务边界

```ts
return writeTx(db, () => {
  const task = requireWritableTask(db, actor, taskId);   // 归属 + 状态
  const segments = listByTask(db, task.tenantId, taskId);
  if (segments.length === 0) throw new StateConflictError('还没有标注任何片段');
  // 下面四写都在同一个 writeTx 内
  ...
});
```

`writeTx` 用的是 `BEGIN IMMEDIATE`，写锁在回调之前就拿到 ——
两个并发的提交请求，第二个会在 `requireWritableTask` 读到 `submitted` 而抛 409。

### 2. `segments_json` 存什么

存**快照**，不是引用。字段与 `GET /segments` 的返回一致（`startMs` / `endMs` / `label`），
但**不要 `id`** —— 这是历史记录，id 属于草稿态，固化后没有意义。

```json
[{ "startMs": 1000, "endMs": 5000, "label": null }]
```

### 3. 审计用 `strict` 模式

提交是一次不可逆操作，审计写失败必须让整个事务回滚。

```ts
writeAudit(db, { action: 'task.submit', ... }, { strict: true });
```

A4 的 `writeAudit` 默认是旁路模式（吞错），必须显式传 `strict`。

### 4. 幂等

重复提交同一任务 → 第二次时 `status` 已是 `submitted`，`requireWritableTask` 抛 409。

**不要**做成「返回上次的 submission」：幂等键是客户端的事，
服务端只保证「不会提交两次」。

### 5. 提交后不要再改片段

`segments` 表的行**保持不动**（不删）。它们仍是任务的工作记录，
只是任务状态变了、写路径被 `requireWritableTask` 挡住。

---

## 验收

**自动**

- [ ] `localDateOf(0, 'Asia/Shanghai')` → `'1970-01-01'`
- [ ] `localDateOf(0, 'UTC')` → `'1970-01-01'`
- [ ] 同一瞬间在 `Asia/Shanghai` 与 `UTC` 得到不同日期（构造 16:00 UTC = 次日 00:00 +08）
- [ ] 非法时区抛错，不是静默用 UTC
- [ ] 提交成功：`submissions` 一行、`ledger_entries` 一行、`tasks.status` 变 `submitted`
- [ ] `total_ms` 等于片段时长之和（不是视频时长）
- [ ] `segments_json` 解析后不含 `id`
- [ ] 空片段提交 → `StateConflictError`，且四张表都没变
- [ ] 重复提交 → `StateConflictError`，且 `submissions` 仍只有一行
- [ ] 已提交任务提交 → `StateConflictError`
- [ ] 别人的任务提交 → `NotFoundError`
- [ ] 审计失败（用触发器或 mock）→ 整个提交回滚
- [ ] 现有 501 例全绿

**手工**

- [ ] 标 3 段 → 点提交 → 任务列表显示「已提交」，片段列表只读
- [ ] 账本页/G3 能看到当天总量增加

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 用服务器时区算 `local_date` | 晚上 8 点后的提交算到前一天 |
| `total_ms` 用视频时长 | 统计虚高，看板数字没有意义 |
| 四写不在同一事务 | 有提交无账、或有账无提交 |
| 审计用默认旁路模式 | 审计写失败被吞，提交成功但查不到记录 |
| `segments_json` 带 id | 历史记录里混进草稿态标识 |
| 空片段检查放在事务内 | 持锁做只读判断，无谓阻塞 |
| 提交后删掉 segments 行 | 丢失工作记录，F2 退回时无从恢复 |

---

## 完成后

```bash
git add -A && git commit -m "feat(F1): 提交事务，四写入同一事务"
```

**下一步**：F2 退回（冲正），F3 界面入口。
