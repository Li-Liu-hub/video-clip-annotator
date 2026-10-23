# B1 · 密码与会话

**做什么**：身份体系的地基——密码哈希、会话签发与校验、身份装配。不含登录页与路由守卫（B3/B4）。

**依赖**：A1 A2 A4

**预计**：1 小时

---

## 分层调整（本步引入）

原三层不足以安放「读 cookie」这件事：service 层禁止 `next/headers`（否则不可单测），
但 `getSessionUser()` 必须读 cookie。

新增一层适配：

```
app/  →  lib/server/  →  lib/services/  →  lib/db/repos/
       读 cookie        纯逻辑              SQL
       调 service
```

**`lib/server/**` 的边界**：允许 `next/headers`、`next/navigation`、`@/lib/db` 的 `getDb`。
但每个文件只做「取请求上下文 → 调 service → 返回」，不写业务判断。

同步更新 `RULES.md` 的分层一节。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/db/repos/user-repo.ts` | 按 id / username 查用户 |
| `src/lib/db/repos/session-repo.ts` | 会话的增删查 |
| `src/lib/services/auth-service.ts` | 密码、登录、会话、身份装配 |
| `src/lib/server/current-user.ts` | 读 cookie 的薄适配 |
| `src/lib/errors.ts` | **新增 `UnauthorizedError`**（401 / UNAUTHENTICATED） |
| `src/lib/auth.ts` | **删除**，内容拆入上述文件 |
| `src/app/api/auth/login/route.ts` | 改为调用新 service |
| `src/app/page.tsx`、`src/app/login/page.tsx` | 改用 `lib/server/current-user` |
| `tests/auth.test.ts` | 新增 |

---

## 契约（不可改动）

### `src/lib/services/auth-service.ts`

```ts
export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'annotator';
  tenantId: string | null;      // 管理员为 null
  tenantName: string | null;
  timezone: string;             // 来自 tenants.timezone，管理员为默认值
};

export const SESSION_COOKIE = 'vsap_sid';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 生成 scrypt$<salt hex>$<hash hex>。salt 16 字节，派生 64 字节。 */
export function hashPassword(plain: string): string;

/** 恒定时间比较。格式不合法一律返回 false，不抛错。 */
export function verifyPassword(plain: string, stored: string): boolean;

/** 校验凭据并返回身份。失败统一抛 UnauthorizedError，不区分「用户不存在」与「密码错」。 */
export function authenticate(db: DB, username: string, password: string): SessionUser;

/** 签发会话，返回 session id（48 位十六进制）。 */
export function createSession(db: DB, userId: string): string;

/** 按 session id 解析身份；不存在、已过期、用户已删除均返回 null。 */
export function resolveSession(db: DB, sessionId: string): SessionUser | null;

/** 删除会话。session 不存在时静默成功。 */
export function destroySession(db: DB, sessionId: string): void;

/** 清理过期会话，返回删除行数。登录时顺带调用。 */
export function purgeExpiredSessions(db: DB, nowMs: number): number;
```

### `src/lib/db/repos/user-repo.ts`

```ts
export type UserRow = {
  id: string;
  tenant_id: string | null;
  username: string;
  display_name: string;
  password_hash: string;
  role: 'admin' | 'annotator';
};

/** 登录专用：username 全局唯一，故意不带 tenant_id 谓词。
 *  审计豁免标记：// audit-ignore: 认证查询，username 全局唯一 */
export function findByUsername(db: DB, username: string): UserRow | null;

export function findById(db: DB, id: string): UserRow | null;
```

### `src/lib/db/repos/session-repo.ts`

```ts
export type SessionRow = {
  id: string;
  user_id: string;
  expires_at: number;
};

export function insertSession(db: DB, id: string, userId: string, expiresAt: number, createdAt: number): void;

/** 一次 join 拿到会话 + 用户 + 租户，避免三次往返。 */
export function findSessionWithUser(db: DB, sessionId: string, nowMs: number): JoinedUserRow | null;

export function deleteSession(db: DB, sessionId: string): void;
export function deleteExpired(db: DB, nowMs: number): number;
```

`JoinedUserRow` 含 `users.*` 与 `tenants.name`、`tenants.timezone`。

### `src/lib/server/current-user.ts`

```ts
/** 当前请求的登录用户。只读 cookie 并转调 auth-service，不含任何业务判断。 */
export function getCurrentUser(): Promise<SessionUser | null>;
```

---

## 实现要点

### 1. 身份必须每次回表

cookie 只存随机 session id，**角色与租户每次查库**。
把 `role` 放进 cookie 签名里，用户被降权后旧 cookie 仍然有效直到过期。

### 2. 登录失败不可区分

```ts
if (!row || !verifyPassword(password, row.password_hash)) {
  throw new UnauthorizedError('用户名或密码不正确');
}
```

两种失败同一文案、同一状态码。否则可枚举用户名。

### 3. 恒定时间比较

```ts
return derived.length === expected.length && timingSafeEqual(derived, expected);
```

先比长度（`timingSafeEqual` 长度不等会抛错），再比内容。

### 4. 会话查询一次 join

```sql
SELECT u.id, u.username, u.display_name, u.role, u.tenant_id,
       t.name AS tenant_name, t.timezone
  FROM sessions s
  JOIN users u   ON u.id = s.user_id
