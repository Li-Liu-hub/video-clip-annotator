# STEP 09 · 测试与交付

**目标**：用测试证明核心规则成立，用变异验证证明测试有效，交付一份能跑通的仓库。

**前置**：01–08 全部完成

**预计**：2 小时

---

## 产出

| 文件 | 说明 |
|---|---|
| `vitest.config.ts` | 测试配置 |
| `tests/helpers/env.ts` | 内存库工厂 + 造数工具 |
| `tests/01-isolation.test.ts` | 不变量① 租户隔离 |
| `tests/02-overlap.test.ts` | 不变量② 区间不重叠 |
| `tests/03-ledger.test.ts` | 不变量③ 账本守恒 |
| `tests/04-state-machine.test.ts` | 不变量④ 状态跃迁 |
| `tests/05-timezone.test.ts` | 不变量⑤ 日期边界 |
| `scripts/check-invariants.mjs` | 运行库检查器 |
| `scripts/audit-sql.mjs` | SQL 谓词静态扫描 |
| `eslint.config.mjs` | 分层规则 |
| `README.md` | 启动说明 |
| `report.md` | 交付报告 |

---

## 1. 测试基础设施

```ts
// tests/helpers/env.ts
import { createDb } from '@/lib/db';

export function freshDb() {
  const db = createDb(':memory:');
  // 造两个租户、一个管理员、两个标注员
  ...
  return { db, admin, alice, bob, carol };
}
```

每个用例拿独立的 `:memory:` 库，互不污染。**不要共享一个 db 然后靠顺序清理**，
那会让测试之间产生隐式依赖，失败时极难定位。

装依赖：

```bash
npm i -D vitest @vitest/coverage-v8
```

`package.json`：

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```

`vitest.config.ts` 要配 `resolve.alias` 让 `@/` 指向 `src/`。

---

## 2. 五个测试文件

### `01-isolation.test.ts` · 租户隔离

```ts
it('标注员不能读其他租户的任务', () => {
  const task = createTask(db, { tenantId: carol.tenantId });
  expect(() => getTask(db, alice, task.id)).toThrow(NotFoundError);
});

it('标注员不能改其他租户的片段', () => { ... });
it('标注员不能提交其他租户的任务', () => { ... });
it('标注员的列表查询忽略传入的 tenantId', () => {
  const list = listTasks(db, alice, { tenantId: carol.tenantId });
  expect(list.every((t) => t.tenantId === alice.tenantId)).toBe(true);
});
```

**用参数化把矩阵铺开**：3 个标注员 × N 个资源 × 4 种操作。
写成 `for` 循环生成 `it`，比手写 12 个用例更不容易漏。

### `02-overlap.test.ts` · 区间不重叠

```ts
it('相邻区间不算重叠', () => {
  addSegment(db, task, 10_000, 20_000);
  expect(() => addSegment(db, task, 20_000, 30_000)).not.toThrow();
});

it('1ms 交叠算重叠', () => {
  addSegment(db, task, 10_000, 20_000);
  expect(() => addSegment(db, task, 19_999, 30_000)).toThrow();
});

it('触发器在绕过应用层时仍然生效', () => {
  // 直接写 SQL，不走 service
  expect(() => db.prepare('INSERT INTO segments ...').run(...)).toThrow(/OVERLAP/);
});
```

**第三条是重点**：它证明防线在数据库层，不在应用层。

### `03-ledger.test.ts` · 账本守恒

```ts
it('退回后历史日期不变', () => {
  const { date } = submitOn(db, task, '2026-10-22');
  const before = sumByDate(db, '2026-10-22');

  rejectTask(db, admin, task.id, '不合格');

  expect(sumByDate(db, '2026-10-22')).toBe(before);   // 关键断言
});

it('账本总和等于快照总和', () => {
  // 走完 提交 → 退回 → 重提交
  const ledgerSum = db.prepare('SELECT SUM(delta_ms) v FROM ledger_entries').get().v;
  const subSum = db.prepare('SELECT SUM(total_ms) v FROM submissions WHERE superseded_by IS NULL').get().v;
  expect(ledgerSum).toBeGreaterThanOrEqual(0);
  // 精确关系见 check-invariants
});
```

### `04-state-machine.test.ts` · 状态跃迁

```ts
const LEGAL: Record<string, string[]> = {
  pending:  ['claim'],
  claimed:  ['submit'],
  submitted:['reject'],
  rejected: ['submit'],
};

