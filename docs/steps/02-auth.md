# STEP 02 · 认证与身份

**目标**：三种角色能登录，服务端能可靠地回答「你是谁、什么角色、属于哪个租户」。

**前置**：01 完成（表结构就绪）

**预计**：1 小时

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/auth.ts` | 密码哈希、会话、`getSessionUser()`（改造现有） |
| `src/app/api/auth/login/route.ts` | 登录 / 登出 |
| `src/app/login/page.tsx` `LoginForm.tsx` | 登录页（现有，微调） |
| `src/middleware.ts` | 路由守卫（可选，见下） |

---

## 关键实现

### 1. 身份每次回表查，不信任 cookie 内容

cookie 里只放一个随机 session id，角色和租户**每次都从数据库读**：

```sql
SELECT u.id, u.username, u.display_name, u.role, u.tenant_id,
       t.name AS tenant_name, t.timezone
  FROM sessions s
  JOIN users u   ON u.id = s.user_id
LEFT JOIN tenants t ON t.id = u.tenant_id
 WHERE s.id = ? AND s.expires_at > ?
```

如果为了省一次查询把 `role` 放进 cookie 签名里，一旦用户在库里被降权，
旧 cookie 依然有效直到过期。**多一次索引查询换权限的即时性，这笔交易划算。**

### 2. 登录失败不泄露用户是否存在

```ts
if (!row || !verifyPassword(password, row.password_hash)) {
  return json({ error: '用户名或密码不正确' }, 401);
}
```

两种情况返回同一句话、同一个状态码。否则攻击者可以靠响应差异枚举出哪些用户名存在。

### 3. 密码哈希格式固定

```
scrypt$<32字节salt的hex>$<64字节结果的hex>
```

`verifyPassword` 必须先切分再比对，且用 `timingSafeEqual` 而不是 `===`。
`setup.mjs` 里的哈希实现要和 `auth.ts` **完全一致**，否则种子账号登不进去。

### 4. 路由守卫

两种做法，选一种：

- **Middleware**（推荐）：在 `src/middleware.ts` 里读 cookie，未登录跳 `/login`。
  但 middleware 跑在 Edge Runtime，**不能 import `better-sqlite3`**，所以只能判断「有没有 cookie」，
  不能验证 session 有效性。
- **页面级**：每个 Server Component 顶部 `const user = await getSessionUser(); if (!user) redirect('/login')`。

**结论：用页面级守卫**。middleware 只做「没有 cookie 就跳登录」的粗筛，真正的校验在页面/service 里。
理由是 SQLite 不能在 Edge 里跑，硬用 middleware 做鉴权会逼你把会话挪到别处。

### 5. 角色分流

```ts
// src/app/page.tsx
redirect(user.role === 'admin' ? '/admin' : '/tasks');
```

---

## 验收标准

- [ ] `admin/admin123` 登录后落在 `/admin`
- [ ] `alice/demo123` 登录后落在 `/tasks`
- [ ] 错误密码提示「用户名或密码不正确」，状态码 401
- [ ] 不存在的用户名提示**同一句话**，状态码 401
- [ ] 登录后 cookie 是 `httpOnly`，DevTools 里 `document.cookie` 读不到
- [ ] 手工改 cookie 值为随机串 → 刷新后跳回登录页
- [ ] 未登录直接访问 `/tasks` → 跳 `/login`

---

## 容易错的地方

| 陷阱 | 后果 |
|---|---|
| `setup.mjs` 的哈希格式和 `auth.ts` 不一致 | 种子账号永远登不进，且看不出原因 |
| 用 `===` 比对密码哈希 | 时序攻击（本项目不致命，但没理由不做对） |
| 把 `role` 存进 cookie 明文 | 改 cookie 即可提权 |
| 在 middleware 里 import db | 构建直接失败（Edge Runtime 不支持原生模块） |
| 登出只清 cookie 不删 session 行 | 旧 session 在库里堆积，且被窃取的 cookie 仍有效 |

---

## 完成后

M1 达成：能登录、能按角色分流。此时各页面还是空白，下一步开始填内容。
