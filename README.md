# 片段标注工作量统计

管理员把机器人示教视频分配出去，标注员在时间轴上标出有效片段，系统按「提交日期」
统计每人每天的有效工作量。

**当前状态**：33 个功能点 + 计划外 E8a + 加固 O1–O4 + 收尾 P1–P7 + 门禁 Q1–Q3
全部完成。867 例单测、59 项浏览器验收、53 项全链路、五组七条不变量全绿；
[`00-INDEX`](docs/steps/00-INDEX.md) 的已知项清单为零，剩余边界见「已知限制」。

## 这是什么

替掉的是一套手工流程：标注员把起止时间填进表格，管理员每天手工汇总，**数字经常对不上**。

根因不是人不细心，而是同一份数据被反复重算。这里改成**记账**：提交写一笔正数，
退回写一笔负数，统计永远是 `SUM(账本) GROUP BY 日期`。已经写进某一天的数字，
后续任何操作都不会改写它。

界面截图：选中态见 [`docs/ring-selected.png`](docs/ring-selected.png)；其余页面截图待补。

## 跑起来

环境要求：Node.js ≥ 20.9，不需要装数据库、编译器或联网。

```bash
npm install
node scripts/setup.mjs --reset     # 必须在 dev 之前：建表 + 建管理员
npm run dev
```

打开 <http://localhost:3000>，用 `admin` 和 **setup 输出里那行随机口令** 登录
（默认模式下四个账号共用这一个口令）。默认库的数据是**全量**的 —— 3 个租户、4 个账号、
17 个任务与历史账本，只有口令是随机的：它只在建库输出里出现一次，不写文件、不进本文。
漏抄了就 `node scripts/setup.mjs --reset` 重建，或者登录后调用
`POST /api/auth/password` 换掉。

数据始终全量、只把口令随机，是 O1 的取舍：安全要防的是「口令已知」，不是「有数据」。
把数据也一起去掉，`npm run dev` 登录后什么都看不到。

### 要固定口令与一键登录

默认库的口令随机，演示时不好逐个转达。种子与前端各开一个开关，就换成文档里的固定口令：

```bash
DEMO_LOGIN=1 node scripts/setup.mjs --reset   # admin + alice|bob|carol
NEXT_PUBLIC_DEMO_LOGIN=1 npm run dev          # 登录页出现「演示账号」一键入口
```

| 账号 | 密码 | 角色 | 可见范围 |
|---|---|---|---|
| `admin` | `admin123` | 平台管理员 | 全部租户 |
| `alice` | `demo123` | 标注员 · 林小雨 | 仅自己的工作空间 |
| `bob` | `demo123` | 标注员 · 陈默 | 仅自己的工作空间 |
| `carol` | `demo123` | 标注员 · 周予安 | 仅自己的工作空间 |

两个开关都不设时，登录页没有「演示账号」区域，客户端 bundle 里也没有这些口令：
`NEXT_PUBLIC_DEMO_LOGIN` 在构建期内联，未开启时整段演示数据被摇掉。

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

## 键盘与无障碍

工作台里：`Space` 播放/暂停、`I` / `O` 打点建片段、`Delete` 删除选中、`← →` 微调播放头、
`Ctrl+Z` 撤销、`Esc` 取消拖拽或清除入点。

- **单字符快捷键可关闭**（WCAG 2.1.4）：页脚有开关，偏好存本机 `localStorage`。
  关闭只停空格 / I / O；`Delete`、方向键、`Ctrl+Z` 不是字符键，照常可用。
- **删除后焦点续接**：移到下一段的选中按钮；没有下一段就移到上一段；列表空了移到空态文本。
- **删除中可读**：按钮带 `aria-busy`，读屏文案变成「第 N 段删除中」。
- **O 键太短有提示**：区间不足 0.1 秒时不创建，状态行说明「入点还在，挪一下再按 O」。

## 验收怎么跑

