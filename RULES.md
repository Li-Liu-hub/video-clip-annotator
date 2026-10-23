# 开发规范

> 这份文件是**硬约束**，不是建议。
>
> 新代码不符合时，改代码，不要改规范。确有必要破例的，在提交信息里写明理由，
> 并在代码旁留下 `// rule-exception: <理由>`。

---

## 1. 设计规范

### 1.1 分层与依赖方向

```
app/（路由层）  →  lib/services/（业务层）  →  lib/db/repos/（数据层）  →  SQLite
```

**只允许向下依赖。** 反向引用一律禁止。

| 规则 | 强制手段 |
|---|---|
| `app/**` 不得 import `lib/db/**` | ESLint `no-restricted-imports` |
| `lib/services/**` 不得 import `next/headers`、`next/navigation` | 人工 review + ESLint |
| 只有 `lib/db/repos/**` 可以出现 SQL 字符串 | `scripts/audit-sql.mjs` |
| `lib/db/**` 不得 import `lib/services/**` | ESLint |

**为什么 service 层不能碰 `next/headers`**：一旦 import 了，这个函数就只能跑在请求上下文里，
测试无法直接调用。保持 service 是纯函数式的「(db, actor, 参数) → 结果」，才可测。

### 1.2 命名

| 对象 | 规则 | 示例 |
|---|---|---|
| 文件（模块） | kebab-case | `task-service.ts` |
| React 组件文件 | PascalCase | `Timeline.tsx` |
| 类型 / 接口 | PascalCase | `SessionUser` |
| 函数 / 变量 | camelCase | `claimTask` |
| 常量 | SCREAMING_SNAKE | `MAX_SEGMENT_COUNT` |
| 数据库字段 | snake_case | `tenant_id` |
| 领域对象字段 | camelCase | `tenantId` |

**行类型与领域类型必须分开**：数据库返回 `TaskRow`（`snake_case`），经 repo 转换成 `Task`（`camelCase`）。
不要在业务层直接消费 `snake_case`——那会让「数据库字段改名」渗透到整个代码库。

### 1.3 数据约定

**时间**

- 所有时间戳以 **UTC 毫秒整数**存储，字段名以 `_at` 结尾
- 「哪一天」是业务概念，用 `TEXT` 存 `YYYY-MM-DD`，字段名以 `_date` 结尾
- **日期在写入时固化，查询期绝不做时区换算**
- 时区换算只有一处实现：`src/lib/time.ts` 的 `localDateOf()`

**ID**

- 全部 `TEXT`，16 位十六进制，由 `newId()` 生成
- 不使用自增整数（会泄露数据量，且迁移困难）
- 不使用 UUID v4 的完整格式（太长，URL 里难看）

**租户**

- 每条业务数据都要能被 `tenant_id` 过滤
- 需要 join 才能得到 `tenant_id` 的表，冗余存一份（`segments`），理由是「查询忘了 join 时谓词仍然生效」
- 冗余字段的一致性由 `npm run db:check` 兜底

**区间**

- 全部使用**半开区间** `[start, end)`，单位毫秒
- 重叠判定恒为 `a.start < b.end && a.end > b.start`
- 首尾相接（`a.end == b.start`）**不算重叠**，是合法的连续标注

### 1.4 错误处理

**统一用 `AppError` 及其子类**，不用 `throw new Error('...')`：

```ts
class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) { super(message); }
}

class NotFoundError extends AppError { /* 404, code: 'NOT_FOUND' */ }
class ForbiddenError extends AppError { /* 403 */ }
class ValidationError extends AppError { /* 400 */ }
class StateConflictError extends AppError { /* 409 */ }
class OverlapError extends AppError { /* 409 */ }
```

规则：

- **跨租户访问一律返回 404，不返回 403。** 403 等于承认「这个资源存在」。
- 面向用户的 `message` 用中文，不含技术细节（不暴露表名、SQL、堆栈）
- 技术细节放 `details`，只写日志，不回给前端
- 数据库的 `SQLITE_CONSTRAINT` 必须在 repo 层翻译成领域错误，不允许泄漏到 service 以上

