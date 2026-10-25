# O1 · 认证加固（演示账号开关、改密、异步哈希、失败计数）

**做什么**：把全量扫描里两条安全项修掉 —— 默认口令暴露、登录可当 DoS 开关。

**依赖**：B1、B3

**预计**：3 小时

---

## 要解决的四件事

| # | 问题 | 现在 |
|---|---|---|
| 1 | 默认口令写进客户端 bundle，登录页一键进入 | `grep -rl admin123 .next/static` 命中 |
| 2 | 没有改密接口 | 管理员也换不掉默认口令 |
| 3 | `scryptSync` 在请求线程里跑，66ms | 20 并发登录 ≈ 1.3s 全站卡死 |
| 4 | 登录零限流 | 爆破与 DoS 都是免费的 |

---

## 1 演示账号：默认关闭

```tsx
// LoginForm.tsx
const SHOW_DEMO = process.env.NEXT_PUBLIC_DEMO_LOGIN === '1';
```

`NEXT_PUBLIC_*` 会在构建期内联进 bundle，所以：

- **默认（不设变量）**：`SHOW_DEMO` 是 `false`，`DEMO_ACCOUNTS` 连同四个明文口令
  一起被 tree-shaking 掉，bundle 里**一个字节都没有**
- **演示**：`NEXT_PUBLIC_DEMO_LOGIN=1 npm run build`

**必须验证「默认构建里 grep 不到 admin123」**，否则这个开关只是把字符串留在了另一个分支里
（很多 bundler 不会摇掉被条件包裹的对象字面量，要实测）。

### seed 也要跟着

`setup --reset` 现在无条件建四个 demo 账号。改成：

- 默认：只建 `admin`，口令**随机生成并打印一次**（不落盘、不进 README）
- `DEMO_LOGIN=1`：建四个固定口令的演示账号

随机口令的实现：`randomBytes(9).toString('base64url')`（12 字符，够用且好抄）。

**打印一次**：`setup` 的 stdout 里出现一次，之后再也拿不到 —— 这是「不给默认口令」的
唯一诚实做法。想改就再 `--reset` 或走改密接口。

---

## 2 改密接口

```
POST /api/auth/password
{ "currentPassword": "...", "newPassword": "..." }
```

| 情况 | 响应 |
|---|---|
| 旧密码错 | 401，与登录失败同一句文案 |
| 新密码短于 8 位 | 400 |
| 新密码与旧密码相同 | 400 |
| 成功 | 200 |

**成功后**：

1. 更新 `password_hash`
2. **销毁该用户的其他所有会话**，但保留当前这个（否则用户改完密码自己被踢出去）
3. 写审计 `auth.password_changed`（detail 只有 `username`，不含任何口令材料）

**不要求「复杂度」**（大小写+数字+符号）：那类规则的实际效果是让人加个 `1!` 在末尾。
只要求长度 ≥ 8，其余交给使用者的密码管理器。

---

## 3 异步 scrypt

`scryptSync` → `promisify(scrypt)`。

这会把 `verifyPassword` 变成 `async`，进而 `authenticate` / `loginWithFreshSession` /
`changePassword` 全部变 `async`。调用方只有 `login/route.ts` 与测试，改动可控。

**注意**：`timingSafeEqual` 那段逻辑不变，只是外面包一层 `await`。
不要顺手把「用户不存在也跑一次 scrypt」的逻辑省掉 —— 那是防时序侧信道。

---

## 4 失败计数

```ts
// lib/server/login-throttle.ts
type Bucket = { failures: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/** 同一 IP + 用户名的失败次数。返回是否应该拒绝这次尝试。 */
export function isLocked(key: string, nowMs: number): boolean;
export function noteFailure(key: string, nowMs: number): void;
export function clearFailures(key: string): void;
```

- 窗口 60 秒，上限 5 次
- key = `${ip}:${username.toLowerCase()}`
- 第 6 次直接 429，**不跑 scrypt**（这才是防 DoS 的关键 —— 拒绝要便宜）

**内存实现的三条限制要写进注释**：

1. 进程重启即清空（可接受：这是防爆破，不是审计）
2. 多实例不共享（部署多副本时形同虚设；本项目是单实例）
3. `Map` 会随 key 增长（每个窗口内加一次清理，或按时间戳惰性删）

