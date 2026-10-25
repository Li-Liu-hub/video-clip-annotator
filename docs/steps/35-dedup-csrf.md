# O2 · 重复实现收口与 CSRF

**做什么**：把扫描里 6 组「改一处漏一处且不会变红」的重复实现合并，并补 Origin 校验。

**依赖**：全部

**预计**：4 小时

---

## 为什么这些必须合

它们不是风格问题。每一组的共同点是：**改一处、漏一处，没有编译错误、没有测试变红，
表现是运行时的静默分叉。**

已经发生过的事：`reject_reason` 两处判断只改了一处，导致「保留」只在库里有、界面看不到。

---

## 六组，按风险排序

### 1 归属+状态门禁（三份 → 一份）

| 位置 | 现状 |
|---|---|
| `segment-service.ts:98` | `requireOwnedTask`：归属，不判状态 |
| `segment-service.ts:109` | `requireReadableTask`：归属 + 状态 ∈ {claimed, submitted} |
| `workbench-service.ts:48-50` | 逐行重写了 `requireReadableTask` 的两步 |
| `review-service.ts:113` | 内联了 `requireOwnedTask` 的判定 |

**合并为**：`segment-service` 导出两个函数，其余三处 import。

```
requireOwnedTask(db, actor, taskId)    → claimed_by === actor.id
requireReadableTask(db, actor, taskId) → requireOwnedTask + status ∈ {claimed, submitted}
requireWritableTask(db, actor, taskId) → requireOwnedTask + status === 'claimed'
```

**为什么放 `segment-service` 而不是新建模块**：它已经导出 `requireWritableTask`，
三个函数是一组，拆开反而增加跳转成本。

**风险**：`workbench-service` import `segment-service` 会不会成环？
`segment-service` 不 import `workbench-service`，无环。要验证。

### 2 两套不变量检查器（4 条规则重叠，各写一遍 SQL）

| 位置 | 现状 |
|---|---|
| `scripts/check-invariants.mjs` | 14 条手写 SQL（跨租户、重叠、角色、日期格式、符号） |
| `src/lib/invariants.ts` | 6 条（账本守恒、非负、快照唯一、同源、状态配对、租户一致） |

**合并方向**：以 `invariants.ts` 为唯一业务不变量源。
旧套里 schema 级、新套没有的 8 条迁进 `invariant-repo.ts`，`db:check` 改为委托同一实现。

**但有一个前提**：旧套的 14 条里有 8 条是**结构检查**（区间不重叠、租户唯一标注员、
日期格式、kind 与符号对应），它们不是「业务不变量」，而是「schema 该保证但 SQLite 表达不了」的。

**所以不合并这 8 条**，只合并重叠的 4 条：

```
净额与快照一致、净额非负   → 已在 invariants.ts，删旧套
快照唯一                  → 已在 invariants.ts，删旧套
跨表租户一致              → 已在 invariants.ts，删旧套
```

`db:check` 保留结构检查（Q3 后 8 条），新增一行「业务不变量见 invariant:check」。
**两套都有存在理由，但重叠的条目只能有一份 —— Q3 已把最后两条快照规则也删掉。**

`verify-checker.mjs` 的变异验证要指向**新的** `invariants.ts`（它现在只验旧套）。

### 3 上传上限与 MIME 白名单（两份）

```
video-service.ts:25  MAX_VIDEO_BYTES = 200 * 1024 * 1024
video-upload.ts:8    MAX_UPLOAD_BYTES = 200 * 1024 * 1024
```

**合并**：新建 `src/lib/video-limits.ts`（纯常量，不 import `node:fs`，两端都能引）。
MIME 白名单同理（`SUPPORTED_MIME_EXTENSIONS` / `ACCEPTED_MIME`）。

这是项目已有的正确范式（`task-limits.ts` / `review-limits.ts`），照抄。

### 4 `newId()` 不存在，6 处各写

RULES 写「ID：16 位十六进制，`newId()` 生成」，但函数不存在，
6 个 service 各写 `randomBytes(8).toString('hex')`。

**合并**：`src/lib/db/id.ts` 导出 `newId()`，6 处替换。
`auth-service` 的会话 id 是 48 位，**不换**（语义不同，且改了会让所有会话失效）。

### 5 `WORKBENCH_STATUS_ID` 导出但 0 引用

`SubmitBar.tsx` 导出它，`Workbench.tsx` 硬编码同一个字符串。

