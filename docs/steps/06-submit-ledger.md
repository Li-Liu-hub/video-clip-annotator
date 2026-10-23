# STEP 06 · 提交与记账 ★

**目标**：提交动作产生快照与账本记录；退回产生冲正；历史日期永不变动。

**前置**：05 完成（有片段可提交）

**预计**：2 小时

**这是全部设计里最不能出错的一步。** 前面的工作都是为这里服务的。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/services/submissionService.ts` | 提交、退回 |
| `src/lib/db/repos/submissionRepo.ts` | 快照与查询 |
| `src/lib/db/repos/ledgerRepo.ts` | 账本写入与汇总 |
| `src/app/api/tasks/[id]/submit/route.ts` | 提交 |
| `src/app/api/tasks/[id]/reject/route.ts` | 退回（管理员） |

---

## 提交事务（完整实现）

整段必须在**一个** `BEGIN IMMEDIATE` 事务里，任何一步失败全部回滚。

```ts
export function submitTask(db: DB, actor: SessionUser, taskId: string) {
  return writeTx(db, (tx) => {
    const now = Date.now();

    // ① 取任务并校验归属
    const task = tx.prepare(
      `SELECT * FROM tasks WHERE id = ? AND tenant_id = ?`
    ).get(taskId, actor.tenantId) as TaskRow | undefined;

    if (!task || task.claimed_by !== actor.id) throw new NotFoundError();
    if (task.status !== 'claimed' && task.status !== 'rejected') {
      throw new StateConflictError(`当前状态 ${task.status} 无法提交`);
    }

    // ② 取片段并校验
    const segments = tx.prepare(
      `SELECT * FROM segments WHERE task_id = ? ORDER BY start_ms`
    ).all(taskId) as SegmentRow[];

    if (segments.length === 0) throw new ValidationError('没有可提交的片段');
    if (segments.length > 500) throw new ValidationError('片段数量超过上限');

    const totalMs = segments.reduce((sum, s) => sum + (s.end_ms - s.start_ms), 0);
    if (totalMs <= 0) throw new ValidationError('有效时长必须大于 0');

    // ③ 计算计入日期（固化，查询期不再算）
    const tenant = tx.prepare(`SELECT timezone FROM tenants WHERE id = ?`).get(task.tenant_id);
    const localDate = localDateOf(now, tenant.timezone);

    const submissionId = newId();

    // ④ 若原状态是 rejected，先冲正上一笔
    if (task.status === 'rejected') {
      const prev = tx.prepare(
        `SELECT * FROM submissions WHERE task_id = ? AND superseded_by IS NULL`
      ).get(taskId) as SubmissionRow | undefined;

      if (prev) {
        tx.prepare(
          `INSERT INTO ledger_entries
             (id, tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date, kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'revoke', ?)`
        ).run(newId(), task.tenant_id, taskId, prev.id, prev.annotator_id,
              -prev.total_ms, localDate, now);

        tx.prepare(`UPDATE submissions SET superseded_by = ? WHERE id = ?`)
          .run(submissionId, prev.id);
      }
    }

    // ⑤ 写快照
    tx.prepare(
      `INSERT INTO submissions
         (id, task_id, tenant_id, annotator_id, submitted_at, local_date,
          total_ms, segment_count, segments_json, superseded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    ).run(submissionId, taskId, task.tenant_id, actor.id, now, localDate,
          totalMs, segments.length,
          JSON.stringify(segments.map((s) => ({
            startMs: s.start_ms, endMs: s.end_ms, label: s.label,
          }))),
          now);

    // ⑥ 记账（正数）
    tx.prepare(
      `INSERT INTO ledger_entries
         (id, tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'submit', ?)`
    ).run(newId(), task.tenant_id, taskId, submissionId, actor.id, totalMs, localDate, now);

    // ⑦ 更新任务
    tx.prepare(
      `UPDATE tasks
          SET status = 'submitted',
              first_submitted_at = COALESCE(first_submitted_at, ?),
              reject_reason = NULL
        WHERE id = ?`
    ).run(now, taskId);

    // ⑧ 审计
    writeAudit(tx, actor, 'task.submit', 'task', taskId,
               { totalMs, segmentCount: segments.length, submissionId });

    return { submissionId, totalMs, localDate };
  });
}
```

**顺序不能乱**：必须先冲正、再写新快照、最后改状态。
若先改状态再冲正，中间任何失败都会留下「状态是 submitted 但没有对应账本」的脏数据。

---

## 退回事务

```ts
export function rejectTask(db: DB, actor: SessionUser, taskId: string, reason: string) {
  return writeTx(db, (tx) => {
    const now = Date.now();

    const task = tx.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow;
    if (!task) throw new NotFoundError();
    if (actor.role !== 'admin') throw new ForbiddenError();
    if (task.status !== 'submitted') throw new StateConflictError('只有已提交的任务可以退回');

    const prev = tx.prepare(
      `SELECT * FROM submissions WHERE task_id = ? AND superseded_by IS NULL`
    ).get(taskId) as SubmissionRow;
    if (!prev) throw new StateConflictError('找不到对应的提交记录');

    const tenant = tx.prepare(`SELECT timezone FROM tenants WHERE id = ?`).get(task.tenant_id);
    const localDate = localDateOf(now, tenant.timezone);   // ← 记在「退回日」

    tx.prepare(
      `INSERT INTO ledger_entries
         (id, tenant_id, task_id, submission_id, annotator_id, delta_ms, entry_date, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'revoke', ?)`
    ).run(newId(), task.tenant_id, taskId, prev.id, prev.annotator_id,
          -prev.total_ms, localDate, now);

    tx.prepare(
      `UPDATE tasks SET status = 'rejected', reject_reason = ? WHERE id = ?`
    ).run(reason, taskId);

    writeAudit(tx, actor, 'task.reject', 'task', taskId,
               { reason, prevTotalMs: prev.total_ms });

    return { revokedMs: prev.total_ms };
  });
}
```

**`submissions` 一行都不改。** 它记录的是「那次提交发生了什么」，退回是另一个事件。
`superseded_by` 只在**重新提交**时设置，不在退回时设置。

---

## 退回后重新提交会怎样

| 时刻 | 动作 | submissions | ledger |
|---|---|---|---|
| D1 15:40 | 提交 2:00 | A（有效） | `+2:00 @ D1` |
| D2 09:11 | 退回 | A（仍有效，状态是 rejected） | `−2:00 @ D2` |
| D2 10:40 | 重新提交 1:35 | A.superseded_by=B，B（有效） | `+1:35 @ D2` |

汇总：D1 = 2:00（**永远不变**），D2 = −2:00 + 1:35 = **−0:25**。

负数是可解释的净差——比「昨天的数字凭空消失」好得多。这一点要写进 report。

---

## 关于「最后一次提交」的定义

`superseded_by IS NULL` 表示「最后一次提交」，它有两种含义：

| 任务状态 | 含义 |
|---|---|
| `submitted` | 当前有效提交（计入时长） |
| `rejected` | 待修正的那次（已冲正，不计入） |

写查询时不要假设「`superseded_by IS NULL` 就等于有效」。要结合任务状态判断。

---

## 验收标准

- [ ] 提交后 `tasks.status = 'submitted'`，`first_submitted_at` 有值
- [ ] `submissions` 新增一条，`segments_json` 内容与提交时一致
- [ ] `ledger_entries` 新增一条 `kind='submit'`、`delta_ms > 0`
- [ ] 提交后片段不可编辑（API 返回 409）
- [ ] 管理员退回 → `ledger_entries` 新增 `kind='revoke'`、`delta_ms` 为负
- [ ] 退回后修改片段并重新提交 → 旧 submission 的 `superseded_by` 指向新 id
- [ ] **历史核对**：退回后重新查询前一天的汇总，数值与退回前完全一致
- [ ] 无片段时提交 → 400
- [ ] 空事务测试：让第 ⑥ 步抛错，确认第 ⑤ 步的 submission 没有被写入（整段回滚）

---

## 容易错的地方

| 陷阱 | 后果 |
|---|---|
| 冲正记在「原提交日」而不是「退回日」 | 历史数字被改写，整个设计的意义消失 |
| 忘记 `superseded_by` 标记 | 同一任务出现两条「有效」提交，统计翻倍 |
| 用 `new Date().toISOString().slice(0,10)` 取日期 | 用的是 UTC 日期，跨时区会错一天 |
| 事务外写审计 | 可能业务成功但审计失败，或反之 |
| 提交时重新计算 `total_ms` 而不是从片段求和 | 与快照不一致 |
| 先改任务状态再写账本 | 失败时留下状态与账本不匹配的脏数据 |

---

## 完成后

M3 达成：完整闭环成立。现在数据能进去，也能算出来。剩下三步都是「让它更可信」。
