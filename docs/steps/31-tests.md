# I1 · 五组不变量测试

**做什么**：把散落在各功能点里的「数据不该变成什么样」抽成五组不变量，
用真实的写路径（不是直接 INSERT）产生数据，然后断言它们。

**依赖**：F1、F2、G1

**预计**：1.5 小时

---

## 为什么单元测试不够，还需要这个

707 例单测每一条都在验「这个函数按我以为的方式工作」。
但它们共用一个盲区：**没人验「这些函数一起用完之后，数据还是不是自洽的」**。

已经出现过三次同类问题：

- F1 的提交写了四张表，单独的测试都过，但没人验「快照与账本的日期是否一致」
- F2 的退回冲正，「冲正记原提交日」这条只在 F2 自己的用例里验过
- E8 的撤销方向，栈操作测得扎实，但调用点传 before 还是 after **实测改错后 510 例全绿**

不变量测试换一个角度：**不验函数的返回值，验数据的关系**。

---

## 五组不变量

### I-1 账本自洽

```
对任意任务：net(task) = Σ ledger_entries.delta_ms
           且 net(task) >= 0
           且 net(task) 只在「当前有效提交」存续时为正
```

**为什么净额不能为负**：冲正只能冲掉已有的提交。若出现负数，说明冲了两次，
或冲了一条不属于它的记录 —— 这是缺陷，不是业务状态。

### I-2 快照唯一

```
对任意任务：submissions 中 superseded_by IS NULL 的行数 ∈ {0, 1}
```

提交两次而旧快照没被标记 superseded，会导致同一个任务算两份工作量。

### I-3 账本与快照同源

```
对每条 submit 类型的账目：
  exists submission s
    s.id = entry.submission_id
    s.total_ms = entry.delta_ms
    s.local_date = entry.entry_date
    s.task_id = entry.task_id
```

这是「账本不能凭空长出来」的机械表达。它同时挡住了：
写账时用了错误的 submission_id、用了错误的日期、金额算错。

### I-4 状态与领取人同步

```
tasks.status = 'pending'  ⟺  claimed_by IS NULL
tasks.status ≠ 'pending'  ⟺  claimed_by IS NOT NULL
```

schema 里有 CHECK 强制这条。不变量测试验的是**经过所有业务流程后它仍成立** ——
CHECK 只在单条 UPDATE 时生效，跨两条 UPDATE 的组合它管不了。

### I-5 租户一致

```
segments.tenant_id      = tasks.tenant_id      （按 task_id 关联）
submissions.tenant_id   = tasks.tenant_id
ledger_entries.tenant_id = tasks.tenant_id
tasks.tenant_id         = videos 所属租户？ —— 不成立，视频可跨租户复用
```

前三条必须成立。任何一条被破坏，跨租户统计会算错，而界面上看不出来。

---

## 必须走真实写路径

```ts
// 对：用 service 产生数据
await claimTask(db, alice, taskId);
await createSegment(db, alice, taskId, { startMs, endMs });
await submitTask(db, alice, taskId);
await rejectTask(db, admin, taskId, '原因');
await reopenTask(db, alice, taskId);
await submitTask(db, alice, taskId);

assertInvariants(db);   // 五组，全过
```

```ts
// 错：直接 INSERT 造「看起来对」的数据
db.prepare('INSERT INTO ledger_entries ...').run(...);
```

理由：直接 INSERT 只能证明「我造的数据满足不变量」，
证明不了「业务流程产出的数据满足不变量」。而后者才是要验的东西。

**唯一例外**：为了构造「违反不变量的数据」做反例（证明检查器真的能报错），
必须直插。这类用例要在注释里写明「这里是故意造脏数据」。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/invariants.ts` | 五组检查函数 + `assertInvariants` 汇总 |
| `tests/invariants.test.ts` | 每个不变量一组：真实路径产数据 → 检查通过；直插脏数据 → 检查报错 |
| `scripts/invariant-check.mjs` | 对真实库跑一遍（I2 会用到） |

---

## 契约（不可改动）

```ts
// lib/invariants.ts
export type Violation = {
  rule: 'ledger-sum' | 'ledger-non-negative' | 'snapshot-unique' | 'ledger-snapshot-match' | 'status-claimed-pair' | 'tenant-consistency';
  /** 违反的那一行（任务 id / 账本 id），便于直接去库里查 */
  subject: string;
  detail: string;
};

