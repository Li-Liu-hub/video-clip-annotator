# 片段标注工作量统计

管理员把机器人示教视频分配出去，标注员在时间轴上标出有效片段，系统按「提交日期」
统计每人每天的有效工作量。

## 这是什么

替掉的是一套手工流程：标注员把起止时间填进表格，管理员每天手工汇总，**数字经常对不上**。

根因不是人不细心，而是同一份数据被反复重算。这里改成**记账**：提交写一笔正数，
退回写一笔负数，统计永远是 `SUM(账本) GROUP BY 日期`。已经写进某一天的数字，
后续任何操作都不会改写它。

界面截图待补（登录页 → 任务列表 → 标注工作台 → 统计页）。

## 跑起来

环境要求：Node.js ≥ 20.9，不需要装数据库、编译器或联网。

```bash
npm install
node scripts/setup.mjs --reset     # 必须在 dev 之前：建表 + 灌种子数据
npm run dev
```

打开 <http://localhost:3000>，用下面的账号登录（登录页可一键进入，不必输密码）。

| 账号 | 密码 | 角色 | 可见范围 |
|---|---|---|---|
| `admin` | `admin123` | 平台管理员 | 全部租户 |
| `alice` | `demo123` | 标注员 · 林小雨 | 仅自己的工作空间 |
| `bob` | `demo123` | 标注员 · 陈默 | 仅自己的工作空间 |
| `carol` | `demo123` | 标注员 · 周予安 | 仅自己的工作空间 |

**顺序不能反。** `predev` 只在库不存在时建库；库已存在但被上一次演示改过
（任务被领完、被退回、账本多了几笔）时，`npm run dev` 看到的是残留状态，
「alice 有一条 pending 任务」这种演示前提就不成立了。要复现演示路径，先 `--reset`。

生产形态用 `npm run build && npm start`。

## 四个角色能做什么

系统只有两种能力集合，演示数据里是四个账号（三个标注员各自独占一个租户，
所以互相看不见对方的工作空间）。

| 动作 | 平台管理员 | 标注员 |
|---|---|---|
| 上传视频、建任务并分配给租户 | ✓ | — |
| 看全部租户的任务与统计 | ✓ | — |
| 领取本租户的 pending 任务 | — | ✓ |
| 在工作台增删改片段、提交 | — | ✓ |
| 退回已提交的任务（必填原因） | ✓ | — |
| 重新打开被退回的任务并再次提交 | — | ✓ |
| 按天 / 按人 / 按任务看统计、导出 CSV | ✓（全量） | ✓（仅自己） |
| 查审计日志 | ✓ | — |

管理员不属于任何租户；标注员必须属于且只属于一个租户，
由 `users` 上的部分唯一索引与 CHECK 保证。

## 核心数据模型

四张表构成主链，其余（`users` / `tenants` / `videos` / `audit_logs` / `sessions`）是支撑：

| 表 | 职责 | 是否可改 |
|---|---|---|
| `tasks` | 一条任务归属于一个租户，状态在 pending → claimed → submitted → rejected 之间走 | 状态可变，内容不可变 |
| `segments` | 工作区草稿。标注员正在编辑的片段，可增删改，同一任务内不允许重叠（触发器兜底） | 可增删改 |
| `submissions` | 提交那一刻的冻结快照。退回后草稿会继续被改，但这次提交标了什么必须永久可查 | 只追加 |
| `ledger_entries` | 账本。`+total_ms` 计入、`-total_ms` 冲正，只追加 | 只追加 |

关系与两条铁律：

```
tasks 1 ── n segments        （草稿，提交时被冻结进快照）
tasks 1 ── n submissions     （每次提交一条；退回后再提交会取代上一条）
tasks 1 ── n ledger_entries  （提交 +N，退回 −N，都指向对应的 submission）
```

