# 全量扫描报告

**时间**：2026-10-25
**范围**：`src/`（96 文件 / 9864 行）、`scripts/`、`docs/`（35 份）、配置与依赖
**方法**：自动化门禁 + 三路独立扫描（安全 / 质量 / 文档一致性）+ 人工复核关键项

---

## 0 基线

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误 |
| `npm test` | 731 例全绿（含 audit:rules / audit:sql / eslint / invariant:check --temp） |
| `npm run invariant:check` | 18 任务 / 15 账目 / 14 快照，0 项违反 |
| `npx eslint .` | 0 error 0 warning |
| `db:check` / `db:verify-checker` | 14/14、6/6 |
| TODO / FIXME / `any` / `console.log` | 0 / 0 / 0 / 0 |
| `eslint-disable` | 1（`audit-service.ts:59`，带 `rule-exception` 与批准人） |

静态层面是干净的。下面全是静态检查看不见的东西。

---

## 1 严重：默认口令在客户端 bundle 里，且没有改密入口 —— **已修（O1）**

> 修法见 `docs/steps/34-auth-hardening.md`。默认构建的 `.next/static` 里
> `admin123` / `demo123` / `DEMO_ACCOUNTS` / `林小雨` 四个 needle 全部干净；
> `NEXT_PUBLIC_DEMO_LOGIN=1` 构建后能命中（正向对照）。
> 默认 seed 改成「全量数据 + 随机口令（打印一次）」，`admin123` 登录必然 401。
> 已补 `POST /api/auth/password`。

**位置**：`src/app/login/LoginForm.tsx:13`、`scripts/seed.mjs:49`、`README.md:26`

**已验证**：

```
$ grep -rl "admin123" .next/static
.next/static/chunks/app/login/page-24d1c42d97d972a6.js
```

`DEMO_ACCOUNTS` 把 `admin/admin123`、`alice|bob|carol/demo123` 明文写进客户端组件，
登录页可一键进入，`prebuild` 还会灌入同口令的种子账号。
全项目没有任何修改密码的入口。

**后果**：任何人打开登录页点一下就是跨租户管理员。口令已随 JS 分片下发到每个浏览器。
即使不看源码，产品功能里也没有任何办法改掉它。

**这不是"疏忽"，是演示设计与交付设计的冲突**：一键登录是给评审/演示用的，
但它现在是无条件生效的。两种处置：

| 方案 | 做法 | 代价 |
|---|---|---|
| A 按环境开关 | `NEXT_PUBLIC_DEMO_LOGIN=1` 时才渲染 `DEMO_ACCOUNTS`，默认关闭 | 演示时要带环境变量 |
| B 保留但显式声明 | README 顶部加红框「演示账号，禁止用于任何真实环境」，并在 `setup --reset` 时打印警告 | 依赖使用者自觉 |

建议 **A + B 都做**：默认关闭，演示时开；同时在 README 与启动日志里写明。
另外补一个最小的改密接口（`POST /api/auth/password`，要求旧密码），
否则即使关掉演示登录，管理员也换不了默认口令。

---

## 2 中：登录接口零限流，且 `scryptSync` 阻塞事件循环 —— **已修（O1）**

> `scryptSync` → `promisify(scrypt)`，`verifyPassword` / `authenticate` 全链路 async。
> 漏 `await` 会让校验恒真（Promise 永真），已用 M1/M2 两个变异自证：各红 4 例。
> 失败计数：`IP + 小写用户名`，60 秒 5 次，第 6 次直接 429 且不跑 scrypt
> （连错 5 次 401、第 6 次 429，实测）。

**位置**：`src/app/api/auth/login/route.ts:72`、`auth-service.ts:73`

- 未认证接口没有计数、延时、锁定或 IP 维度限制
- 每次登录同步跑一次 scrypt（实测 **66ms**，Node 单线程）

**后果**：20 个并发登录请求 ≈ 1.3 秒全站卡死（含正在标注的页面），请求成本近乎为零。
爆破也是可行的——`admin123` 这种口令几秒内可猜中。

