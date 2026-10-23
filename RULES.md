# 开发规范

硬约束，非建议。冲突时改代码，不改规范。

**零信任**：不依赖 agent 自觉。可机械检查者，一律脚本化。

## 工作方式（XP）

小步、结对、持续集成、简单设计、随时重构。

### 结对

| 角色 | 职责 | 约束 |
|---|---|---|
| Writer | 依功能点文档实现 | 仅读需求与规范；存疑即停机 |
| Reviewer | 独立判定实现正确性 | 不看 Writer 推理过程；不重写业务实现 |

Reviewer 的独立性是本流程唯一价值来源。知情推理则沿同一思路审查，「需求理解偏差」不可发现。

Reviewer 职责：核对验收清单、核对本规范、独立验证（测试、检查器、自撰反例测试）。
输出须为具体问题（文件 + 行 + 失败原因）或「未发现问题 + 检查范围」，不接受主观判断。

Reviewer 可撰写反例测试、修改命名与注释；禁止重写业务实现。
逻辑缺陷须打回 Writer，附「文件 + 行 + 反例测试」。
同一功能点往返逾 3 轮未全绿，熔断，交人类裁决。

### 停机上报

需求歧义、边界未定义、或与本规范冲突时，Writer 立即停止并列出阻塞点，禁止自行补全需求。

### 节奏

- 一个功能点一个提交，绿灯即推送；红灯不进入下一步
- 提交前：`tsc --noEmit` 通过、测试绿、验收清单逐条确认
- 仅实现当前功能点所需，不为「以后可能要」预留抽象
- 绿灯后如发现重复或结构问题，先重构再继续，重构须保持测试绿

## 分层

```
app/ → lib/server/ → lib/services/ → lib/db/repos/ → SQLite
```

仅允许向下依赖。

- `app/**` 不 import `lib/db/**`（ESLint 强制）
- `lib/server/**` 是请求上下文适配层：允许 import `next/headers`、`next/navigation` 与 `@/lib/db` 的 `getDb`；
  每个文件只做「取请求上下文 → 调 service → 返回」，不写业务判断（该层不可单测，判断写在这里就无人验证）
- `lib/services/**` 不 import `next/headers`、`next/navigation`
- SQL 字符串仅允许出现于 `lib/db/repos/**`
- 事务边界仅在 service 层，repo 不自行 `BEGIN`

## 命名

| 对象 | 规则 | 例 |
|---|---|---|
| 文件 | kebab-case | `task-service.ts` |
| 组件 | PascalCase | `Timeline.tsx` |
| 类型 | PascalCase | `SessionUser` |
| 常量 | SCREAMING_SNAKE | `MAX_VIDEO_BYTES` |
| 数据库字段 | snake_case | `tenant_id` |
| 领域字段 | camelCase | `tenantId` |

`TaskRow`（DB，snake）与 `Task`（领域，camel）分离，于 repo 层转换。

## 数据

- 时间戳：UTC 毫秒整数，后缀 `_at`
- 日期：`TEXT` `YYYY-MM-DD`，后缀 `_date`；写入时固化，查询期不换算
- 时区换算唯一实现于 `lib/time.ts` 的 `localDateOf()`
- ID：16 位十六进制，`newId()` 生成
- 区间：半开 `[start, end)`，毫秒；重叠判定 `a.start < b.end && a.end > b.start`
- 业务查询须含 `tenant_id`（管理员路径传 `null` 且显式）

## 错误

- 使用 `AppError` 子类，禁用 `throw new Error()`
- 跨租户访问返回 404，禁用 403（403 确认资源存在性）
- 用户可见 `message` 用中文，不含表名、SQL、堆栈
- `SQLITE_CONSTRAINT` 须于 repo 层译为领域错误
- 404 与 409 判定顺序：先判存在性与租户归属，再判状态

## 状态跃迁

正常路径以单条 SQL 原子完成：

```sql
UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?
 WHERE id = ? AND tenant_id = ? AND status = 'pending';
```

`changes === 1` 视为成功。`changes === 0` 时原因不明，允许于同一事务内补查一次：

```ts
const exists = db.prepare('SELECT 1 FROM tasks WHERE id = ? AND tenant_id = ?').get(id, tenantId);
throw exists ? new StateConflictError('当前状态不允许该操作') : new NotFoundError();
```

补查仅在失败分支执行。禁止的是以「先查」替代原子更新，非禁止判定失败原因。

## 代码

- 禁 `any`，用 `unknown` + 类型守卫
- 禁 `enum`，用 `as const` + 联合类型
- service 签名：`fn(db: DB, actor: SessionUser, input): Result`
- repo 签名：`fn(db: DB, tenantId: string | null, ...): Row | Row[]`
- 多表写入须于同一 `writeTx` 内，审计与业务同事务
- 魔法数字提为具名常量并注明单位

## 注释

- 每个文件顶部须有文件头，一句话说明职责
- 非自明函数（逾 15 行、有副作用、含业务规则）以一行说明用途
- 关键选择写明「为何用此方案」
- 一行可述者不写两行，删除形容词
- 禁：注释掉的代码、无主 TODO、与代码不符的过期注释、装饰性分隔线
- 破例须人类授权：`// rule-exception: <理由> —— 批准人 <who>`；
  Writer 禁自行添加，Reviewer 遇无授权破例一票否决

## 验证

六层，各司其职，任一缺失则该类问题无人负责。

| # | 手段 | 职责 | 命令 |
|---|---|---|---|
| 1 | TDD | 业务规则正确性 | `npm test` |
| 2 | ESLint | 依赖方向 | `npm run lint` |
| 3 | SQL 扫描 | 租户谓词完整性 | `npm run audit:sql` |
| 4 | 变异验证 | 前三层有效性 | `npm run db:verify-checker` |
| 5 | 运行库检查 | 存量数据一致性 | `npm run db:check` |
| 6 | 手工验收 | UI 手感与视觉 | — |

另有 `npm run audit:rules`（挂于 `pretest`）：`rule-exception` 授权、repo 事务、
`.only`、`console.log`、跨租户 403。

- 第 4 层不可省：全绿仅示实现与测试自洽，不示测试有效
- 第 5 层不可省：测试运行于 `:memory:`，未触及真实库
- 第 6 层不可替代：交互与视觉无工具可测

## 测试

- 每用例独立 `createDb(':memory:')`，不共享库
- 禁 mock 数据库
- 一个 `it` 一个断言，中文需求句式
- 每条核心规则执行一次变异验证，未变红者视为未测

## 提交

- 一个功能点一个提交，对应 `docs/steps/00-INDEX.md` 编号
- 格式：`<type>(<编号>): <描述>`
- 提交前：`tsc --noEmit` 通过、无 `console.log`、无注释代码、验收清单逐条确认

## 自查

- [ ] 查询含 `tenant_id`
- [ ] 跨租户返回 404
- [ ] 多表写入同事务
- [ ] 前端 `tenantId` 未覆盖会话身份
- [ ] service 未 import `next/headers`
- [ ] 反直觉处已写明原因