### 1.5 状态与流转

- 状态字段必须是 `TEXT` + `CHECK` 约束枚举，不用数字
- 状态跃迁必须在**事务内**用条件更新完成，不用「先查后改」

```sql
UPDATE tasks
   SET status = 'claimed', claimed_by = ?, claimed_at = ?
 WHERE id = ? AND tenant_id = ? AND status = 'pending';
-- 受影响行数为 1 才算成功
```

- 任何改变业务状态的操作，必须同时写审计（同事务）

---

## 2. 代码规范

### 2.1 语言层

- **禁止 `any`。** 需要动态类型时用 `unknown`，再用类型守卫收窄
- `tsconfig` 保持 `strict: true`，不允许 `@ts-ignore`；确需时用 `@ts-expect-error` 并附理由
- 不使用 `enum`，用 `as const` 对象 + 联合类型
- 不使用 `namespace`
- 默认导出只用于 React 页面组件与 Next 约定文件；其余一律具名导出

### 2.2 函数签名

**service 层固定签名**：

```ts
export function doSomething(db: DB, actor: SessionUser, input: XxxInput): XxxResult
```

- 第一个参数永远是 `db: DB`（测试注入内存库）
- 第二个参数永远是 `actor: SessionUser`（租户与角色的唯一来源）
- **绝不接受裸的 id 作为唯一身份依据**——凡涉及归属判断，必须同时传 `actor`

**repo 层签名**：

```ts
export function findTaskById(db: DB, tenantId: string | null, taskId: string): Task | null
```

`tenantId` 传 `null` 表示不限定（仅管理员路径使用）。**这个参数不允许缺省。**

### 2.3 文件与导出

- 一个文件一个主要导出，文件名体现职责
- 单文件超过 300 行时考虑拆分
- 不在 `index.ts` 里做 `export *`（会让依赖关系隐形）
- 魔法数字必须提为具名常量，并注明单位（`MAX_VIDEO_BYTES` 而非 `524288000`）

### 2.4 前端

- **视觉 token 只能来自 `globals.css` 的 `@theme`**，禁止在组件里硬编码色值
- 客户端组件必须有 `'use client'`，且尽量下推到叶子节点
- 不用 `useEffect` 做数据获取（用 Server Component 或事件回调）
- 所有会失败的用户操作必须有可见反馈（toast 或行内错误），不允许静默失败
- 乐观更新必须实现失败回滚

---

## 3. 注释规范

### 3.1 只写「为什么」，不写「是什么」

```ts
// ✗ 废话
// 把状态改成 claimed
tx.prepare('UPDATE tasks SET status = ? ...').run('claimed');

// ✓ 解释决策
// 虽然是单标注员场景，仍用条件更新而非「先查后改」——
// 多一个 WHERE 条件，省掉将来「一个租户多个标注员」时改代码的成本。
tx.prepare('UPDATE tasks SET status = ? ... WHERE status = ?').run('claimed', 'pending');
```

判断标准：**读完注释能不能知道「为什么不用另一种写法」**。不能，就是废话。

### 3.2 必须写注释的地方

| 场景 | 要求 |
|---|---|
| 数据库约束 / 触发器 | 说明防的是什么错误 |
| 事务边界 | 说明为什么这几步必须在同一事务 |
| 反直觉的实现 | 说明如果不这样写会出什么问题 |
| 绕过常规的地方 | 必须写 `// rule-exception: <理由>` |
| 常量 | 说明取值依据 |
| 文件头 | 一句话说明这个模块负责什么 |

### 3.3 禁止的注释

- 注释掉的代码（用 git 管理历史，不要留在文件里）
- `// TODO` 无 owner 无上下文（要留就写 `// TODO(下一步): 具体做什么`）
- 与代码不一致的过期注释（**比没有注释更糟**）
- 分隔线式的装饰注释（`// ===== 工具函数 =====`）