**这不是"要不要做限流"的问题**：`scryptSync` 放在请求线程里，等于给了任何一个未认证用户
一个成本极低的 DoS 开关。最小修法：

1. 换 `scrypt`（异步版），至少不阻塞事件循环
2. 加一个进程内的失败计数（同 IP + 同用户名，5 次/分钟），返回 429

---

## 3 中：写接口只靠 `SameSite=Lax`，无 Origin 校验 —— **已修（O2）**

> 12 个写 handler 已统一接入 `requireSameOrigin`，`Origin: null` 按不同源处理；
> `scripts/audit-rules.mjs` 规则 6 用 AST 守住接入点，删掉调用会直接让门禁变红。

**位置**：13 个写 handler；cookie 属性见 `login/route.ts:92`

`SameSite` 的 "site" 忽略端口、只看可注册域。同主机另一个端口的服务
（内网常见：Wiki、Jenkins、老系统）或同父域子域，可以发简单请求
（`text/plain` 不触发预检）完成领取/删除/提交/退回——读不到响应，但副作用已经发生。

**修法**：写接口加一条 Origin/Referer 同源校验（约 10 行），或发 CSRF token。

如果交付环境确定是「独立主机 + 单端口 + 无同域其他应用」，可降为低。

---

## 4 低：提交时片段在事务外读（TOCTOU）—— **已修（O3）**

**位置**：`submit-service.ts:42`（事务外 `listByTask`）→ `:54`（事务内只重判任务状态）

同一标注员的并发「删片段」可以在两次读之间落地（那时任务仍是 `claimed`），
随后提交把已删除的片段写进快照与账本。

**现有不变量抓不到**：`listTaskBalanceMismatches` 只比账本与 submissions，
不比 submissions 与当前 segments。要在 I-3 里加一条「快照的 segments_json
必须与提交时刻的 segments 一致」，但那个时刻已经过去了——所以正确修法是把
`listByTask` 挪进事务。

**O3 修法**：`requireWritableTask` 与 `listByTask` 一起进 `writeTx`（`BEGIN IMMEDIATE`），
并发删除要么在本事务前落地（读到删后状态），要么等本事务结束（那时任务已 submitted，
`deleteSegment` 会 404）。`tests/submit-toctou.test.ts` 用真实 worker 线程持写锁复现。
配套补 `snapshot-total` 不变量：快照 `total_ms` 必须等于 `segments_json` 各段之和。

---

## 5 低：视频时长完全信任客户端，而它决定账本上限 —— **已修（O3）**

**位置**：`api/videos/route.ts:66`、`video-service.ts:82`

`x-duration-ms` 只校验「正整数」，没有上限、不与文件实际时长比对。
片段合法范围 `endMs <= task.estimated_ms` 取自它。

**后果**：声明 999 小时即可让标注员合法标出 999 小时。需管理员权限，故列为低。
真正的修法是服务端解析 mp4 的 `moov`（项目里已有读时长的兜底逻辑可复用）。

**O3 修法**：`lib/mp4-duration` 顺 box 链读 `mvhd`（支持 moov 在尾部、扩展头、v1 的 64 位），
解析失败直接拒收；客户端声明值只做 ±2s 交叉校验，落库用解析值；上限 4 小时。
`tests/mp4-duration.test.ts` 覆盖两个真样本（含 moov 在 6.7MB 处的 pusht）与 18 个构造边界。

---

## 6 低：缺安全响应头 —— **已修（O4）**

`next.config.ts` 只设了 `poweredByHeader: false`。没有 CSP / `frame-ancestors` /
`X-Frame-Options` / `nosniff`。

**后果**：管理端可被任意站点 iframe 嵌套 + 透明覆盖，诱导管理员点「退回」
（点击劫持，绕过 SameSite）。

**O4 修法**：`next.config.ts` 的 `headers()` 对 `/:path*` 下发
`X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'`、
`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`。
不写完整 CSP：Next 需要 inline script，没有 nonce 管线时严格 CSP 只会把页面打挂。
`tests/next-config.test.ts` 直接调用 `headers()` 钉住四条值与作用范围
（变异：改成只覆盖 `/admin` → 恰好 1 例红）。

