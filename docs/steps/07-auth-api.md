# B3 · 登录与登出 API

**做什么**：把登录与登出定稿——cookie 属性、防会话固定、错误格式统一、审计埋点。

**依赖**：B1 B2

**预计**：0.5 小时

**现状**：`src/app/api/auth/login/route.ts` 是 B1 时临时改的，有三个待办。

---

## 三个要解决的问题

### 1. 登录时未清理旧 session（会话固定攻击）

现在的流程是「校验凭据 → 新建 session → 设 cookie」。新建是安全的（不复用请求里的 sid），
但**旧 sid 没有失效**：如果攻击者通过某种方式让受害者带着自己预置的 sid 访问，
受害者登录后，那个旧 sid 依然指向受害者账户。

正确做法：登录成功时，把请求带来的旧 sid 一并删掉。

### 2. 错误响应格式与全站不一致

现在返回 `{ error: string }`，而全站约定是 `{ ok: false, error: { code, message } }`。
B1 时为兼容 `LoginForm` 保留旧格式，现在一起改掉。

### 3. 没有审计

登录成功、登录失败、登出都是审计的关键事件。特别是**登录失败**——
`actor_id` 为 null，只能靠 `detail` 里的 username 追溯，这个点最容易在后续埋点时漏掉。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/services/audit-service.ts` | **新建**：审计写入的最小实现 |
| `src/lib/services/auth-service.ts` | **追加** `loginWithFreshSession` |
| `src/app/api/auth/login/route.ts` | 重写 POST / DELETE |
| `src/app/login/LoginForm.tsx` | 适配新的错误格式 |
| `tests/auth-api.test.ts` | 新增 |

---

## 契约（不可改动）

### `src/lib/services/auth-service.ts` 追加

```ts
/**
 * 登录并为本次会话签发新 id。
 * staleSessionId 存在时先销毁——防会话固定：不让请求带来的旧 sid 在登录后继续有效。
 */
export function loginWithFreshSession(
  db: DB,
  username: string,
  password: string,
  staleSessionId?: string,
): { user: SessionUser; sessionId: string };
```

失败时抛 `UnauthorizedError`，且**旧 session 不被销毁**（登录失败不该影响现有会话）。

### `src/lib/services/audit-service.ts`

```ts
export type AuditEntry = {
  actorId: string | null;
  actorRole: string | null;
  tenantId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: unknown;
  ip?: string | null;
  userAgent?: string | null;
};

/** 写一条审计。detail 序列化为 JSON，undefined 时存 NULL。 */
export function writeAudit(db: DB, entry: AuditEntry): void;
```

### `src/app/api/auth/login/route.ts`

**POST** `/api/auth/login`

```
请求：{ "username": string, "password": string }
成功：200 { ok: true, role: 'admin' | 'annotator' }
失败：401 { ok: false, error: { code: 'UNAUTHENTICATED', message: '用户名或密码不正确' } }
参数缺失：400 { ok: false, error: { code: 'VALIDATION', message: '请填写用户名和密码' } }
```

**DELETE** `/api/auth/logout`

```
成功：200 { ok: true }
未登录：200 { ok: true }（幂等，不报错）
```

Cookie：`httpOnly`、`sameSite: 'lax'`、`path: '/'`、`maxAge = SESSION_TTL_MS / 1000`、
`secure` 仅生产。

---

## 实现要点

### 1. `loginWithFreshSession` 的顺序

```ts
export function loginWithFreshSession(db, username, password, staleSessionId) {
  const user = authenticate(db, username, password);   // 先校验，失败直接抛
  if (staleSessionId) destroySession(db, staleSessionId);  // 再清旧会话
  const sessionId = createSession(db, user.id);
  return { user, sessionId };
}
```

**先校验再清旧会话**：登录失败时不该把用户现有会话踢掉。
顺序反了的话，攻击者可以拿错误密码反复调用，把受害者的会话挤下线。

### 2. 审计失败不能影响登录

审计是旁路。写失败时吞掉，但**必须留一条 error 级日志**：

```ts
try {
  writeAudit(db, { ... });
} catch (err) {
  console.error('审计写入失败', err);   // 本文件允许：审计是旁路，不能因它让登录失败
}
```

`no-console` 规则会报 `console.error`。这属于合理例外，用 `// rule-exception` 标注并写明批准人。

> 或者更干净：在 `audit-service` 内部 try/catch，route 不感知。**优先这个方案**，
> 这样 `console` 只在 service 层出现一次，且可以集中处理。

### 3. 登录失败的审计要能追溯

```ts
writeAudit(db, {
  actorId: null,           // 没通过认证，没有身份
  actorRole: null,
  tenantId: null,
  action: 'auth.login_failed',
  detail: { username, reason: 'bad_credentials' },
  ip, userAgent,
});
```

**用户名只进 `detail`，不进 `message`**——错误响应里不能出现「用户 alice 不存在」。

### 4. 登出幂等

没有 cookie、cookie 对应的会话已不存在，都返回 200。登出失败没有业务意义。

### 5. IP 与 UA 的获取

Route Handler 里从 `request.headers` 取：

```ts
const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
const userAgent = request.headers.get('user-agent');
```

`x-forwarded-for` 可被伪造，仅作参考，不用于任何安全判定。

---

## 验收

- [ ] 正确凭据登录 → 200，响应体含 `role`，**不含 session id**
- [ ] 响应头 `Set-Cookie` 含 `HttpOnly`、`SameSite=Lax`、`Path=/`
- [ ] 错误密码 → 401，`error.code === 'UNAUTHENTICATED'`
- [ ] 缺字段 → 400，`error.code === 'VALIDATION'`
- [ ] 登录成功后，请求带来的旧 sid 在库中已不存在
- [ ] 登录失败时，请求带来的旧 sid **仍然有效**（没被误删）
- [ ] 登出后当前 sid 失效
- [ ] 重复登出 → 仍返回 200
- [ ] 登录成功写入一条 `auth.login` 审计
- [ ] 登录失败写入一条 `auth.login_failed`，`actorId` 为 null，`detail.username` 有值
- [ ] 审计写入抛错时，登录仍然成功（用 mock 制造写入失败）
- [ ] 现有 141 例仍全绿

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 先销毁旧 session 再校验凭据 | 攻击者可用错误密码把他人会话踢下线 |
| 复用请求带来的 sid 作为新会话 id | 会话固定攻击 |
| 登录响应体返回 sessionId | `httpOnly` 白设，XSS 可直接读 |
| cookie `maxAge` 用毫秒 | 会话存活 7 万天，等于永不过期 |
| 审计写入放在 try 外层 | 审计失败导致登录失败 |
| 失败响应里带用户名 | 用户名枚举 |
| 用 `cookies().set()` 而非 `response.cookies.set()` | 在某些 Next 版本中不生效 |

---

## 完成后

```bash
git add -A && git commit -m "feat(B3): 登录与登出定稿，补会话固定防护与审计"
```
