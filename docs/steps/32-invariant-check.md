# I2 · 不变量检查器与变异验证

**做什么**：把 I1 的检查器接到两处 —— 真实库（脚本）与门禁（`npm test`），
并证明它真的会报。

**依赖**：I1

**预计**：1 小时

---

## 检查器最怕的不是漏报，是恒真

一个永远返回 `[]` 的 `findViolations` 会让所有测试通过，而且没人看得出来。

唯一能证明它有效的办法：**故意把数据弄坏一处，它必须报。**

这就是 I1 的测试里那批「直插脏数据」用例的职责。但那些用例验的是**函数**，
I2 要验的是**接到真实库之后的检查器**。

---

## 两处接入

### 1. 脚本：`node scripts/invariant-check.mjs`

对 `data/app.db` 跑一遍，输出：

```
[invariant] 检查 12 个任务、34 条账目、9 条快照
[invariant] 0 项违反
```

有违反时打印前十条并 `exit 1`。

**为什么不放进 `npm test`**：单测用的是 `:memory:` 库，
而种子库与真实使用过的库里可能有历史数据。两者的检查同样重要，
但混在一起会让 `npm test` 依赖磁盘状态。

### 2. 门禁：`npm test` 的 pretest 里加一条

```
"pretest": "npm run audit:rules && npm run audit:sql && npm run db:check && npm run invariant:check"
```

`invariant:check` = `node scripts/setup.mjs --reset --quiet && node scripts/invariant-check.mjs`？

**不行** —— 那会把开发者的库反复重置。

正确的做法：`invariant:check` 对一个**临时库**跑：

```
node scripts/invariant-check.mjs --temp
```

`--temp` 表示：建一个内存库、灌种子、跑完整业务链路、检查。
相当于「种子数据本身是否自洽」+「业务流程是否破坏自洽」。

这条能进 pretest，因为它是确定性的、不依赖磁盘状态。

---

## 变异验证（这一步不能省）

对检查器本身做三次变异，每次都要有测试或脚本变红：

| 变异 | 应变红 |
|---|---|
| `findViolations` 直接 `return []` | I1 的全部「直插脏数据」用例 |
| 去掉 `ledger-non-negative` 这条规则 | 只那条用例红，其余绿 |
| 把 `subject` 改成 `''` | 断言 subject 的用例红 |

**第二条是关键的**：它证明每条规则都是独立生效的，不是「有一条能报就行」。

---

## 产出

| 文件 | 说明 |
|---|---|
| `scripts/invariant-check.mjs` | 支持 `--temp` 与默认（读 `data/app.db`） |
| `package.json` | `invariant:check` 脚本 + 接入 pretest |

---

## 验收

**自动**

- [ ] `npm run invariant:check` 在种子库上返回 0 项违反
- [ ] `npm run invariant:check -- --temp` 在临时库上返回 0 项违反
- [ ] 有违反时退出码为 1（用一个临时造脏的库验）
- [ ] 三条变异各自变红（上面那张表）
- [ ] `npm test` 仍全绿

**手工**

- [ ] 手动往 `data/app.db` 插一条 `delta_ms = -999999` 的账目 →
      `npm run invariant:check` 报 `ledger-non-negative` 并 exit 1

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 检查器恒真 | 所有测试绿，没人知道它没工作 |
| pretest 里重置开发者的库 | 丢数据 |
| 只验「有违反会报」不验「没违反不报」 | 恒抛的检查器也能过 |
| 把真实库检查放进 `npm test` | 依赖磁盘状态，CI 上必红 |

---

## 完成后

```bash
git add -A && git commit -m "test(I2): 不变量检查器接入脚本与门禁，三次变异自证"
```

**下一步**：I3 ESLint、README、report 收口。