---

## 7 质量：22 组重复实现，其中 6 组会静默分叉 —— **6 组已修（O2）**

完整清单在扫描记录里，这里只列**改一处漏一处且不会变红**的：

| # | 现象 | 为什么会静默 |
|---|---|---|
| 1 | **两套不变量检查器**：`db:check`（14 条手写 SQL）与 `invariant:check`（6 条）至少 4 条规则重叠，各写一遍；`verify-checker.mjs` 只验证旧套 | 一方改口径会出现「一个绿一个红」，运维随后不信任何一个 |
| 2 | **归属+状态门禁三份**：`segment-service` 的 `requireReadableTask`、`workbench-service` 逐行重写、`review-service` 内联 | 加第五个状态时漏一处 → 工作台能开、片段列表 404 |
| 3 | **上传上限两份**：`video-service.MAX_VIDEO_BYTES` 与 `video-upload.MAX_UPLOAD_BYTES`，注释写着「须同步」 | 前端放行、后端 413 |
| 4 | **`WORKBENCH_STATUS_ID` 导出但 0 引用**，`Workbench.tsx` 硬编码同一个字符串 | 改任一处都不会有编译错误，只静默丢掉无障碍关联 |
| 5 | **RULES 说「`newId()` 生成 ID」，`newId()` 全仓不存在**，6 处各写 `randomBytes(8)` | 有人照文档写第 7 份，写成 4 字节就静默破坏 16 位假设 |
| 6 | **死代码**：`time.ts` 的 `formatHours` / `recentDates` 零引用 | 下一个人以为日汇总还该用它，再抄一遍 |

另有 12 组「可改」：错误消息提取四份、`isConstraintViolation` 四份、`MS_PER_SECOND` 四份、
时长求和四份、`formatSize` 两份、`DateRange`/`BarSlot` 类型各两份、查询串取首值四份、
`readJson` 三份、`toErrorResponse` 包装 12 处、`TaskList` 三个动作 120 行近乎复制、
审计筛选的时区计算在页面组件里。

**没有分层违规**：`app/**` 无 SQL 无 `lib/db` import，`services` 无 `next/*`，SQL 只在 repos。
边界与健壮性整体良好（JSON.parse 4 处全有 try/catch，Number 4 处全后接 isFinite，
`[0]` 取值 8 处全有前置守卫，除零 3 处全有兜底）。

**O2 收口结果**：表中 6 组全部处理。归属门禁收敛到 `segment-service` 一处
（`review-service` 的 reopen 必须用 owned，不能用 readable —— 目标状态就是 rejected）；
上传上限与 MIME 白名单收敛到 `lib/video-limits`；`newId()` 落到 `lib/db/id.ts`（7 个调用点）；
`db:check` 从 14 条降到 10 条（删掉 4 条与 `invariants.ts` 真重叠的），
Q3 又删掉 2 条快照规则（自洽、唯一），现在是 8 条纯结构/格式检查；
`invariant:check` 升到 7 条（快照唯一改成同时抓 count=0 与 >1，另加 O3 的 `snapshot-total`）；
死代码删除，`WORKBENCH_STATUS_ID` 改为 import。
「可改」的 12 组只做了不改变行为的合并，其余留在原处 —— 它们不会静默分叉。

---

## 8 文档：13 处会把人带错

文档骨架写得足够好（为什么记账、账本是唯一数据源、404 而非 403、冲正记原提交日），
**但凡是要动手改代码的地方，文档会把人带错**。按后果排序：