/** 返回所有违反项。空数组表示全部成立。 */
export function findViolations(db: DB): Violation[];

/** 有违反项就抛错，消息里带上前三条。测试与脚本共用。 */
export function assertInvariants(db: DB): void;
```

---

## 实现要点

### 1. 检查用 SQL 做，不要拉全表到 JS

```sql
-- I-1 第一半：净额与逐条之和对不上
SELECT task_id FROM (
  SELECT task_id, SUM(delta_ms) AS net FROM ledger_entries GROUP BY task_id
) l
WHERE l.net <> (SELECT SUM(delta_ms) FROM ledger_entries e WHERE e.task_id = l.task_id)
```

这条其实是自证的（两边同一个表达式），真正有价值的是**第二半**：

```sql
-- I-1 第二半：净额为负
SELECT task_id, SUM(delta_ms) AS net
  FROM ledger_entries GROUP BY task_id HAVING net < 0
```

**不要**写第一条那样的自证式检查。要写能找到真实问题的断言。

### 2. I-3 要 join，且允许「冲正没有对应快照」的情况

`revoke` 类型的账目也带 `submission_id`（指向被冲的那条）。
所以 I-3 只约束 `kind = 'submit'` 的行，revoke 的约束是「指向的快照必须存在」：

```sql
-- revoke 指向的快照必须存在且金额相反
SELECT r.id FROM ledger_entries r
  LEFT JOIN submissions s ON s.id = r.submission_id
 WHERE r.kind = 'revoke'
   AND (s.id IS NULL OR -r.delta_ms <> s.total_ms)
```

### 3. 报告要能定位

`subject` 必须是能直接拿去 `WHERE id = ?` 的值。写成「第 3 行不对」等于没报。

### 4. `assertInvariants` 的消息带前三条

调试时最想看的是第一个违反项。全量列表交给 `findViolations`。

---

## 验收

**自动**

- [ ] 空库：`findViolations` 返回 `[]`
- [ ] 正常链路（claim → 标注 → 提交）：返回 `[]`
- [ ] 提交 → 退回：返回 `[]`（净额归零但不为负）
- [ ] 退回 → 重新打开 → 再提交：返回 `[]`
- [ ] 直插「净额为负」的账目 → 报 `ledger-non-negative`
- [ ] 直插两条 `superseded_by IS NULL` 的快照 → 报 `snapshot-unique`
- [ ] 直插「账本金额与快照不一致」→ 报 `ledger-snapshot-match`
- [ ] 直插「revoke 指向不存在的快照」→ 报 `ledger-snapshot-match`
- [ ] 直插「submitted 但 claimed_by 为 NULL」→ 报 `status-claimed-pair`
- [ ] 直插「segment 的 tenant_id 与任务不同」→ 报 `tenant-consistency`
- [ ] `assertInvariants` 在有违反时抛错，消息含 rule 名与前三条
- [ ] 现有 707 例全绿

**手工**

- [ ] `node scripts/invariant-check.mjs` 对种子库返回「0 项违反」

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 用直接 INSERT 造「正常数据」 | 只证明造的数据对，不证明业务流程对 |
| 写自证式 SQL（两边同一个表达式） | 恒真，永远不报 |
| `subject` 不是主键 | 报告没法定位 |
| 只检查「有违反就抛」不检查「没违反不抛」 | 检查器可能恒抛，测试看不出来 |
| 忘记 revoke 也带 submission_id | I-3 漏掉一半场景 |

---

## 完成后

```bash
git add -A && git commit -m "test(I1): 五组不变量，走真实写路径"
```

**下一步**：I2 不变量检查器与变异验证（把检查器接到真实库与 CI）。