### 3.4 决策留痕

影响架构的选择，除了代码里的注释，还要写进 `docs/DESIGN.md` 的 ADR。
代码注释负责「这里为什么这样写」，ADR 负责「整个项目为什么这样选」。

---

## 4. 测试规范

### 4.1 测什么

**测不变量，不测实现细节。**

| ✓ 该测 | ✗ 不该测 |
|---|---|
| 跨租户访问必须失败 | 某个函数内部调了哪几个方法 |
| 任意操作序列后账本总和守恒 | `sumMs()` 返回的具体数字 |
| 同一任务内不存在重叠区间 | 组件渲染出几个 `<div>` |
| 非法状态跃迁被拒绝 | 私有函数的边界条件 |

**判断标准**：如果重构了实现但行为不变，测试**不应该**失败。会失败的测试说明它测的是实现。

### 4.2 隔离

- **每个测试用例一个全新的 `:memory:` 库**，通过 `createDb(':memory:')` 创建
- 禁止共享数据库再用 `afterEach` 清理——那会产生隐式顺序依赖
- 禁止 mock 数据库。要测的就是真实 SQL 与真实触发器

### 4.3 命名

```ts
describe('租户隔离', () => {
  it('标注员不能读取其他租户的任务', ...);
  it('标注员的列表查询忽略传入的 tenantId', ...);
});
```

- `describe` 用中文描述被测规则
- `it` 用中文描述预期行为，**要能当成需求文档读**
- 一个 `it` 只断言一件事

### 4.4 禁止事项

- 禁止 `expect(true).toBe(true)` 这类无意义断言
- 禁止为了通过而修改断言（改测试前先想清楚是测试错了还是实现错了）
- 禁止依赖执行顺序的测试
- 禁止 `setTimeout` 等待异步——用 `await` 或 `flushPromises`

### 4.5 有效性验证

**测试全绿不等于测试有效。**

每条核心规则必须做一次变异验证：故意把实现改坏，确认对应测试变红。
没变红的测试等于没写。结果记录在 `report.md`。

---

## 5. 提交规范

### 5.1 粒度

**一个功能点一个提交。** 对应 `docs/steps/00-INDEX.md` 里的编号。

不允许「顺手改了点别的」混在一起。发现了别的问题，先记下来，做完当前功能点再单独提交。

### 5.2 信息格式

```
<type>(<功能点编号>): <做了什么>

- 关键变更 1
- 关键变更 2
```

`type`：`feat` / `fix` / `refactor` / `test` / `docs` / `chore`

示例：

```
feat(A1): 建库表结构、触发器与索引

- schema.sql 重写为 9 张表
- 两个区间不重叠触发器（INSERT + UPDATE）
- 部分唯一索引保证一个租户只有一个标注员
```

### 5.3 提交前检查

- [ ] `npx tsc --noEmit` 通过
- [ ] `npm run lint` 无 error
- [ ] `npm test` 全绿（有测试之后）
- [ ] 该功能点的验收清单逐条打勾
- [ ] 没有注释掉的代码、没有调试用的 `console.log`

---

## 6. 快速检查清单

写代码时对照，提交前再扫一遍。

**数据**

- [ ] 每条查询都带了 `tenant_id`（管理员路径除外，且要显式传 `null`）
- [ ] 时间戳是 UTC 毫秒，日期是固化的 `YYYY-MM-DD`
- [ ] 区间是半开语义

**安全**

- [ ] 跨租户一律 404
- [ ] 前端传来的 `tenantId` 不能覆盖会话身份
- [ ] 密码用 `timingSafeEqual` 比较

**事务**

- [ ] 多表写入在同一个 `writeTx` 里
- [ ] 审计与业务同事务
- [ ] 状态跃迁用条件更新

**可测**

- [ ] service 签名是 `(db, actor, input)`
- [ ] 没有 import `next/headers`

**注释**

- [ ] 反直觉的地方有「为什么」
- [ ] 没有过期注释
