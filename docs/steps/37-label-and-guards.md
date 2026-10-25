# P1–P3 · 收尾三项：标签保真、并发守卫验证、描边层级

**做什么**：把 INDEX 里「留到以后」的三条真正修掉，不再挂在未修项表里。

**依赖**：E3、E8、O1c

**预计**：3 小时

---

## 1 撤销 / 拖动丢 label

**现状**：历史栈只存 `{startMs, endMs}`（22-undo-redo 的契约），
`upsertSegment` 替换时固定写 `label: null`。两条路径各有一次丢失：

| 路径 | 现在的行为 |
|---|---|
| 拖动 / 调整已存在的片段 | 先删后插，新行 label 为 null → 种子里的「有效操作」拖一下就没了 |
| 删除后 Ctrl+Z | 重建时只知道区间 → 时间对、标签没了 |

**修法**：

1. `lib/history` 引入 `HistoryInterval = Interval & { label: string | null }`。
   匹配仍只比两端（片段不重叠，区间即唯一键），但**创建时把 label 一起带回**。
   `lib/interval` 的 `Interval` 保持纯几何，不塞 label —— 拖拽与重叠判定不该关心展示字段。
2. `upsertSegment` 的 label 语义三态：
   - 省略（undefined）→ 替换时继承被替换项，新建时为 null；
   - 字符串 → 落库（trim、空串归一成 null、上限 80 字符）；
   - 显式 null → 清空。
   三态必须区分：拖动走「省略」（继承），撤销走「字符串/null」（回放历史），
   两者混成一个 `??` 会把「显式清空」变成「继承」。
3. POST 体接受可选 `label`。`lib/segment-payload` 增加 `upsertPayloadOf(interval)`，
   返回**label 必填**的载荷类型 —— 撤销的 POST 少传 label 会直接编译失败，
   而不是等浏览器里发现标签没了。
4. API 只做类型收窄，长度与空串归一放 service：一处实现，路由与服务共用。

**为什么改历史栈而不是只在替换时继承**：只继承能修拖动，修不了「删除后撤销」——
那时被替换项已经不存在，没有东西可继承。标签必须由历史自己带回来。

---

## 2 并发删除守卫：从「人工」变成「可重复复现」

**现状**：`commitSegment` 的入口读 `deletingIdRef`，删除在途时拒绝提交并提示。
逻辑在组件里，没有自动化；INDEX 标为「人工，需要两只指针」。

**不需要两只指针**：把 DELETE 的响应人为拖住，再用同一只鼠标拖另一段 ——
在途窗口被拉长到 2 秒，单指针就能稳定命中。

**做法**（浏览器门禁脚本 `scripts/browser/browser-polish.py`，`npm run test:browser` 每次跑）：

1. 路由拦截 `DELETE /api/tasks/*/segments/*`，`await 2s` 后再放行；
2. 点第一段的删除（DELETE 挂起，`deletingId` 已置位）；
3. 2 秒内拖第二段并松手；
4. 断言：窗口内 `POST /segments` 次数为 0、DELETE 次数为 1、界面出现「正在删除片段」；
5. 等删除完成后重试拖拽 → POST 必须为 1（证明第 4 步不是「拖拽坏了」）。

若第 4 步出现 POST，说明守卫有洞，先修再继续。

---

## 3 相邻色块盖掉选中描边

**现状**：色块是绝对定位的兄弟节点，选中环用 `ring-2`（box-shadow）。
两段首尾相接时，后绘制的兄弟把前一段的右半边环盖掉。

**修法**：选中（或有冲突）的块 `z-10`，草案 `z-20`。
只改层级，不改颜色与尺寸 —— 描边本身没问题，被盖住是绘制顺序问题。

**验证**：Playwright 造两段相接的片段，选中前一段，读计算样式：
选中块 `z-index = 10`、兄弟 `auto`；并截图供人眼确认。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/history.ts` | `HistoryInterval` 带 label，快照与 diff 保留 |
| `src/lib/segment-payload.ts` | `upsertPayloadOf`，label 必填 |
| `src/lib/services/segment-service.ts` | label 三态 + 校验 |
| `src/app/api/tasks/[id]/segments/route.ts` | 接受可选 label |
| `src/app/tasks/[id]/work/use-history.ts` | current 带 label，POST 用统一载荷 |
| `src/app/tasks/[id]/work/Timeline.tsx` | 选中/冲突 z-10，草案 z-20 |
| `tests/history.test.ts` / `segment-api.test.ts` / `segment-payload.test.ts` | 新增用例 |

---

## 验收

**自动**

- [x] 替换时不传 label → 新行继承旧 label
- [x] 替换时传 `label: null` → 新行 label 为 null（显式清空）
- [x] 新建带 label → 落库；label 超 80 字符 → 400；非字符串 → 400
- [x] `diffIntervals` 的 toCreate 带 label；删除后撤销的 restore 带 label
- [x] `upsertPayloadOf` 产出含 label 的载荷（漏传会编译失败）
- [x] 全量 850 例全绿（P1 新增 18 例；O4 之后为 853）

**浏览器**（`scripts/browser/browser-polish.py`，20/20）

- [x] 删除带 label 的片段 → Ctrl+Z → 列表重新出现「有效操作」
- [x] 拖动带 label 的片段 → 松手后 label 仍在
- [x] 删除在途时拖另一段 → POST 0 次、DELETE 1 次、出现提示；完成后重试 → POST 1 次
- [x] 相邻两段选中前一段 → 计算 z-index 为 10，截图中四边描边完整

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 用 `input.label ?? target.label` | 显式 null 被当成「没传」，清空失效 |
| 只比区间就认为 label 不用带 | 删除→撤销后时间对、标签消失（本轮要修的就是它） |
| 历史快照浅拷贝整行 | id 进栈，第二次撤销 404（22 的老坑，别踩回去） |
| 只给选中块加 z-index，忘了草案 | 拖拽时草案被选中的原块盖住 |
| 把守卫测成「拖拽本身能不能用」 | 删除完成后不重试的话，拖拽坏了也会显示 0 次 POST |

---

## 完成后

```bash
git add -A && git commit -m "fix(P1-P3): 标签随撤销/拖动保留，守卫与描边层级补齐"
```