```bash
npx tsc --noEmit          # 类型
npx eslint .              # 全仓，含分层依赖规则
npm test                  # 867 例；pretest 另跑规范扫描 + 临时库不变量检查
npm run build             # 生产构建
npm run verify            # 全量门禁：npm test + test:browser（59 项，自动起停服务）
```

`test:browser` 需要 Python 3 与 Playwright：

```bash
pip install playwright
python -m playwright install chromium
npm run test:browser      # 三段脚本，每段独立种子库与服务
```

默认解释器依次试 `python` / `python3` / `py`；都不行时用 `PYTHON=/path/to/python` 指定。
CI 配置在 `docs/ci/verify.yml`：推送用的 token 只有 `repo` scope，GitHub 拒绝写
`.github/workflows/`；换一个有 `workflow` scope 的 token（或在网页上新建）即可启用，
步骤见 [`docs/ci/README.md`](docs/ci/README.md)。

本机有 pre-push 钩子，push 前跑 `npm test`。首次克隆后启用一次：

```bash
git config core.hooksPath .githooks
```

全链路（需要服务已启动；脚本走真实 HTTP，会自己建一条任务，不依赖种子的 pending）：

```bash
node scripts/setup.mjs --reset
npm run dev               # 另开一个终端
node scripts/e2e-check.mjs
```

不变量（五组七条规则：账本合计 / 净额非负 / 快照唯一 / 快照自洽 / 账本与快照同源 /
状态与领取人配对 / 租户一致）：

```bash
npm run invariant:check           # 读 data/app.db，有违反则 exit 1
npm run invariant:check -- --temp # 一次性内存库：种子 + 完整业务链路后检查
```
`db:check`（8 条结构 / 格式检查）与 `db:verify-checker`（9 组变异）保留为独立入口。
快照的两条规则（自洽、唯一）已合并到 `invariant:check`，全仓只有一处实现。

`--temp` 不碰 `data/app.db`，所以它能挂在 `pretest` 里；真实库那一条只能手跑。

## 已知限制

以 [`docs/steps/00-INDEX.md`](docs/steps/00-INDEX.md) 的「已知项处理记录」为准，
**现在没有待修项**。剩下的是自动化的边界：

1. **`npm test` 不含浏览器。** 撤销方向、删除守卫、焦点、快捷键、太短提示已进组件测试；
   拖拽几何、视频 206、真实焦点只在 `npm run test:browser` 与全量 `verify` 里。
   只跑 `npm test` 不会发现这几类回归 —— 提交前跑 `npm run verify`。
2. **jsdom 不实现布局与媒体。** 组件测试覆盖的是接线，不是像素；相邻描边、拖拽吸附
   仍需浏览器门禁。这是分层，不是缺口。
3. **统计页的视觉没人看过。** 数据路径由全链路与不变量验过；配色、密度这类判断没有自动化。
4. **CI 配置尚未启用。** 推送 token 缺 `workflow` scope，`.github/workflows/` 写不进去；
   配置放在 `docs/ci/verify.yml`，启用步骤见 `docs/ci/README.md`。本机 push 前有
   pre-push 钩子跑 `npm test`；浏览器门禁需手动 `npm run verify`。

另有两处工程取舍：

- **唯一的 `eslint-disable`**：`src/lib/services/audit-service.ts:59`。
  审计旁路失败必须留一条 error 日志，而 `no-console` 是全仓规则；
  该处已有 RULES 授权的 `rule-exception`（批准人 CLAUDE），故保留。新增 disable 前请先读这一行。
- **测试分三层**：纯函数跑 node（最快）；组件接线跑 jsdom（`tests/*.dom.test.tsx`）；
  浏览器行为跑 Playwright（`scripts/browser/`）。`npm test` 只跑前两层，`verify` 跑全量。

## 文档

- 功能点编号、契约与已知项：[`docs/steps/00-INDEX.md`](docs/steps/00-INDEX.md)
- 验收记录与变异验证：[`docs/REPORT.md`](docs/REPORT.md)
- CI 启用步骤：[`docs/ci/README.md`](docs/ci/README.md)