LEFT JOIN tenants t ON t.id = u.tenant_id
 WHERE s.id = ? AND s.expires_at > ?
```

`LEFT JOIN` 是必需的——管理员的 `tenant_id` 为 NULL，`INNER JOIN` 会让管理员永远登录不上。

### 5. 管理员没有租户时区

`SessionUser.timezone` 对管理员取默认值 `'Asia/Shanghai'`。
不抛错——管理员页面不依赖时区，但统计页的管理员视图需要显示日期。

---

## 验收

- [ ] `hashPassword` 两次调用结果不同（salt 随机），但都能通过 `verifyPassword`
- [ ] `verifyPassword` 对格式非法的字符串返回 `false` 而不抛错
- [ ] 正确凭据返回 `SessionUser`，`role` 与 `tenantId` 与库中一致
- [ ] 错误密码抛 `UnauthorizedError`，`status === 401`
- [ ] 不存在的用户名抛**同一个类**、**同一句 message**
- [ ] 管理员登录后 `tenantId` 为 `null`、`tenantName` 为 `null`、`timezone` 为默认值
- [ ] `resolveSession` 对过期会话返回 `null`
- [ ] `resolveSession` 对伪造 id 返回 `null`
- [ ] `destroySession` 后同一 id 解析不到
- [ ] `purgeExpiredSessions` 只删过期行，返回删除条数
- [ ] 现有 66 例测试仍全绿
- [ ] `npm run audit:rules` 通过

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 会话查询用 `INNER JOIN tenants` | 管理员永远登录不上（`tenant_id` 为 NULL） |
| `verifyPassword` 长度不等时直接 `timingSafeEqual` | 抛 `RangeError`，登录接口 500 |
| 把 `role` 或 `tenantId` 放进 cookie | 改 cookie 即提权 |
| `authenticate` 里先查用户再判断，不同分支抛不同错误类 | 可通过错误码枚举用户名 |
| `resolveSession` 只查 `sessions` 不校验 `expires_at` | 过期会话永久有效 |
| `lib/server` 里写业务判断 | 该层不可单测，业务逻辑无处验证 |

---

## 结对的发现

Reviewer 在实现前独立产出了 15 条安全边界、24 条契约检查点、30 条边界用例。
对照代码后确认的真问题：

### 时间侧信道（已修）

原实现用户不存在时直接抛错，不做哈希校验。实测：

| 场景 | 耗时 |
|---|---|
| 用户存在、密码错 | 51.5 ms |
| 用户不存在 | 0.022 ms |

差 2300 倍。即使文案与状态码完全相同，攻击者仍可凭响应时间批量枚举用户名。

修法：用户不存在时对一个固定的 dummy hash 跑一次等价的 scrypt。
`tests/auth-security.test.ts` 守住这条——阈值放到 5 倍，只挡「完全跳过 scrypt」这种数量级差，
不会因机器抖动误报。

### 契约缺一条租户读取路径（已补）

文档中 `userRepo.findByUsername` 返回的 `UserRow` 不含租户字段，
而 `authenticate` 必须返回 `tenantName` 与 `timezone`。

实现时新增 `userRepo.findWithTenantById(db, id)`（LEFT JOIN tenants），
契约签名一个没改，代价是登录成功路径多一次查询。

### 文件名违反命名规范（已改正）

文档初稿写的是 `userRepo.ts` / `authService.ts`（camelCase），RULES 要求文件用 kebab-case。
**这是文档的错，不是实现的错。** 已全部改为 `user-repo.ts` / `auth-service.ts` /
`current-user.ts` / `session-repo.ts`。

### 补上两处「说了但没做」

RULES 声称有 ESLint 分层规则与 SQL 谓词扫描，但仓库里两者都不存在。本步补齐：

- `eslint.config.mjs`：三条 `no-restricted-imports`（app 不连 db、service 不碰 next、
  db 不依赖上层）。**上线即抓到真实违规**：`login/route.ts` 直接 import 了 `@/lib/db`
- `scripts/audit-sql.mjs`：扫 `lib/db/repos/**` 中对 4 张受控表的查询是否含 `tenant_id`

两者都做了变异验证（造违规 → `exit=1` → 清理 → `exit=0`），并挂到 `pretest`。

## 完成后

```bash
git add -A && git commit -m "feat(B1): 密码与会话，引入 lib/server 适配层"
```
