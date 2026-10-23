# STEP 08 · 审计日志

**目标**：每个有后果的动作都留下痕迹，管理员能查「谁在什么时候做了什么」。

**前置**：02–07 完成（要在各业务点插入审计写入）

**预计**：1.5 小时

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/services/auditService.ts` | `writeAudit()` + 查询 |
| `src/app/api/audit/route.ts` | `GET` 查询 |
| `src/app/admin/audit/page.tsx` | 审计页 |
| `src/components/admin/AuditTable.tsx` | 表格 + 筛选 |

---

## 关键实现

### 1. `writeAudit` 必须接收事务对象

```ts
export function writeAudit(
  tx: DB,
  actor: { id: string; role: string; tenantId: string | null } | null,
  action: string,
  targetType: string | null,
  targetId: string | null,
  detail?: unknown,
  meta?: { ip?: string; userAgent?: string },
) {
  tx.prepare(
    `INSERT INTO audit_logs
       (id, actor_id, actor_role, tenant_id, action, target_type, target_id, detail, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId(),
    actor?.id ?? null,
    actor?.role ?? null,
    actor?.tenantId ?? null,
    action,
    targetType,
    targetId,
    detail ? JSON.stringify(detail) : null,
    meta?.ip ?? null,
    meta?.userAgent ?? null,
    Date.now(),
  );
}
```

**参数是 `tx` 不是 `db`**：审计必须和业务写在同一个事务里。
否则会出现「提交成功了但没留痕」或「留痕了但提交失败」，两种情况都会让审计不可信。

### 2. 埋点位置汇总

| 位置 | action | 备注 |
|---|---|---|
| 登录成功 | `auth.login` | 事务外可，独立写入 |
| 登录失败 | `auth.login_failed` | `actor_id` 为 NULL，detail 记 username |
| 登出 | `auth.logout` | — |
| 上传完成 | `video.upload` | — |
| 创建任务 | `task.create` | — |
| 领取 | `task.claim` | — |
| 提交 | `task.submit` | 在提交事务内 |
| 退回 | `task.reject` | 在退回事务内 |
| 新增片段 | `segment.create` | — |
| 修改片段 | `segment.update` | detail 记 before/after |
| 删除片段 | `segment.delete` | — |
| 导出 | `stats.export` | 数据离开系统 |
| **越权被拒** | `access.denied` | 见下 |

### 3. `access.denied` 的埋点

在所有返回 404（资源不存在或跨租户）的地方，额外记一条：

```ts
if (!task) {
  writeAudit(db, actor, 'access.denied', 'task', taskId,
             { reason: 'not_found_or_cross_tenant' },
             { ip, userAgent });
  throw new NotFoundError();
}
```

**这是审计里最有价值的数据。** 成功的操作只能说明系统在正常工作；
被拒绝的访问说明有人在试探边界。安全事件调查时，这一列往往比成功日志有用得多。

**注意**：这条会让「猜 id」的攻击者产生大量日志。生产环境应对同一 actor 的
`access.denied` 做速率统计并告警；本项目不做，但要在 report 里说明。

### 4. 查询接口

```ts
GET /api/audit?action=&actorId=&targetType=&targetId=&from=&to=&page=
```

```sql
SELECT * FROM audit_logs
 WHERE (? IS NULL OR action = ?)
   AND (? IS NULL OR actor_id = ?)
   AND created_at BETWEEN ? AND ?
 ORDER BY created_at DESC
 LIMIT ? OFFSET ?;
```

分页必须有。审计表是增长最快的表，全量返回会拖死页面。

每页 50 条，显示总数。

### 5. 页面

- 顶部筛选：动作下拉、操作者下拉、时间范围
- 表格列：时间、操作者、动作、对象、详情
- `detail` 里的 JSON 折叠展示，默认收起
- `access.denied` 的行标红

**动作名要翻译成中文**：

| action | 显示 |
|---|---|
| `auth.login` | 登录 |
| `task.claim` | 领取任务 |
| `task.submit` | 提交 |
| `segment.create` | 新增片段 |
| `access.denied` | 越权访问被拒 |

否则一屏英文下划线，没人看得懂。

---

## 验收标准

- [ ] 登录一次后，审计页出现 `auth.login` 记录
- [ ] 故意输错密码，出现 `auth.login_failed`，`actor` 列显示「—」
- [ ] 领取任务 → 新增片段 → 提交，三条记录按时间倒序出现
- [ ] 用 alice 的账号请求 carol 的任务 id → 出现 `access.denied` 且标红
- [ ] 修改片段时，`detail` 里能看到修改前后的值
- [ ] 按动作筛选「提交」，只剩提交记录
- [ ] 按时间筛选昨天，今天的不出现
- [ ] 分页：超过 50 条时出现下一页

---

## 容易错的地方

| 陷阱 | 后果 |
|---|---|
| `writeAudit` 接收 `db` 而非 `tx` | 脱离事务，可能出现「有日志无业务」 |
| 登录失败时没记 actor | 查不到谁在爆破 |
| `detail` 直接存对象 | better-sqlite3 会报 `TypeError: Invalid value`，必须 `JSON.stringify` |
| 查询没分页 | 几千条后页面卡死 |
| 忘了给 `access.denied` 单独样式 | 淹没在正常记录里，失去意义 |

---

## 完成后

系统变得可追溯了。现在任何数字都能回答「它是怎么来的」。
下一步收口：测试、检查器、文档。