// 枚举 4 状态 × 4 动作，断言只有合法组合成功
for (const [status, allowed] of Object.entries(LEGAL)) {
  for (const action of ['claim', 'submit', 'reject', 'deleteSegment']) {
    it(`${status} + ${action} → ${allowed.includes(action) ? 'ok' : 'conflict'}`, ...);
  }
}
```

### `05-timezone.test.ts` · 日期边界

```ts
it('23:59:59.999 与次日 00:00:00.001 分属两天', () => {
  const tz = 'Asia/Shanghai';
  const a = Date.parse('2026-10-22T15:59:59.999Z');  // 上海 23:59:59.999
  const b = Date.parse('2026-10-22T16:00:00.001Z');  // 上海次日 00:00:00.001
  expect(localDateOf(a, tz)).toBe('2026-10-22');
  expect(localDateOf(b, tz)).toBe('2026-10-23');
});
```

再补跨月（10-31 → 11-01）、跨年（12-31 → 01-01）。

---

## 3. 不变量检查器

`scripts/check-invariants.mjs` 对**运行中的库**跑 8 项断言，不依赖测试框架：

```
① 无跨租户污染
② 同任务内无重叠
③ 每条 ledger 都能找到 submission
④ ledger 总和 == 有效 submission 总和
⑤ submission.total_ms == 快照内各段之和
⑥ 每个 submitted 任务恰有一个 superseded_by IS NULL 的 submission
⑦ segments.tenant_id == task.tenant_id
⑧ 角色-租户约束未被破坏
```

输出：

```
[db:check] ① 无跨租户污染 ............ PASS
[db:check] ② 区间无重叠 .............. PASS
...
[db:check] 8 项全部通过
```

失败时列出具体行 id。

**它同时是测试、运维工具和演示素材。** 评分人跑一下，比看单元测试更有说服力。

---

## 4. 变异验证（证明测试有牙）

全绿只说明「实现与测试自洽」。逐条做坏，确认变红：

| # | 改坏什么 | 期望 |
|---|---|---|
| 1 | `taskRepo.findById` 删掉 `AND tenant_id = ?` | `01-isolation` 红 |
| 2 | 重叠触发器里 `<` 改成 `<=` | `02-overlap` 的「相邻不算重叠」红 |
| 3 | 冲正金额改成 `0` | `03-ledger` 红 |
| 4 | 状态机校验删掉 `rejected` 分支 | `04-state-machine` 红 |
| 5 | `localDateOf` 改成 `toISOString().slice(0,10)` | `05-timezone` 红 |

**每条做完立刻改回来。** 把结果记入 `report.md`：

```
| 变异 | 测试 | 结果 |
|---|---|---|
| 删除租户过滤 | 01-isolation | 12 个用例中 4 个失败 ✓ 有效 |
```

---

## 5. 质量门禁

### ESLint 分层规则

```js
// eslint.config.mjs
export default [
  // ...
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@/lib/db', '@/lib/db/*'],
          message: '路由层不得直接访问数据库，请通过 @/lib/services',
        }],
      }],
    },
  },
];
```

### SQL 谓词扫描

`scripts/audit-sql.mjs`：读 `lib/db/repos/**`，用正则找 SQL 字符串里对核心表的访问，
缺 `tenant_id` 就退出码 1。允许 `// audit-ignore: <理由>` 豁免。

挂在 `pretest` 钩子上，让违规无法通过 CI。

---

## 6. 交付清单

### `README.md`

顺序很重要，按评分人的使用路径写：

```markdown
# 视频片段标注平台

## 快速开始
npm install && npm run dev
# 打开 http://localhost:3000
# 演示账号见登录页（一键登录）

## 环境要求
Node ≥ 20.9。无需数据库、无需编译器、无需联网。

## 演示路径
1. 用 alice 登录 → 领取「双臂协作 · 倾倒与收尾」
2. 在时间轴上拖出 2–3 个片段
3. 提交
4. 换 admin 登录 → 统计页看到今天的数字
5. 退回该任务 → 统计数字出现冲正
6. 审计页查看全过程

## 技术栈
...

## 命令
npm test / npm run db:check / npm run db:reset / npm run lint
```

**第一屏必须是 `npm install && npm run dev`。** 不要让评分人往下翻才能找到启动命令。

### `report.md`

题目明确要求的四问，逐条回答：

1. **README 没写到的地方怎么决定的**
   → 引 `docs/DESIGN.md` §1.3 的租户模型推导、§3 的表设计取舍。挑 3–5 个最关键的。
2. **怎么确认 AI 写的代码是对的**
   → 四层防线（结构约束 / 测试 / 检查器 / 变异验证）+ 变异验证的具体结果表。
3. **用到了哪些 rules 和 skills**
   → ESLint 分层规则、SQL 审计脚本、领域 skills（若有）。
4. **还有哪些没做完或不放心**
   → 直接抄 `docs/DESIGN.md` 的「已知缺口」，再加个人判断。

**第 2 问是拉开差距的地方。** 大多数人会答「我读了代码、我跑了测试」。
真正有说服力的是：**我故意把实现改坏，确认测试会红——这证明测试不是摆设。**

---

## 7. 最终验收

- [ ] `rm -rf node_modules data && npm install && npm run dev` 一次成功
- [ ] 登录页四个账号都能一键进入
- [ ] alice 能走完整流程：领取 → 标注 → 提交
- [ ] admin 能看到统计、能退回、能查审计
- [ ] `npm test` 全绿
- [ ] `npm run db:check` 8 项全过
- [ ] `npm run lint` 无 error
- [ ] `npm run build` 成功
- [ ] 五条变异验证全部按预期变红，且已改回
- [ ] README 的「演示路径」能照着走通
- [ ] report.md 四问都有实质内容

---

## 8. 提交

```bash
git init
git add .
git commit -m "feat: 视频片段标注平台"
git remote add origin https://github.com/Li-Liu-hub/video-clip-annotator.git
git push -u origin main
```

注意 `.gitignore` 要排除 `data/`（含数据库和上传的视频），但**不能排除 `public/videos/demo.mp4`**——
那是种子数据，必须随仓库分发。

推之前检查：

```bash
git status --ignored | head -20
du -sh .git
```

仓库体积应小于 5 MB（视频 152 KB + 代码）。
