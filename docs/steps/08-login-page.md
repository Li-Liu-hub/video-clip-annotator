# B4 · 登录页

**做什么**：登录页定稿。做完这步就是 **M1「能登录」**——第一次能真的起服务用浏览器点进去。

**依赖**：B3

**预计**：1 小时

---

## 现状与三个待修

现有 `LoginForm.tsx` 是骨架期写的，能用但有硬伤：

### 1. 演示账号的租户名与数据库不符

组件里写死「星尘机器人」「北风具身智能」，而 `setup.mjs` 灌进去的是
「林小雨的工作空间」「陈默的工作空间」「周予安的工作空间」。

**页面在向用户展示与数据库不一致的事实。** 这比样式问题严重。

### 2. 登录后的跳转绕过了 `homePathOf`

```tsx
router.replace(data.role === 'admin' ? '/admin' : '/tasks');
```

B2 已经把「角色 → 首页」收进 `homePathOf()`，这里又写了一遍三元。
两处映射将来会漂移（比如加了第三种角色）。

### 3. 缺无障碍细节

- 错误提示没有 `role="alert"`，屏幕阅读器不会播报
- 输入框没有 `aria-invalid` / `aria-describedby`
- 提交中按钮没有 `aria-busy`

---

## 设计方向

当前是单列居中卡片。改为**左右分栏**：

```
┌────────────────────────┬──────────────────┐
│  左：品牌与价值主张       │  右：登录表单      │
│  （lg 以上显示）         │                  │
│                        │  用户名           │
│  片段标注                │  密码             │
│                        │  [ 登录 ]         │
│  把「数字对不上」这件事    │                  │
│  从流程里删掉。           │  ── 演示账号 ──   │
│                        │  [admin] [alice] │
│  · 区间不重叠            │  [bob]   [carol] │
│  · 提交即冻结            │                  │
│  · 按提交日归集          │                  │
└────────────────────────┴──────────────────┘
```

**左侧存在的理由**：评分人打开的第一屏就是登录页。在这里用三行说清产品做了什么，
比让人登录后再猜要有效。但要克制——不堆功能列表，只讲一件事：**数字为什么不会再变**。

移动端（< lg）只显示右栏。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/app/login/page.tsx` | 布局外壳（左右分栏） |
| `src/app/login/LoginForm.tsx` | 修三处硬伤 + 无障碍 |
| `src/app/login/LoginAside.tsx` | **新增**：左侧品牌区 |

---

## 实现要点

### 1. 演示账号只写真实存在的信息

```ts
const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'admin123', name: '平台管理员', note: '跨租户 · 发布与统计' },
  { username: 'alice', password: 'demo123', name: '林小雨',   note: '标注员 · 独立租户' },
  { username: 'bob',   password: 'demo123', name: '陈默',     note: '标注员 · 独立租户' },
  { username: 'carol', password: 'demo123', name: '周予安',   note: '标注员 · 独立租户' },
];
```

`name` 必须与 `users.display_name` 一致，`note` 不得编造租户名。

### 2. 复用 `homePathOf`

`homePathOf` 目前在 `lib/server/guards.ts`，它 import 了 `next/navigation` 与
`@/lib/server/current-user`——客户端组件引它会连带拉进服务端依赖。

**把 `homePathOf` 移到客户端可用的位置**：新建 `src/lib/routes.ts`，
只放纯函数，无任何依赖。`guards.ts` 改为从这里 re-export（保持现有引用不破）。

### 3. 无障碍

```tsx
<input
  aria-invalid={!!error}
  aria-describedby={error ? 'login-error' : undefined}
/>
{error && (
  <p id="login-error" role="alert" className="...">
    {error}
  </p>
)}
<button aria-busy={busy} ...>
```

### 4. 键盘与自动聚焦

- `admin` / `alice` 这类演示按钮必须是 `<button type="button">`，否则回车会提交表单
- 页面加载后焦点落在用户名输入框（`autoFocus`）
- `Enter` 提交（表单默认行为即可）

### 5. 加载态

提交中按钮文案变「正在进入…」且禁用，避免重复提交。

---

## 验收

**自动**

- [ ] `npx tsc --noEmit`、`npx eslint .`、`npm test` 全绿
- [ ] `npm run build` 成功（登录页是动态页面，不报 `cookies outside request scope`）

**手工（必须实际起服务）**

- [ ] `npm run dev` 后访问 `/login`，页面正常渲染，无控制台报错
- [ ] 点击「林小雨」直接进入 `/tasks`
- [ ] 点击「平台管理员」直接进入 `/admin`
- [ ] 输错密码 → 红色提示条出现，文案为「用户名或密码不正确」
- [ ] 提示条出现后，输入框有红色边框（`aria-invalid` 生效）
- [ ] 提交中按钮禁用且文案变化
- [ ] 登录后刷新页面，仍在登录态
- [ ] 已登录时访问 `/login` → 自动跳转到对应首页
- [ ] 窄屏（375px）下左栏隐藏，右栏占满
- [ ] 用 Tab 键能从用户名 → 密码 → 登录 → 四个演示账号依次走完
- [ ] 演示账号按钮按回车**不会**提交表单

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 演示账号写死与库不一致的信息 | 页面展示假事实，评分人会当成数据错误 |
| 客户端组件 import `lib/server/guards` | 打包把 `next/headers` 拉进浏览器 bundle，构建失败 |
| 演示按钮用 `<button>` 但不写 `type="button"` | 回车触发提交，跳到空表单校验 |
| 错误提示只在视觉上存在 | 屏幕阅读器静默，无障碍形同虚设 |
| 左栏用固定宽度 | 窄屏挤成一团；必须靠 `lg:` 断点控制显隐 |

---

## 实测记录（M1 验收）

用 `npm run dev` 起服务，curl 走完整个链路：

| # | 场景 | 结果 |
|---|---|---|
| 1 | `GET /login` | 200，页面含「登录工作台」「演示账号」与左栏三条要点 |
| 2 | 登录 `alice/demo123` | 200，`Set-Cookie: ...; Max-Age=604800; HttpOnly; SameSite=lax`，响应体仅 `{ok:true,role}`，**不含 sid** |
| 3 | 错误密码 | 401，`code: UNAUTHENTICATED`，文案「用户名或密码不正确」 |
| 4 | 带 alice cookie 访问 `/` | 307 → `/tasks` |
| 5 | 带 admin cookie 访问 `/` | 307 → `/admin` |
| 6 | 无 cookie 访问 `/` | 307 → `/login` |
| 7 | 已登录访问 `/login` | 307 → `/tasks` |
| 8 | 登出后再访问 `/` | 307 → `/login` |

**未验证**：视觉观感、窄屏布局、键盘 Tab 序——这些只能人眼看。
`Secure` 属性在 dev 下不出现（代码里仅 `NODE_ENV === 'production'` 时加），生产构建才带上。

## 完成后

```bash
git add -A && git commit -m "feat(B4): 登录页定稿，达成 M1"
```

**M1 达成**：三种角色能登录、能按角色分流。