1. **账本是统计的唯一数据源。** 统计、CSV、图表都只读 `ledger_entries`，
   不再回头扫 `submissions` 求和。快照回答「那次交了什么」，账本回答「算多少」。
2. **冲正记在原提交日。** 退回一条 20 日提交的任务，负数也落在 20 日 ——
   那一天的净额立刻变准，而退回当天不会凭空出现一段负数工作量。
   代价是历史某天的净额会变（变准），「谁在何时退回了什么」由 `audit_logs` 回答。

`submissions.superseded_by` 指向取代它的那条快照。同一任务下
`superseded_by IS NULL` 的行必须恰好 0 或 1 条，否则同一份工作量会被算两次。

## 验收怎么跑

```bash
npx tsc --noEmit          # 类型
npx eslint .              # 全仓，含分层依赖规则
npm test                  # 726 例；pretest 另跑规范扫描 + 临时库不变量检查
npm run build             # 生产构建
```

全链路（需要服务已启动；脚本走真实 HTTP，会自己建一条任务，不依赖种子的 pending）：

```bash
node scripts/setup.mjs --reset
npm run dev               # 另开一个终端
node scripts/e2e-check.mjs
```

不变量（五组六条规则：账本合计 / 净额非负 / 快照唯一 / 账本与快照同源 /
状态与领取人配对 / 租户一致）：

```bash
npm run invariant:check           # 读 data/app.db，有违反则 exit 1
npm run invariant:check -- --temp # 一次性内存库：种子 + 完整业务链路后检查
```
另有两个历史入口仍在用（与 `invariant:check` 职责重叠但未合并）：
`npm run db:check`（14 条结构检查）与 `npm run db:verify-checker`（检查器的变异验证）。
新代码请用 `invariant:check`；旧的两个保留是因为它们的输出断言还没有跟着改。


`--temp` 不碰 `data/app.db`，所以它能挂在 `pretest` 里；真实库那一条只能手跑。

## 已知限制

未修项以 [`docs/steps/00-INDEX.md`](docs/steps/00-INDEX.md) 的「未修的已知项」表为准，
这里只列**自动化替代不了**的部分：

1. **撤销方向**（H1）。栈操作是纯函数、测得很扎实，但「Workbench 的调用点传的是
   before 还是 after」不在测试范围内 —— 实测把它改错后 510 例全绿（本轮 726 例同样覆盖不到）。
   手工验：拖一段 → `Ctrl+Z` → 必须回到原位；若停在原地或退回两步前，方向就反了。
2. **并发删除守卫**（O1c）。可验证的只有结构保证（ref 跨渲染稳定 + 入口守卫）。
   手工验：DevTools 限速 Slow 3G，一指拖片段、另一指点头删，Network 里
   **DELETE 必须只有 1 次、POST 必须 0 次**。不能看「界面有没有报错」——
   404 之后本地数组本来就不变。
3. **相邻色块的选中描边**（H5）。`ring-2` 会被后绘制的兄弟色块盖掉半圈，需要人眼目视。
4. **端到端的手感与视觉**。`e2e-check` 验的是 HTTP 与库，验不了拖拽是否跟手、
   时间轴刻度是否对齐、退回提示是否在视线内。演示路径第 1–7 步需要人走一遍。

另有两处已知的工程性取舍：

- **唯一的 `eslint-disable`**：`src/lib/services/audit-service.ts:59`。
  审计旁路失败必须留一条 error 日志，而 `no-console` 是全仓规则；
  该处已有 RULES 授权的 `rule-exception`（批准人 CLAUDE），故保留。新增 disable 前请先读这一行。
- **本项目没有组件测试设施**（没有 jsdom / Testing Library）。交互逻辑被拆成
  纯函数（`history` / `segment-drag` / `segment-selection` / `segment-interval`）后用单测覆盖，
  剩下的「组件里接线」只能靠上面 4 条人工验收。

本轮的验收记录与变异验证明细见 [`docs/REPORT.md`](docs/REPORT.md)。
