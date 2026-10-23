# 开发规范

硬约束，不是建议。不符合时改代码，不改规范。确需破例写 `// rule-exception: <理由>`。

## 分层

```
app/ → lib/services/ → lib/db/repos/ → SQLite
```

- 只允许向下依赖，反向禁止
- `app/**` 不得 import `lib/db/**`（ESLint 强制）
- `lib/services/**` 不得 import `next/headers`、`next/navigation`
- SQL 字符串只允许出现在 `lib/db/repos/**`

## 命名

| 对象 | 规则 | 例 |
|---|---|---|
| 文件 | kebab-case | `task-service.ts` |
| 组件 | PascalCase | `Timeline.tsx` |
| 类型 | PascalCase | `SessionUser` |
| 常量 | SCREAMING_SNAKE | `MAX_VIDEO_BYTES` |
| 数据库字段 | snake_case | `tenant_id` |
| 领域字段 | camelCase | `tenantId` |

`TaskRow`（snake，来自 DB）与 `Task`（camel，业务用）必须分开，在 repo 层转换。

## 数据

- 时间戳：UTC 毫秒整数，字段后缀 `_at`
- 日期：`TEXT` `YYYY-MM-DD`，字段后缀 `_date`，**写入时固化，查询期不换算**
- 时区换算只有一处实现：`lib/time.ts` 的 `localDateOf()`
- ID：16 位十六进制，由 `newId()` 生成
- 区间：半开 `[start, end)`，毫秒；重叠判定恒为 `a.start < b.end && a.end > b.start`
- 每条业务查询必须带 `tenant_id`（管理员路径传 `null`，且要显式）

## 错误

- 用 `AppError` 子类，不用 `throw new Error()`
- **跨租户访问返回 404，不返回 403**（403 等于承认资源存在）
- 用户可见 `message` 用中文，不含表名 / SQL / 堆栈
- `SQLITE_CONSTRAINT` 必须在 repo 层翻译成领域错误

## 代码

- 禁 `any`；用 `unknown` + 类型守卫
- 禁 `enum`；用 `as const` + 联合类型
- service 签名固定：`fn(db: DB, actor: SessionUser, input): Result`
- repo 签名固定：`fn(db: DB, tenantId: string | null, ...): Row | Row[]`
- 状态跃迁用条件更新，不用「先查后改」，受影响行数为 1 才算成功
- 多表写入必须在同一个 `writeTx` 内，审计与业务同事务
- 魔法数字提为具名常量并注明单位

## 注释

**每个文件顶部必须有文件头**，一句话说清这个文件管什么：

```ts
/** 任务状态机与领取逻辑。租户过滤在 service 层完成，这里只处理状态跃迁。 */
```

**函数**：非自明的（超过 15 行、有副作用、含业务规则）用一行说明它做什么。

**关键选择写「为什么用这个」**：为什么用 `BEGIN IMMEDIATE` 而不是 `BEGIN`、
为什么区间用半开而不是闭区间、为什么这里要冗余 `tenant_id`。

**极简**：一行能说清就不写两行，删掉所有形容词。

**禁止**：注释掉的代码、无主 TODO、与代码不符的过期注释、装饰性分隔线（`// ===== xxx =====`）。

## 验证

六层，各管一件事。**任何一层单独都不够**，缺了哪层，那类问题就没人管。

| # | 手段 | 管什么 | 命令 |
|---|---|---|---|
| 1 | TDD | 业务规则对不对 | `npm test` |
| 2 | ESLint | 依赖方向有没有越界 | `npm run lint` |
| 3 | SQL 扫描 | 租户谓词有没有漏 | `npm run audit:sql` |
| 4 | 变异验证 | 前三层的「绿」是不是真的 | `npm run db:verify-checker` + 手工改坏 |
| 5 | 运行库检查 | 真实数据有没有脏 | `npm run db:check` |
| 6 | 手工验收 | UI 手感与视觉 | — |

**第 1 层**：先写测试再写实现。但测的是不变量，不是实现细节——重构后行为不变，测试就不该红。

**第 4 层不能省**：全绿只说明「实现与测试自洽」。改坏实现，确认测试变红，才知道测试有牙。
半开区间那种语义，写测试的人自己也会理解偏。

**第 5 层不能省**：测试跑在 `:memory:` 上，从没碰过真实库。约束只防「写入时违反」，
防不了已经写进去的脏数据。

**第 6 层不可替代**：拖拽手感、快捷键冲突、视觉层级，工具完全看不见。

## 测试

- 每个用例一个全新的 `createDb(':memory:')`，不共享库
- 禁 mock 数据库——要测的就是真实 SQL 与触发器
- 一个 `it` 只断言一件事，用中文写成需求句式
- **每条核心规则做一次变异验证**：改坏实现，确认测试变红。没变红等于没写

## 提交

- 一个功能点一个提交，对应 `docs/steps/00-INDEX.md` 的编号
- 格式：`<type>(<编号>): <做了什么>`
- 提交前：`npx tsc --noEmit` 通过、无 `console.log`、无注释代码、验收清单逐条打勾

## 自查

写完后扫一眼：

- [ ] 查询带 `tenant_id` 了吗
- [ ] 跨租户返回 404 了吗
- [ ] 多表写入在同一个事务里吗
- [ ] 前端传的 `tenantId` 没覆盖会话身份吧
- [ ] service 没 import `next/headers` 吧
- [ ] 反直觉的地方写了「为什么」吗
