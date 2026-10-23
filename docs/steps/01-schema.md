# A1 · 数据库表结构

**做什么**：把 `DESIGN.md` §3 的设计写成可执行的 DDL，包括 9 张表、2 个触发器、1 个部分唯一索引。

**依赖**：无

**预计**：1 小时

**为什么第一步就做这个**：约束是事后无法补的。表建错了，后面每一行代码都建在错的地基上。
而触发器这类东西，一旦有了真实数据就不好再加——必须先建好。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/schema.sql` | 完整 DDL，**整体替换旧版**（旧版是 8 表、无 videos / audit_logs） |

---

## 实现要点

### 1. 建表顺序不能乱

SQLite 的外键只在插入时校验，建表顺序理论上宽松。但按依赖顺序写更清晰：

```
tenants → users → videos → tasks → segments
        → submissions → ledger_entries → audit_logs → sessions
```

### 2. 四处约束是「设计意图的载体」，不是装饰

```sql
-- ① 角色与租户归属绑定
CHECK ((role = 'admin'     AND tenant_id IS NULL) OR
       (role = 'annotator' AND tenant_id IS NOT NULL))

-- ② 一个租户只有一个标注员（部分索引，WHERE 不能省）
CREATE UNIQUE INDEX idx_one_annotator_per_tenant
  ON users(tenant_id) WHERE role = 'annotator';

-- ③ 状态与领取人联动
CHECK ((status = 'pending' AND claimed_by IS NULL) OR
       (status <> 'pending' AND claimed_by IS NOT NULL))

-- ④ 账本符号与类型联动
CHECK ((kind = 'submit' AND delta_ms > 0) OR
       (kind = 'revoke' AND delta_ms < 0))
```

这四条把「注释里的约定」变成了「数据库会拒绝的规则」。③ 尤其重要：
超时回收时如果只改 `status` 忘了清 `claimed_by`，UPDATE 会直接失败，问题当场暴露。

### 3. 两个触发器，一个都不能少

```sql
CREATE TRIGGER trg_segment_no_overlap_ins
BEFORE INSERT ON segments
BEGIN
  SELECT RAISE(ABORT, 'OVERLAP')
  WHERE EXISTS (
    SELECT 1 FROM segments
    WHERE task_id = NEW.task_id
      AND start_ms < NEW.end_ms
      AND end_ms   > NEW.start_ms
  );
END;

CREATE TRIGGER trg_segment_no_overlap_upd
BEFORE UPDATE OF start_ms, end_ms ON segments
BEGIN
  SELECT RAISE(ABORT, 'OVERLAP')
  WHERE EXISTS (
    SELECT 1 FROM segments
    WHERE task_id = NEW.task_id
      AND id <> NEW.id          -- ← 关键：排除自己
      AND start_ms < NEW.end_ms
      AND end_ms   > NEW.start_ms
  );
END;
```

**只写 INSERT 那个**：改片段端点时能穿过去，规则形同虚设。
**UPDATE 那个漏了 `id <> NEW.id`**：任何片段都改不动，因为总是和自己冲突。

### 4. 区间判定用半开语义

`[10000, 20000)` 与 `[20000, 30000)` **不重叠**——`20 > 20` 为假。
首尾相接是合法的连续标注，不是错误。

四个边界用例：

| A | B | 重叠？ |
|---|---|---|
| `[10,20)` | `[20,30)` | 否 |
| `[10,20)` | `[19,30)` | 是 |
| `[10,20)` | `[10,20)` | 是 |
| `[10,20)` | `[5,25)` | 是 |

### 5. 索引只建用得上的

| 索引 | 支撑什么 |
|---|---|
| `idx_tasks_tenant (tenant_id, status)` | 标注员拉自己的池子（最热查询） |
| `idx_tasks_status (status, created_at)` | 管理员看待处理队列 |
| `idx_segments_task (task_id, start_ms)` | 打开任务取片段；触发器也走它 |
| `idx_ledger_daily (tenant_id, entry_date)` | 统计主查询 |
| `idx_audit_time / _actor / _target` | 审计的三个筛选方向 |

`videos`、`tenants` 只有几十条，**故意不建索引**——全表扫描比走索引还快。

---

## 验收

- [ ] `npm run db:reset` 无报错
- [ ] `sqlite3 data/app.db ".tables"` 输出 9 张表
- [ ] `sqlite3 data/app.db ".schema segments"` 能看到两个触发器
- [ ] 插入重叠片段被拒：`Runtime error: OVERLAP`
- [ ] 插入 `role='admin'` 且 `tenant_id` 非空 → 被 CHECK 拒绝
- [ ] 同一 `tenant_id` 插入第二个 annotator → `UNIQUE constraint failed`
- [ ] 插入 `kind='revoke'` 但 `delta_ms > 0` → 被 CHECK 拒绝
- [ ] `PRAGMA journal_mode` 返回 `wal`

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 漏 `PRAGMA foreign_keys = ON` | 外键无效，删任务留下孤儿片段 |
| UPDATE 触发器漏 `id <> NEW.id` | 片段永远改不动 |
| `UNIQUE INDEX` 忘了 `WHERE role='annotator'` | 多个管理员的 `tenant_id` 都是 NULL，语义模糊 |
| 用 `end_ms >= start_ms` | 允许零长片段，统计里出现 0 时长 |
| 建表用了 `IF NOT EXISTS` 但测试要重复建 | `createDb` 每次都新建，不冲突；但生产 `getDb` 指向旧库时会被静默跳过，schema 改了也不生效 |

---

## 完成后

```bash
npm run db:reset
git add -A && git commit -m "feat(A1): 建库表结构、触发器与索引"
```
