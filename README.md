# 机器人示教视频片段标注与工作量统计

供管理员分配视频任务、标注员标记有效时间片段、管理员复核提交并统计工作量的 Web 项目。

系统把“提交了什么”和“计入多少工作量”分别保存：提交时冻结片段快照并写入正向账目，退回时保留快照并写入反向账目。工作量按账本净额统计，可追溯到具体人员、提交日期和任务。

## 项目做了什么

### 管理员

- 上传 MP4 视频，创建任务并批量发布到多个标注员的工作空间。
- 发布前展开各空间的已有任务，查看标题、状态、领取人和视频，按页浏览。
- 从待审核任务进入审核页，播放提交时保存的片段，核对标签和起止时间。
- 查看历史提交；发现问题时填写原因并退回，系统同步冲正工作量。
- 按日、按人或按任务统计并导出 CSV。按人明细展示日期、任务、有效片段数、净时长、提交次数和退回次数。
- 查询操作审计记录。

### 标注员

- 在自己的空间领取任务，标记、移动、调整或删除视频片段。
- 使用时间轴、片段列表、快捷键和撤销功能完成标注。
- 提交后只读回顾；被退回后查看原因、重新打开任务、修改并再次提交。
- 在“我的工作量”中按日或按任务查看本人数据并导出 CSV。

两种角色共用视频舞台、自绘播放控件和片段列表。审核页使用只读时间轴，点击片段从起点播放，到终点暂停。

当前采用“一位标注员对应一个个人工作空间”的租户模型。系统有两种角色，演示数据有四个账号；管理员不属于任何租户。

## 主要技术

| 部分 | 实现 |
|---|---|
| 页面与接口 | Next.js 15 App Router、React 19、TypeScript |
| 样式 | Tailwind CSS 4、自绘 SVG 图表与时间轴 |
| 数据 | SQLite、better-sqlite3、本地视频文件 |
| 视频 | 浏览器 video 元素、自绘控件、带鉴权的 HTTP Range 流接口 |
| 身份 | scrypt 密码哈希、数据库会话、角色与租户范围校验 |
| 验证 | Vitest、Testing Library、Python Playwright、规则扫描和数据不变量检查 |

项目运行时不调用大模型，AI 用于开发辅助。开发取舍、实际使用的规则与技能、验证证据及限制见 [report.md](report.md)。

## 怎么跑起来

### 1. 环境

建议使用 Node.js 22 LTS，本次 Linux 验证使用 22.22.2。`package.json` 声明最低版本为 20.9，但没有验证所有低版本依赖组合。无需另装 MySQL、Redis 或外部数据库服务。

首次安装依赖通常需要联网。better-sqlite3 是原生扩展；没有匹配预编译包时可能需要本机编译工具。

### 2. 安装并启动

以下命令适用于 PowerShell 和 Bash：

```bash
git clone https://github.com/Li-Liu-hub/video-clip-annotator.git
cd video-clip-annotator
npm ci
npm run dev
```

