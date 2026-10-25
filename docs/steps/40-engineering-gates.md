# Q1–Q3 · 工程门禁：组件测试、浏览器门禁、检查器合并

**做什么**：把 REPORT 里剩下的三条工程性风险收口，不再靠「一次性脚本 + 人工记得跑」。

**依赖**：—

**预计**：4 小时

---

## Q1 组件测试设施（原风险 2）

**现状**：项目只有纯函数测试。撤销方向、并发守卫、焦点、快捷键这些「事件回调 → 状态 → 请求」
的接线，一条都不在门禁里。历史上 `record(segmentsRef.current)` 把撤销方向改反，510 例全绿。

**做法**：

- 引入 `jsdom` + `@testing-library/react` + `@testing-library/user-event`；
- `vitest.config.ts` 加 `@vitejs/plugin-react`（tsconfig 的 `jsx: preserve` 是给 Next 的，
  Vitest 侧不接管就报 `Unexpected JSX expression`）；
- 用例按文件加 `// @vitest-environment jsdom`，其余 40 多个纯函数测试仍跑 node，不变慢；
- `tests/workbench.dom.test.tsx`：真渲染 Workbench，fetch 用内存实现，断言「发了什么请求」；
- `tests/segment-list.dom.test.tsx`：真 DOM，断言 `aria-busy` 与 `document.activeElement`。

**覆盖的四条**：

| 行为 | 用例 | 变异（改坏 → 应红） |
|---|---|---|
| 撤销记操作前 | 删除后 Ctrl+Z 的 POST 体 | `record(segmentsRef.current)` → 1 例红 |
| label 回放 | POST 体里的 label | 已在 P1 覆盖 |
| 删除在途守卫 | 挂起 DELETE 时按 I/O | 去掉 `deletingIdRef` 判断 → 1 例红 |
| 快捷键开关 | 关闭后空格不播放 | 去掉 `characterShortcutsEnabled` → 1 例红 |
| 太短提示 | 50ms 按 O | 去掉 `onTooShort()` → 1 例红 |
| 焦点 / aria-busy | SegmentList 真 DOM | — |

**注意**：jsdom 不实现布局与媒体。拖拽的几何、`<video>` 的 206 仍只能靠浏览器层（Q2）。
组件测试补的是「接线」，不是替代浏览器。

---

## Q2 浏览器门禁（原风险 1）

**现状**：三段 Playwright 脚本放在 `.workbuddy/`（不进仓库），跑一次要手动起服务、手动 reset，
名字叫「一次性」名副其实。

**做法**：

- 脚本移入 `scripts/browser/`，路径全部参数化：`BASE_URL` / `DB_PATH` / `SHOT_DIR`；
- `browser-check.py` 登录改为「有演示按钮就点，没有就填表单」——默认构建没有演示区，
  这样同一份脚本在两种构建下都能跑；
- `scripts/browser/run.mjs`：**每个脚本一套独立种子库 + 独立服务**。
  共用库会让上一段的拖拽污染下一段的「初始 1 段」假设，第二遍必挂；
- `npm run test:browser` 跑三段；`npm run verify` = `npm test` + `test:browser`；
- `docs/ci/verify.yml`：push / PR 跑 `npm run verify`，CI 里装 Python Playwright + Chromium。
  不直接放 `.github/workflows/`：本机 PAT 缺 `workflow` scope，GitHub 拒绝写该目录。

**为什么不并进 `npm test`**：`npm test` 要能在没有服务、没有浏览器、没有构建的机器上跑
（reviewer 改一行纯函数不该等 90 秒）。全量门禁是 `verify`，CI 跑的就是它。

---

## Q3 两套检查器合并（原风险 3）

**现状**：`db:check` 与 `invariant:check` 各写了一份「快照 total_ms 自洽」与「有效快照唯一」。
注释写着「改口径要同时改两处」，实际是变异只喂给其中一套，另一套删掉也不会红。

**做法**：

- 从 `check-invariants.mjs` 删掉这两条（10 条 → 8 条），只保留结构与格式检查；
- `invariants.ts` 是唯一实现（`snapshot-total` / `snapshot-unique`）；
- `verify-checker.mjs` 的两个快照变异都指向 business 检查器；
- 结果：`db:check` 8/8、`invariant:check` 7/7、`verify-checker` 9/9。

---

## 产出

| 文件 | 说明 |
|---|---|
| `tests/workbench.dom.test.tsx` | 4 例：撤销方向、守卫、快捷键、太短 |
| `tests/segment-list.dom.test.tsx` | 3 例：aria-busy、焦点两分支 |
| `vitest.config.ts` | plugin-react、`.test.tsx` 纳入 |
| `scripts/browser/` | 三段脚本 + `run.mjs`（独立库/服务） |
| `docs/ci/verify.yml` | CI 配置（需 workflow scope 的 token 复制到 `.github/workflows/`） |
| `.githooks/pre-push` | push 前跑 `npm test`，`SKIP_VERIFY=1` 可跳过 |
| `scripts/check-invariants.mjs` / `verify-checker.mjs` | 去重 + 变异改指向 |

---

## 验收

- [x] `npm test`：867 例 / 46 文件，含 7 例 jsdom 组件测试
- [x] 变异：撤销方向、守卫、快捷键、太短各 1 例红（互不连带）
- [x] `npm run test:browser`：3/3 脚本（18 + 20 + 21 = 59 项）
- [x] `npm run db:check`：8/8；`npm run db:verify-checker`：9/9
- [x] CI 配置就位（本地无法验证 GitHub 侧执行，只验证了命令链）

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 组件测试不清理 localStorage | 上一个用例关掉的开关漏到下一个，出现「单跑绿、一起跑红」 |
| 三段脚本共用一个种子库 | 第二段起「初始 1 段」假设不成立，门禁永远红 |
| 把浏览器测试并进 `npm test` | 没装浏览器的机器全红；开发者开始跳过测试 |
| 只加组件测试就宣称浏览器风险关闭 | jsdom 没有布局与媒体，拖拽几何仍会漏 |
| 检查器去重只删一边、不改变异指向 | `verify-checker` 会报「未被捕获」，看似代码坏了 |

---

## 完成后

```bash
git add -A && git commit -m "chore(Q1-Q3): 组件测试、浏览器门禁、检查器合并"
```