**不按 IP 单独计数**：内网共用出口 IP 时，一个人输错五次会锁住整个办公室。
只按 `IP + 用户名` 组合，牺牲一点防护换取不误伤。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/app/login/LoginForm.tsx` | `SHOW_DEMO` 条件渲染 |
| `src/app/api/auth/password/route.ts` | 改密接口 |
| `src/lib/services/auth-service.ts` | `verifyPassword` 异步化、`changePassword` |
| `src/lib/server/login-throttle.ts` | 失败计数 |
| `src/app/api/auth/login/route.ts` | 接入计数、`await` |
| `scripts/seed.mjs` | 随机口令 / demo 开关 |
| `tests/auth-password.test.ts` | 改密 |
| `tests/login-throttle.test.ts` | 计数 |
| `docs/steps/00-INDEX.md` | 新增 O 组 |

---

## 契约（不可改动）

```ts
// services/auth-service.ts
export type PasswordChangeInput = { currentPassword: string; newPassword: string };

/**
 * 改密。成功后销毁该用户除当前会话外的所有会话。
 *
 * 旧密码错与登录失败抛同一个错误（同一句文案）：
 * 区分「旧密码错」与「账号不存在」等于给了半个用户名枚举器。
 */
export function changePassword(
  db: DB,
  actor: SessionUser,
  input: PasswordChangeInput,
  context: AuditContext,
): void;

/** 最短长度。与登录不共用常量：登录不限长度，改密才要求。 */
export const MIN_PASSWORD_LENGTH = 8;
```

```ts
// lib/server/login-throttle.ts
export const MAX_FAILURES = 5;
export const WINDOW_MS = 60_000;
export function throttleKey(ip: string | null, username: string): string;
export function isLocked(key: string, nowMs: number): boolean;
export function noteFailure(key: string, nowMs: number): void;
export function clearFailures(key: string): void;
/** 仅供测试：清空全部桶。生产代码不得调用。 */
export function resetThrottle(): void;
```

---

## 验收

**自动**

- [ ] 默认构建的 `.next/static` 里 **grep 不到 `admin123` 与 `demo123`**
      （这条必须实测 —— 条件包裹的对象不一定被 tree-shaking 掉）
- [ ] 设 `NEXT_PUBLIC_DEMO_LOGIN=1` 构建后能 grep 到
- [ ] 默认 `setup --reset` 只建 admin，口令随机且打印一次
- [ ] 改密成功 → 旧口令登录失败、新口令成功
- [ ] 改密后**其他会话失效**、当前会话仍有效
- [ ] 新密码 < 8 位 → 400
- [ ] 新密码 == 旧密码 → 400
- [ ] 旧密码错 → 401，且与登录失败的文案相同
- [ ] 改密写一条 `auth.password_changed`，detail 不含任何口令材料
- [ ] 同一 IP+用户名 连续 5 次失败后，第 6 次返回 429
- [ ] 第 6 次**不跑 scrypt**（用 mock 计时或计数验证）
- [ ] 成功登录后计数清零（此前失败过 4 次，成功一次后再失败可以重新从 1 数）
- [ ] 不同用户名/不同 IP 互不影响
- [ ] 现有 731 例全绿（改完为 782）

**手工**

- [ ] 不设环境变量 `npm run dev` → 登录页没有「演示账号」区域
- [ ] `NEXT_PUBLIC_DEMO_LOGIN=1 npm run dev` → 有，且能一键登录
- [ ] 登录后改密，退出，用新口令登录成功

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 只把 `DEMO_ACCOUNTS` 包进 `if` 就以为没了 | bundler 不一定摇掉对象字面量，必须 grep 实测 |
| 改密后把当前会话也销毁 | 用户改完密码立刻被踢 |
| 第 6 次仍跑 scrypt 再返回 429 | DoS 防线形同虚设 |
| 按 IP 单独计数 | 内网共用出口 IP 时锁住整个办公室 |
| 异步化时顺手删掉「用户不存在也跑 scrypt」 | 时序侧信道复活 |
| 改密错误文案与登录失败不一致 | 泄漏「账号存在」 |
| 随机口令写进日志或文件 | 等于没有 |

---

## 完成后

```bash
git add -A && git commit -m "feat(O1): 演示账号默认关闭、改密接口、异步哈希、登录失败计数"
```

**下一步**：O2 重复实现收口（归属门禁三份、上传上限两份、`newId`）。