打开 [本地登录页](http://localhost:3000/login)。首次启动自动建库、复制示例视频并写入种子数据；终端会输出一次初始随机口令。默认四个账号共用这次生成的口令：`admin` 是管理员，`alice`、`bob`、`carol` 是标注员。

已有库时初始化会跳过，继续使用原来的账号、任务和密码。正常启动不需要 `--reset`。数据位于 `data/app.db` 和 `data/videos/`，不提交到 Git。

### 3. 固定演示账号（可选）

以下重建命令会删除当前配置指向的数据库和视频目录。只在可丢弃数据的演示环境执行；已有数据先备份。

PowerShell：

```powershell
$env:DEMO_LOGIN = "1"
node scripts/setup.mjs --reset
$env:NEXT_PUBLIC_DEMO_LOGIN = "1"
npm run dev
```

Bash：

```bash
DEMO_LOGIN=1 node scripts/setup.mjs --reset
NEXT_PUBLIC_DEMO_LOGIN=1 npm run dev
```

| 账号 | 演示密码 | 身份 |
|---|---|---|
| `admin` | `admin123` | 管理员 |
| `alice` | `demo123` | 林小雨 |
| `bob` | `demo123` | 陈默 |
| `carol` | `demo123` | 周予安 |

`DEMO_LOGIN` 决定建库时的口令，`NEXT_PUBLIC_DEMO_LOGIN` 决定登录页是否显示演示账号入口。已有库不会因为设置环境变量就自动更换密码。

### 4. 体验一次业务流程

1. 管理员上传视频或使用已有素材，创建任务并选择发布空间。
2. 对应标注员登录，在“我的任务”领取任务，进入工作台。
3. 拖动时间轴建立片段，检查起止时间并提交。
4. 管理员打开待审核提交，点击片段播放；需要修改时填写原因并退回。
5. 查看统计：退回的时长和有效片段数从原提交日扣除；标注员修改后可再次提交。

工作台支持空格播放/暂停、I/O 打点、Delete 删除、方向键微调、Ctrl+Z 撤销和 Esc 取消。单字符快捷键可在页脚关闭。

### 5. 生产构建与配置

```bash
npm run build
npm start
```

| 环境变量 | 用途 |
|---|---|
| `DATABASE_PATH` | SQLite 文件；默认 `data/app.db` |
| `VIDEO_DIR` | 视频目录；默认 `data/videos` |
| `NEXT_PUBLIC_BASE_PATH` | 子路径，例如 `/vsap`；构建与运行时都要设置 |
| `DEMO_LOGIN` | 建库时使用固定演示口令 |
| `NEXT_PUBLIC_DEMO_LOGIN` | 构建/开发时显示演示账号入口 |
| `SESSION_COOKIE_SECURE` | 默认生产使用 Secure Cookie；`0` 仅用于 HTTP 演示 |

配置示例见 [docs/DEPLOY.md](docs/DEPLOY.md)。R2 功能代码已推送 GitHub，按用户要求停止了服务器版本切换；现有线上演示不代表当前代码的最新状态。

## 项目结构

```text
.
├─ src/
│  ├─ app/
│  │  ├─ login/                 登录页面
│  │  ├─ admin/                 视频管理、任务发布、提交审核、审计
│  │  ├─ tasks/                 标注员任务列表与标注工作台
│  │  ├─ stats/                 统计页面与图表
│  │  └─ api/                   登录、视频、任务、统计等接口
│  ├─ components/               共用外壳、导航、标题、视频播放器
│  └─ lib/
│     ├─ server/                身份、页面/API 守卫等请求适配
│     ├─ services/              业务规则、权限范围与事务边界
│     ├─ db/
│     │  ├─ schema.sql          表、索引、约束和触发器
│     │  └─ repos/              SQL 读写与聚合
│     └─ *.ts                   时间、区间、拖拽、CSV 等共用逻辑
├─ scripts/                     初始化、规则扫描、数据检查、HTTP 验收
│  └─ browser/                  五组真实浏览器验收与启动器
├─ tests/                       单元、服务与 DOM 组件测试
├─ fixtures/videos/             示例视频
├─ docs/                        设计、历史验收、部署与功能点记录
├─ .githooks/pre-push           本地推送前检查
├─ RULES.md                     用户制定的开发规则
├─ report.md                    完整 Rules、设计取舍、AI 验证与未完成项
└─ README.md                    项目功能、结构和运行入口
```

主要调用方向为 `app → server/services → db/repos → SQLite`。页面和接口经业务层访问数据，SQL 集中在 repo，事务边界集中在 service。

## 怎么验证

```bash
npm test                       # 规范、SQL、ESLint、临时库不变量、Vitest
npx tsc --noEmit                # 类型检查
npm run build                  # 生产构建；浏览器验收前先执行
npm run verify                 # npm test + 五组浏览器验收
npm run db:check                # 当前运行库结构与格式检查
npm run invariant:check         # 当前运行库跨表业务不变量
npm run db:verify-checker       # 在数据库副本上验证检查器能否发现故意制造的错误
```

浏览器验收额外需要 Python Playwright：

```bash
python -m pip install playwright
python -m playwright install chromium
npm run test:browser
```

启动器会寻找可用的 `python` / `python3` / `py`，也可用 `PYTHON` 指定解释器。默认使用本地 3100 端口，每组使用独立临时数据库和视频目录。构建与浏览器验收应顺序执行。

2026-10-26 的记录为 **908 项自动化测试、99 项浏览器检查通过**，类型检查与生产构建通过。Windows Node 24.5.0 下数据库变异脚本曾崩溃，同一提交在 Linux Node 22.22.2 暂存环境中 9/9 通过；证据边界见报告。

首次克隆后可启用本地推送钩子：

```bash
git config core.hooksPath .githooks
```

仓库尚未启用 GitHub Actions，配置草案位于 [docs/ci/](docs/ci/README.md)。本地钩子不等于远端强制检查。

## 更多说明

- [开发报告](report.md)：完整 Rules、设计决定、AI 代码验证、skills、存疑与未完成项。
- [开发规范](RULES.md)：规则来源；报告保留完整快照。
- [设计文档](docs/DESIGN.md)：业务与数据库设计，历史描述由最新功能点记录补充。
- [功能点索引](docs/steps/00-INDEX.md) 与 [R2 管理明细](docs/steps/42-management-details.md)。
- [历史验收报告](docs/REPORT.md)：保留早期测试和变异过程，不作为当前用例数量的口径。

当前是单实例演示/原型系统。生产化、规则执行差距和数据边界见 [report.md 的后续事项](report.md#6-没做完或仍需确认的地方)。
