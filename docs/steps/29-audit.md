# H1 · 审计埋点收尾

**做什么**：把「每个改状态的动作都有审计」这件事做完整，并把 action 名收敛到一处。

**依赖**：A4、B1、F1、F2

**预计**：1 小时

---

## 现状盘点

已经有的（六个）：

| action | 位置 | strict |
|---|---|---|
| `task.create` | task-service | 否 |
| `task.claim` | task-service | 否 |
| `task.release` | task-service | 否 |
| `task.submit` | submit-service | 是 |
| `task.reject` | review-service | 是 |
| `task.reopen` | review-service | 是 |

缺的两个，都是安全审计的核心：

| action | 为什么要 |
|---|---|
| `auth.login` | 「谁在什么时候登录了」是事后追溯的起点 |
| `auth.login_failed` | **连续失败是入侵信号**。不记的话，被爆破时日志里什么也没有 |

`schema.sql` 里 `actor_id` 的注释写着「登录失败时为 NULL」——这条列从一开始就是为它留的，但一直没人写。

---

## 三个决定

### 1. 登录失败要记「试的是谁」，不是「用了个错密码」

```ts
detail: { username: attemptedUsername, reason: 'bad_password' | 'no_such_user' | 'inactive' }
```

**不记密码**——哪怕是哈希。日志会被导出、会被贴进工单。

`reason` 分开记，是因为「撞库」与「用户记错密码」的行为模式不同：
前者会有大量 `no_such_user`，后者集中在少数几个 `bad_password`。

### 2. `actor_id` 在「用户不存在」时确实为 NULL，但 `detail.username` 要有值

没有 `actor_id` 就无法关联到人，`detail.username` 是唯一线索。
如果连用户名都不记，这条日志就是「有人试了某个密码」，没有调查价值。

### 3. 登录审计用旁路模式，其他一律 strict

`writeAudit` 默认吞错（旁路）。对登录来说这是对的：**审计写失败不该让人登不进来**。

但它与「提交必须 strict」不矛盾——两者的失败代价不同：
提交失败会留下不一致的账，登录失败只是丢一条日志。

判断标准写进注释：**这次操作如果没留下审计，业务数据会不会变成无法解释的状态？**
会 → strict；不会 → 旁路。

---

## action 名收敛

现在是六处散落的字符串字面量。加两个就要改七处，且拼写错误不会被任何检查抓住
（`task.submitt` 会安安静静写进库）。

```ts
// lib/audit-actions.ts
export const AUDIT_ACTIONS = {
  taskCreate: 'task.create',
  taskClaim: 'task.claim',
  taskRelease: 'task.release',
  taskSubmit: 'task.submit',
  taskReject: 'task.reject',
  taskReopen: 'task.reopen',
  authLogin: 'auth.login',
  authLoginFailed: 'auth.login_failed',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
```

`writeAudit` 的 `action` 从 `string` 收窄到 `AuditAction`：拼错变成编译错误。

**但 `audit_logs.action` 是 TEXT，历史数据里可能有不在枚举里的值**。
读取时（H2）按 `string` 处理，只有写入侧收窄。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/audit-actions.ts` | action 常量表 + 类型 |
| `src/lib/services/audit-service.ts` | `action` 类型收窄 |
| `src/lib/services/auth-service.ts` | 登录成功/失败埋点 |
| `src/lib/services/task-service.ts` / `submit-service.ts` / `review-service.ts` | 改用常量 |
| `tests/audit.test.ts` | 新增 |

---

## 契约（不可改动）

```ts
// lib/audit-actions.ts
export const AUDIT_ACTIONS: {
  readonly taskCreate: 'task.create';
  readonly taskClaim: 'task.claim';
  readonly taskRelease: 'task.release';
  readonly taskSubmit: 'task.submit';
  readonly taskReject: 'task.reject';
  readonly taskReopen: 'task.reopen';
  readonly authLogin: 'auth.login';
  readonly authLoginFailed: 'auth.login_failed';
};
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
```

---

## 实现要点

### 1. 登录失败要在**抛错之前**写

```ts
const user = findByUsername(db, username);
if (!user) {
  writeAudit(db, { ...reason: 'no_such_user' });   // 先写
  throw new AuthError('用户名或密码错误');            // 再抛
}
```

顺序反了的话，异常把审计那一行一起带走——所有失败登录都不会留痕，
而这恰恰是最需要留痕的路径。

### 2. 失败原因的判定不能泄漏给客户端

三种 reason 都返回同一句「用户名或密码错误」。泄漏「用户不存在」等于送了半个用户名枚举器。

审计里记细的，响应里说粗的。

### 3. 成功登录的 `detail` 带 `sessionId`

不记 token（那是凭据），记 session 的主键。事后可以对着 `sessions` 表查这次会话活了多久。

### 4. 不要在登录里做「连续失败 N 次锁定」

那是另一个功能。H1 只负责「记下来」——先有数据，再谈策略。

---

## 验收

**自动**

- [ ] 登录成功写一条 `auth.login`，`actorId` 是新用户，`detail.sessionId` 非空
- [ ] 密码错写一条 `auth.login_failed`，`actorId` 是该用户，`detail.reason = 'bad_password'`
- [ ] 用户不存在写一条 `auth.login_failed`，**`actorId` 为 NULL**，`detail.username` 有值
- [ ] 用户不存在时抛的错与密码错**同一类型、同一文案**（不泄漏）
- [ ] 审计写失败时登录仍然成功（旁路模式）
- [ ] 八个 action 全部是常量里的值（遍历 `AUDIT_ACTIONS` 断言）
- [ ] 现有 656 例全绿

**手工**

- [ ] 故意输错密码 → `audit_logs` 里能看到 `auth.login_failed` 与你输的用户名
- [ ] 用不存在的用户名 → 有一条 `actor_id` 为空的记录

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 先抛错再写审计 | 异常把审计一起回滚，失败登录永远不留痕 |
| 把密码或哈希写进 detail | 日志被导出/贴进工单时泄漏 |
| 三种失败原因回不同文案 | 等于送了半个用户名枚举器 |
| 登录也用 strict | 审计表写不进去时谁都登不进来 |
| action 仍是裸字符串 | 拼错不报错，H2 里查不到那类事件 |
| 把 AES 历史数据当枚举读 | 旧值不在枚举里，读取侧会抛错 |

---

## 完成后

```bash
git add -A && git commit -m "feat(H1): 补登录审计，action 收敛到常量表"
```

**下一步**：H2 审计查询页。
