# A4 · 基础工具层

**做什么**：区间数学与领域错误体系，并接入 Vitest。

**依赖**：无（纯函数，不碰数据库）

**预计**：0.5 小时（实际含结对审查约 1 小时）

**这一步是第一次实践 XP 结对：Writer 实现，Reviewer 在看不到实现的情况下独立产出审查清单。**

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/interval.ts` | 半开区间数学，纯函数，零 import |
| `src/lib/errors.ts` | AppError 体系与 `toErrorResponse` |
| `tests/interval.test.ts` | 40 例 |
| `tests/errors.test.ts` | 26 例 |
| `vitest.config.ts` | `@/` → `./src` |

---

## 契约

```ts
type Interval = { startMs: number; endMs: number };   // 半开 [start, end)

MS_PER_SECOND = 1000
SNAP_STEP_MS = 100          // 时间轴吸附步长
MIN_SEGMENT_MS = 100        // 单片段最短时长（由 E3/E4 执行）

overlaps(a, b): boolean
findConflict(segments, candidate): Interval | null
normalize(a, b): Interval
totalDuration(segments): number
clamp(value, min, max): number
snapTo(ms, step = SNAP_STEP_MS): number
```

```ts
class AppError { code, status, message, details?, cause? }
  NotFoundError       404  NOT_FOUND
  ForbiddenError      403  FORBIDDEN
  ValidationError     400  VALIDATION
  StateConflictError  409  STATE_CONFLICT
  OverlapError        409  OVERLAP

toErrorResponse(err: unknown): { status: number; body: ErrorBody }
```

---

## 三个关键决策

### 1. 零长区间不重叠

```ts
if (a.startMs >= a.endMs || b.startMs >= b.endMs) return false;
```

数学上零长是空集，不该与任何区间相交。库里 `CHECK (end_ms > start_ms)` 让零长根本进不了触发器，
所以应用层特判不会与数据库结论相反。

但注意：**裸公式在零长上会判 true**——`{10,10}` 对 `{5,15}` 时 `10<15 && 10>5` 成立。
拖拽时手一抖没拖出长度，整个时间轴会红一片。

### 2. `snapTo` 必须拒绝非法入参

```ts
if (!Number.isFinite(ms) || !Number.isFinite(step) || step <= 0) {
  throw new RangeError(...);
}
```

**这不是防御性编程，是真实的数据污染路径**：

- `NaN`：`overlaps` 对 NaN 恒 `false`（NaN 比较全假），冲突预检静默放行；
  落库时 better-sqlite3 把 NaN 绑成 NULL，报 `NOT NULL constraint failed` —— 错误在现场之外爆炸
- `Infinity`：写进 `segments` 时 SQLite 当 REAL 存进 INTEGER 列，`CHECK (end_ms > start_ms)`、
  `CHECK (start_ms >= 0)` **全部通过**；随后 `SUM` 变成 `Infinity`，`ledger_entries` 的
  `CHECK (delta_ms > 0)` 也通过。**数据库四道约束全放行，账本里留下一个 Infinity。**

触发条件很现实：时间轴会从缩放级别推导 step（`step = 100 / zoom`），取到 0 或小数是迟早的事。

### 3. `toErrorResponse` 连 status 一起返回

```ts
return { status: err.status, body: {...} };
```

如果只返回 body，`err instanceof AppError ? err.status : 500` 就要在每个 route handler 里写一遍。
11 个 handler 漏一个，就会出现「HTTP 200 + body `{ok:false}`」——前端 `res.ok` 为真，走了成功分支。
**这个决定必须在写第一个 handler 之前定下来，否则会被复制 11 次。**

---

## 结对审查的收获

Reviewer 在**看不到实现**的情况下独立写了 12 条验收清单、39 条边界用例、12 条陷阱。
对照实际代码后，它抓到的真问题：

| 问题 | 严重度 | 说明 |
|---|---|---|
| `snapTo` 无入参守卫 | **必修** | 实测 Infinity 能穿透四道 CHECK 写进账本 |
| `toErrorBody` 不返回 status | 建议 | status 决策会散到每个 handler |
| `findConflict` 只返回第一个 | 建议 | E4 的 409 里没有冲突信息，用户不知道撞了谁 |
| `normalize` 注释写 `start < end` 但代码是 `<=` | 建议 | 违反 RULES「注释与代码不符」 |
| `MIN_SEGMENT_MS` 无调用点 | 建议 | 容易让人误以为下限已经有人管 |

**最有价值的一条是它证明了测试的盲区**：Reviewer 自己写了一个「合并重叠」版本的 `totalDuration`，
喂进当时的用例 `[{0,1000},{5000,6500}]` 得到 2500，与逐段求和完全相同——**原测试对这个变异没有检出能力**。
补上 `[{0,1000},{500,1500}] → 2000` 之后才有牙。

---

## 变异验证结果

| 变异 | 期望 | 实际 |
|---|---|---|
| `snapTo` 删掉守卫 | 5 条非法入参用例变红 | 5 failed ✓ |
| `totalDuration` 改首尾差 | 跳间隙与重叠两条变红 | 2 failed ✓ |
| `overlaps` 的 `<` 改 `<=` | 首尾相接变红 | 已由 Writer 验证 ✓ |

---

## 验收

- [x] `npm test` 66 例全绿
- [x] `npx tsc --noEmit` 通过
- [x] 三个变异全部按预期变红并已还原
- [x] 每个文件有文件头注释，关键判据旁写了「为什么」
- [x] `interval.ts` 零 import（前端可直接复用，不会把 server 错误体系拖进 bundle）

---

## 留下的一条待办

`findConflict` 目前只返回第一个冲突。E3 拖拽预览够用，但 **E6 冲突实时反馈需要标红全部冲突块**，
E4 保存失败时前端也需要知道撞了哪几段。届时加 `findConflicts(segments, candidate): Interval[]`，
`findConflict` 保留为 `[0] ?? null` 的薄封装。

已记录在 `docs/steps/00-INDEX.md` 的 E6。
