# B2 · 当前用户与路由守卫

**做什么**：把「取当前用户 → 未登录就拦下 → 角色不符就拦下」这套重复逻辑收敛成两个入口。

**依赖**：B1

**预计**：0.5 小时

---

## 为什么必须分两套

页面和 API 的失败处理**方向相反**：

| 场景 | 未登录 | 角色不符 |
|---|---|---|
| Server Component | `redirect('/login')` | `redirect('/tasks')` |
| Route Handler | `401` JSON | `403` JSON |

不能共用，原因是 Next 的 `redirect()` 靠**抛异常**（`NEXT_REDIRECT`）实现。
一旦被 `try { } catch { }` 包住，重定向就失效——而 Route Handler 恰恰必须用 try/catch 兜错。

所以：

- 页面路径：`requireUser()` / `requireAdmin()` —— 内部 `redirect()`，**调用方不得包 try/catch**
- API 路径：`requireApiUser()` / `requireApiAdmin()` —— 内部 `throw`，由 handler 的 catch 交给 `toErrorResponse`

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/server/guards.ts` | 页面守卫，依赖 `redirect` |
| `src/lib/server/api-guard.ts` | API 守卫，抛 `AppError` |
| `src/lib/services/auth-service.ts` | **新增** `isTenantUser` 类型守卫与 `TenantUser` 类型 |
| `tests/guards.test.ts` | 新增 |
| `src/app/page.tsx` | 改用 `requireUser()` + `homePathOf()` |
| `src/app/login/page.tsx` | **保持反向逻辑**（已登录才跳走），只统一 `homePathOf()` |

---

## 契约（不可改动）

### `src/lib/services/auth-service.ts` 追加

```ts
/** 标注员一定持有租户。管理员与「数据被改坏的标注员」都不满足。 */
export type TenantUser = SessionUser & { role: 'annotator'; tenantId: string };

export function isTenantUser(user: SessionUser): user is TenantUser;
```

用类型守卫而不是 `throw new Error()`——调用方窄化后，`tenantId` 在类型层面就是 `string`，
不需要每处再判空。

### `src/lib/server/guards.ts`

```ts
/** 已登录用户。未登录跳转登录页。调用方禁止包 try/catch。 */
export function requireUser(): Promise<SessionUser>;

/** 管理员。未登录跳登录页；非管理员跳 /tasks。 */
export function requireAdmin(): Promise<SessionUser>;
```

### `src/lib/server/api-guard.ts`

```ts
/** API 用。未登录抛 UnauthorizedError(401)。 */
export function requireApiUser(): Promise<SessionUser>;

/** API 用。未登录 401；非管理员抛 ForbiddenError(403)。 */
export function requireApiAdmin(): Promise<SessionUser>;
```

---

## 实现要点

### 1. `redirect` 的返回类型是 `never`

```ts
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user; // TS 知道上面那行不会返回
}
```

不需要写 `throw`，也不需要非空断言。

### 2. 管理员访问标注员页面时不做特殊处理

`requireUser()` 只看「有没有登录」。管理员访问 `/tasks` 会看到空列表——
管理员没有租户，列表查询返回空。这是可接受的：管理员的入口在 `/admin`。

不额外拦，因为「管理员能不能看标注页」没有明确的业务答案，
为它加一条规则属于臆测需求。

### 3. 角色不符跳 `/tasks` 而不是 404

`/admin` 的路径是公开结构，谈不上隐藏。跳回自己的首页比一句冷冰冰的 404 更有用。

### 4. `isTenantUser` 不做运行期抛错

它只回答「是否满足」，不承担「必须满足」的断言职责。
需要强制的场景由调用方决定抛什么错——不同场景要的 HTTP 状态码不同。

---

## 验收

- [ ] `requireUser()` 在无 cookie 时触发重定向到 `/login`
- [ ] `requireUser()` 在已登录时返回 `SessionUser`
- [ ] `requireAdmin()` 在标注员访问时重定向到 `/tasks`
- [ ] `requireAdmin()` 在管理员访问时返回 `SessionUser`
- [ ] `requireApiUser()` 未登录抛 `UnauthorizedError`，`status === 401`
- [ ] `requireApiAdmin()` 对标注员抛 `ForbiddenError`，`status === 403`
- [ ] `isTenantUser` 对标注员返回 `true`，管理员返回 `false`
- [ ] `isTenantUser` 对 `role='annotator'` 但 `tenantId=null` 的畸形对象返回 `false`
- [ ] 现有 115 例测试仍全绿
- [ ] `npm run audit:rules`、`audit:sql`、`eslint .` 全部通过

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 在 `requireUser` 内部用 try/catch 包 `redirect` | 重定向被吞，页面白屏且无报错 |
| 页面守卫与 API 守卫共用一个函数 | 要么 API 返回 HTML 重定向，要么页面返回 JSON |
| `isTenantUser` 里直接 `throw` | 调用方拿不到「是否满足」的答案，只能靠异常控制流 |
| `requireAdmin` 用 `notFound()` 而非跳转 | 管理员误操作时看到 404，以为系统坏了 |
| 守卫里做业务查询 | 守卫被复用时行为分叉，且不可单测 |
| **登录页套 `requireUser()`** | 未登录跳 `/login`，而它自己就是 `/login` → 307 自环，登录页永远打不开 |
| 把守卫下沉到 `app/layout.tsx` | 根布局包住 `/login`，同样是自环 |

## 文档修正记录

本文档初稿的产出表写了「`login/page.tsx` 改用统一入口」，**这是错的**：

`requireUser()` 未登录时 `redirect('/login')`，而登录页本身就是 `/login`。
套上去就是无限重定向。

Writer 实现时凭判断绕过了这个坑（保留反向逻辑，只复用 `homePathOf`），
但**没有按 RULES「停机上报」停下来报告文档冲突**，属于流程没走满——
事后说明不等于事前上报。

教训：产出表写「改用统一入口」这类粗粒度要求时，必须逐个文件注明它的语义方向，
否则实现者要么盲从（写出自环），要么自行判断（跳过上报）。

---

## 完成后

```bash
git add -A && git commit -m "feat(B2): 页面与 API 两套守卫"
```
