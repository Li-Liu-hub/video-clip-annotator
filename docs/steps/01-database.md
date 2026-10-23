# STEP 01 · 数据库与连接层

**目标**：把 `docs/DESIGN.md` §3 的设计变成可执行的 DDL，并让测试能用上隔离的数据库。

**前置**：无。

**预计**：1.5 小时

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/schema.sql` | 9 张表 + 2 个触发器 + 索引（**替换现有旧版**） |
| `src/lib/db/index.ts` | `createDb(path)` 工厂 + `getDb()` 单例 + `writeTx()` |
| `scripts/setup.mjs` | 建表 + 种子数据（**替换现有旧版**） |
| `data/app.db` | 运行时生成，gitignore |

---

## 关键实现

### 1. `schema.sql` 必须整体替换

现有文件是旧模型（8 表、无 `videos`、无 `audit_logs`、`tasks.video_path`）。
按 §3.3 逐表重写，注意这些容易漏的点：

```sql
-- ① 部分唯一索引，WHERE 不能省
CREATE UNIQUE INDEX idx_one_annotator_per_tenant
  ON users(tenant_id) WHERE role = 'annotator';

-- ② 状态与领取人联动
CHECK ((status = 'pending' AND claimed_by IS NULL) OR
       (status <> 'pending' AND claimed_by IS NOT NULL))

-- ③ 账本符号与类型联动
CHECK ((kind = 'submit' AND delta_ms > 0) OR
       (kind = 'revoke' AND delta_ms < 0))
```

### 2. 触发器要写两个

只写 INSERT 的会在「修改片段端点」时被绕过。`UPDATE OF start_ms, end_ms` 限定只在改区间时触发。

```sql
CREATE TRIGGER trg_segment_no_overlap_upd
BEFORE UPDATE OF start_ms, end_ms ON segments
BEGIN
  SELECT RAISE(ABORT, 'OVERLAP')
  WHERE EXISTS (
    SELECT 1 FROM segments
    WHERE task_id = NEW.task_id
      AND id <> NEW.id          -- 排除自己
      AND start_ms < NEW.end_ms
      AND end_ms   > NEW.start_ms
  );
END;
```

`id <> NEW.id` 是关键，漏了会导致「修改片段时和自己冲突」，永远改不动。

### 3. `index.ts` 提供两个入口

```ts
export function createDb(path: string): DB   // 工厂，测试传 ':memory:'
export function getDb(): DB                  // 单例，生产用，挂 globalThis 防 HMR 重连
export function writeTx<T>(fn: (db: DB) => T): T  // BEGIN IMMEDIATE
```

`createDb` 内部要执行 schema.sql，这样测试不必自己建表：

```ts
const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(sql);
```

注意 schema 里用了 `CREATE TABLE`（无 `IF NOT EXISTS`），因为 `createDb` 每次都是新库。
生产环境的 `getDb` 若指向已存在的库，重复执行会报错——所以 `getDb` 不执行 schema，
建表交给 `setup.mjs`。

### 4. 种子数据（`setup.mjs`）

- 3 个标注员租户 + 1 个管理员
- 1 个内置视频 `demo.mp4`，`storage_path` 指向 `demo.mp4`，时长 40000ms
- 每个标注员 3–4 个任务，覆盖 `pending` / `claimed` / `submitted` 三种状态
- 过去 5 天的 `submissions` + `ledger_entries`，让统计页一打开就有数据
- 若干 `audit_logs`，让审计页不是空的

**种子数据必须满足所有不变量**，否则 `db:check` 一跑就红。

---

## 验收标准

- [ ] `npm run db:reset` 无报错，输出 4 用户 / 3 租户 / N 任务
- [ ] `sqlite3 data/app.db ".tables"` 显示 9 张表
- [ ] 手工插入重叠片段被拒绝：
      ```sql
      INSERT INTO segments (id, task_id, tenant_id, start_ms, end_ms, created_at)
      VALUES ('x', '<已有task>', '<tenant>', 1000, 5000, 0);  -- 与已有段重叠
      -- 期望：Runtime error: OVERLAP
      ```
- [ ] 插入 `role='admin'` 且 `tenant_id` 非空被拒绝
- [ ] 同一个 `tenant_id` 插入第二个 annotator 被拒绝
- [ ] `node -e "require('./src/lib/db').createDb(':memory:')"` 能建出空库（需先编译 TS，可跳过）

---

## 容易错的地方

| 陷阱 | 后果 |
|---|---|
| 忘了 `PRAGMA foreign_keys = ON` | 外键形同虚设，删任务留下孤儿片段 |
| `UPDATE` 触发器漏 `id <> NEW.id` | 片段永远改不动 |
| 种子数据的 `segments.tenant_id` 和 `task.tenant_id` 不一致 | `db:check` 红 |
| 种子里的 `local_date` 用 UTC 而非租户时区算 | 统计日期错一天 |

---

## 完成后

`npm run db:reset` 应该能在 2 秒内跑完，`data/app.db` 生成。
此时应用还不能启动（没有页面能渲染数据），正常。
