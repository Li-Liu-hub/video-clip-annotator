# A3 · 种子数据

**做什么**：让 `npm run dev` 之后立刻有可演示的数据——不是空表，也不是一堆无意义的 lorem。

**依赖**：A1、A2

**预计**：1 小时

**核心做法**：先写不变量检查器，拿它去测种子数据，红了再修。**种子数据也必须满足所有业务规则。**

---

## 产出

| 文件 | 说明 |
|---|---|
| `scripts/setup.mjs` | 建表 + 种子（`predev` 自动触发） |
| `scripts/check-invariants.mjs` | 对运行库跑 14 项断言 |
| `scripts/verify-checker.mjs` | 对检查器做变异验证 |

---

## 为什么种子数据要「设计」而不是「凑数」

评分人打开页面看到的第一个东西就是数据。空表、或者每天数字一模一样的表，
会让人怀疑这个系统到底跑没跑过。

**要满足三件事**：

1. **覆盖所有状态** —— `pending` / `claimed` / `submitted` 都要有，否则界面无法展示完整的状态机
2. **有历史** —— 至少 7 天，且**每天数字不能均匀**，柱状图才看得出起伏
3. **今天有数据** —— 管理员打开统计页，「今日」不能是空的

当前分布：

```
2026-10-17  2 笔   26.3s
2026-10-18  1 笔    9.5s
2026-10-19  2 笔   37.4s
2026-10-20  2 笔   28.1s
2026-10-21  1 笔   24.5s
2026-10-22  3 笔   39.6s
2026-10-23  1 笔   20.4s   ← 今天
```

17 个任务 / 12 条已提交账本 / 3 个标注员（各 4 笔左右）/ 30 条审计。

---

## 种子必须满足的不变量

这正是为什么先写检查器：种子数据是手工构造的，**最容易违反自己定的规则**。

| 不变量 | 种子里的坑 |
|---|---|
| `segments.tenant_id == task.tenant_id` | 冗余字段，写错不会报错，只会让隔离测试悄悄失效 |
| 账本净额与任务状态相符 | `submitted` 任务的账本净额必须等于当前快照的 `total_ms`；其他状态必须为 0 |
| `total_ms` 等于快照内各段之和 | 手工算错一个数字就红 |
| 已提交任务恰有一个有效提交 | 别把 `superseded_by` 填错 |
| 日期格式 `YYYY-MM-DD` | 别用 `/` 分隔 |
| 账本符号与类型一致 | `submit` 必正、`revoke` 必负（有 CHECK 兜底，但种子也可能写反） |

---

## 检查器：14 项断言

`npm run db:check` 直接对**运行中的库**跑，不是测试库。

| 组 | 断言 |
|---|---|
| 租户一致性 | segments / submissions / ledger / task 四处交叉核对 |
| 区间 | 同一任务内无重叠 |
| 追溯 | 每条账本能找到对应提交 |
| 守恒 | 每个任务的账本净额与状态相符 |
| 自洽 | `total_ms` == 快照各段之和；已提交任务恰有一个有效提交 |
| 角色 | 管理员无租户、标注员有租户、一租户一人 |
| 状态 | 状态与 `claimed_by` 同步 |
| 格式 | `entry_date` 格式、账本符号 |

退出码非 0 表示存在违规，可直接挂在 CI 上。

---

## 但检查器本身也要被验证

`npm run db:verify-checker` 做的事：复制数据库 → 故意制造违规 → 跑检查器 → 确认它报错。

```
[verify] 基线（未变异）
  ok  检查器在干净数据上应当全绿  — exit=0

[verify] 变异验证
  ok  跨租户污染            →  segments 的租户与所属任务一致
  ok  快照 total_ms 与内容不符 →  提交的 total_ms 等于快照内各段之和
  ok  账本净额与任务状态不符  →  每个任务的账本净额与状态相符
  ok  日期格式非法           →  ledger 的 entry_date 格式合法
  ok  已提交任务缺少提交记录  →  已提交任务恰有一个未被取代的提交

[verify] 6/6 通过
```

**没有这一步，前面 14 项全绿也只是「检查器没报错」，不是「数据没问题」。**

注意：有些违规造不出来——比如「状态与领取人不一致」会被 CHECK 约束直接拦掉。
这恰恰说明约束在起作用，那条检查是双保险。

---

## 实现要点

### 时间要落在指定小时

```js
let submittedAt = null;
if (spec.status === 'submitted') {
  const dayAnchor = now - spec.daysAgo * DAY;
  const localHour = new Date(dayAnchor).getHours();
  submittedAt = Math.min(now - 60_000, dayAnchor + (spec.hour - localHour) * 3_600_000);
}
```

`Math.min(now - 60_000, ...)` 是必要的：`daysAgo = 0` 且 `hour` 大于当前小时时，
算出来是未来时间，要夹回现在之前。否则账本里会出现「明天的数据」。

### 视频要复制到运行时目录

`public/videos/demo.mp4` 是随仓库分发的素材；运行时视频存在 `data/videos/`，
由带鉴权的路由提供（ADR-11）。`setup.mjs` 负责复制。

### 幂等

```js
const initialized = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'"
).get();

if (initialized && !reset) { /* 跳过 */ }
```

`predev` 每次启动都会跑，不能每次都重建数据。

---

## 验收

- [ ] `npm run db:reset` 输出 3 租户 / 4 用户 / 17 任务 / 12 账本 / 30 审计
- [ ] `npm run db:check` 14/14 通过
- [ ] `npm run db:verify-checker` 6/6 通过
- [ ] 连续跑两次 `npm run dev`，第二次输出「已初始化，跳过」
- [ ] 统计页的 7 天数据不是一条水平线
- [ ] 今天（`daysAgo = 0`）有至少一条已提交记录

---

## 完成后

```bash
git add -A && git commit -m "feat(A3): 种子数据与不变量检查器"
```