| # | 位置 | 文档说 | 代码是 | 后果 |
|---|---|---|---|---|
| 1 | `29-audit.md:145` | 成功登录记 `detail.sessionId`，且写进验收 | 刻意不记（注释写了理由：`sessions.id` 就是 cookie 值） | **会诱导下一个人写出凭据泄漏** |
| 2 | `14a-segment-interval.md:40` | `MIN_SEGMENT_MS = 200`（标着「不可改动」） | 100 | 差一倍，照文档改会破坏 E4 的既有用例 |
| 3 | `22a-readonly-review.md:35` | `listSegments` 用 `requireOwnedTask` | `requireReadableTask` | 照文档改 → rejected 任务变可读，与同文档的验收项冲突 |
| 4 | `07-auth-api.md:96` | `DELETE /api/auth/logout` | 挂在 `/api/auth/login` 上，没有 logout 路由 | 真实 HTTP 请求 404 |
| 5 | `21-shortcuts.md:147` | `if (!enabled) return`（整组不绑） | 只让写键失效，空格与方向键照常 | 读代码会以为有 bug |
| 6 | `15-workbench-shell.md:66` | `status: 'claimed'`，submitted → 404 | `claimed \| submitted` + `rejectReason` | 照文档改会删掉只读回顾 |
| 7 | `16/17/19/22a` 的「不可改动」节 | Timeline 4 个 prop、`onCommit(draft, replacedIndex)`、`useSegmentDrag.ts` | 9 个 prop、`replacedId`、`use-segment-drag.ts` | 三篇互相矛盾，按任一篇写都撞墙 |
| 8 | `RULES.md:71` | ID 由 `newId()` 生成 | 不存在 | 见 §7 第 5 条 |
| 9 | `32-invariant-check.md:43` | pretest 含 `db:check`、不含 eslint | 相反 | 照文档配会漏掉 lint |
| 10 | `00-INDEX.md` | 4 个链接（`14-admin-tasks` / `26-stats-api` / `27-csv-export` / `29-audit-write`） | 实际文件名不同 | 点开 404 |
| 11 | `README.md:93` / `00-INDEX.md:10` | 726 例 | 731 | 数字过期 |
| 12 | `33-deliver.md` 全文 | 707 例 / 30 个功能点 | 731 / 33 | 计划稿没回填 |
| 13 | `00-INDEX.md:159` | 「E5 的 GET 复用 requireWritableTask……何时该修 E8」 | E8a 已修完 | 账本上一条已还的债还挂着 |

另有 `03-seed-data.md` 的「30 条审计」实际 32 条、`01-schema.md` 说 5 个索引实际 11 个、
`02-db-connection.md` 的示例全是虚构 API（`findTaskById`、`taskRepo.list`）。

**「未修的已知项」表的可信度很高**：15 条里 14 条核实为真，只有最后一行（E8）已作废。

---

## 9 依赖

`npm audit`：1 high + 1 moderate，均为 `postcss <= 8.5.22`（经 `next@15.5.4` 间接引入）。
构建期 CSS 处理，运行时不经手请求。官方修复路径是升 `next@16`（破坏性），本次不动。

`package.json` 无冗余依赖。手绘 SVG 柱图、手写 RFC 4180 CSV、手写 Range 解析
三处的不引依赖决定都有成本论据，保持现状。

---

## 10 结论

**代码本身可以交付，配置与文档不能。**

- 安全：租户隔离、SQL 参数化、凭据存储、错误脱敏、状态机原子性都经得起逐条核对。
  唯一阻断项是默认口令（§1）——它把其余所有隔离一起抹平。
- 质量：分层零违规，边界处理高于平均。22 组重复实现里 6 组会静默分叉，
  都是"改一处漏一处、漏了不会变红"的类型。
- 文档：骨架好，但 13 处会把人带错，其中 1 处（`sessionId`）会诱导写出安全缺陷。

**建议的修复顺序**（按风险/成本比）：

1. §1 默认口令按环境开关 + 补改密接口（半天）
2. §2 登录换异步 scrypt + 失败计数（1 小时）
3. §8 的 1–6 条文档（40 分钟，纯文档）
4. §7 的 1–5 条重复实现（半天，每处都要补测试）
5. §3 CSRF、§4 TOCTOU、§5 时长校验（按部署环境决定优先级）

**不建议现在做的**：拆 `Workbench.tsx`（617 行）。它 8 个写守卫全是并发窗口的修复，
而项目没有组件测试设施。拆 hook 会把"ref 与 state 同写"的隐式契约打散，风险大于收益。