**合并**：`Workbench` import 它。一行。

### 6 死代码

`time.ts` 的 `formatHours` / `recentDates`，全仓零引用。
`DailyChart.tsx` 的 `BarSlot` 与 `chart-bars.BarSlot` 重复。
`DateRange` 两份（`ledger-repo` 与 `stats-range`）。

**删除前者，后两组保留一份。**

---

## CSRF：Origin 校验

**位置**：所有写接口（POST / DELETE / PATCH）。

**做法**：`lib/server/require-same-origin.ts`

```ts
/**
 * 写接口的同源校验。
 *
 * SameSite=Lax 挡不住同主机不同端口的服务（内网常见：Wiki、Jenkins、老系统），
 * 也挡不住同父域子域。这些场景下浏览器会带上 cookie 发简单请求。
 *
 * 无 Origin 头时放行：老浏览器与部分代理不发送它，
 * 拒绝会让正常用户用不了 —— 代价是这条防线在那类客户端上不存在。
 * 这是明确的取舍，不是遗漏。
 */
export function requireSameOrigin(request: Request): void;
```

规则：

1. 有 `Origin` → 必须与请求的 `host` 同源（协议 + 主机 + 端口）
2. 无 `Origin` 但有 `Referer` → 检查 Referer 的 origin
3. 两者都没有 → 放行（见注释里的取舍）
4. 不同源 → `ForbiddenError`

**接入点**：12 个写 handler。放在 `requireApiXxx` 之后、业务之前。

**不做的**：CSRF token。对于这个规模（内网、无第三方嵌入），
Origin 校验覆盖了绝大多数场景，token 会引入状态管理成本。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/services/segment-service.ts` | 三个门禁函数统一 |
| `src/lib/services/workbench-service.ts` / `review-service.ts` | 改用统一门禁 |
| `src/lib/video-limits.ts` | 上传限制常量 |
| `src/lib/db/id.ts` | `newId()` |
| `src/lib/server/require-same-origin.ts` | Origin 校验 |
| 6 个 service + `video-upload.ts` | 改用常量与 `newId` |
| `scripts/check-invariants.mjs` / `verify-checker.mjs` | 删重叠 4 条、指向新套 |
| `src/lib/time.ts` / `DailyChart.tsx` | 删死代码与重复类型 |
| `tests/same-origin.test.ts` / `tests/id.test.ts` | 新增 |

---

## 验收

**自动**

- [ ] `requireOwnedTask` / `requireReadableTask` / `requireWritableTask` 三个函数**只有一份实现**
      （`grep -c "claimed_by !== actor.id" src/lib/services/` 为 1）
- [ ] `workbench-service` 与 `review-service` 不再有内联归属判定
- [ ] **现有 782 例全绿**（合并后行为必须完全不变 —— 这是唯一能证明「重构没改语义」的东西）
- [ ] `newId()` 生成 16 位十六进制，6 处替换后仍能建出任务/片段/快照
- [ ] `MAX_VIDEO_BYTES` 与 `MAX_UPLOAD_BYTES` 只在一处定义
- [ ] `db:check` 与 `invariant:check` 在**同一份脏库**上结论一致（重叠 4 条）
- [ ] `verify-checker` 的变异指向新套（删一条规则 → 它的用例红）
- [ ] Origin 校验：同源放行、跨源 403、无 Origin 放行
- [ ] `formatHours` / `recentDates` 全仓 0 命中
- [ ] `tsc` / `eslint` / `npm test` / `build` 全过

**手工**

- [ ] 工作台、片段增删、提交、退回、重新打开 —— 五条路径行为不变

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 合并门禁时把 `status` 判定放宽 | rejected 任务变可读，与 E8a 冲突 |
| 合并检查器时把结构检查也删掉 | 区间重叠、租户唯一性失去守卫 |
| `newId()` 统一后会话 id 也被改 | 所有会话失效（48 位 vs 16 位） |
| Origin 校验拒绝无 Origin 的请求 | 部分客户端与代理下用不了 |
| 只在部分 handler 接入 | 漏的那个成为绕过口 |
| 重构时顺手「优化」了语义 | 782 例全绿不代表没改 —— 要看 diff 里有没有非结构性改动 |

---

## 完成后

```bash
git add -A && git commit -m "refactor(O2): 六组重复实现收口，写接口补 Origin 校验"
```

**下一步**：O3 TOCTOU 与视频时长校验。
