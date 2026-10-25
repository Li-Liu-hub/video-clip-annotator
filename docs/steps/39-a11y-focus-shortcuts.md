# P4–P7 · 无障碍收尾：快捷键开关、aria-busy、焦点、太短提示

**做什么**：把 INDEX 里最后四条产品向未修项（A3 / G4 / G5 / M6）修掉。

**依赖**：E7、E5

**预计**：3 小时

---

## P4（A3）单字符快捷键可关闭

**现状**：I / O / 空格绑在 window 上，没有开关、不可重映射。
WCAG 2.1.4 要求字符键快捷键至少满足一条：可关闭 / 可重映射 / 只在焦点内生效。
本项目绑 window 是为了「焦点在视频上也能用」，所以选**可关闭**。

**做法**：

- 页脚加一个原生 checkbox「单字符快捷键（空格 / I / O）」；
- 偏好存 `localStorage`（`vsap.single-key-shortcuts`），只认显式 `off` 为关闭；
  没存过、脏值、读不到都回落到开启 —— 默认关闭会让第一次用的人以为快捷键坏了；
- 关闭只停这三个键。Delete / 方向键 / Ctrl+Z 不是字符键，照常可用；
- 关闭时页脚不再列键位，改成一句「已关闭，方向键 / Delete / Ctrl+Z 仍可用」，避免教用户按已禁用的键。

**为什么不放在服务端**：这是本机手感，不是账号配置。换一台机器重新选一次可以接受，
换来的是不用为它加一张表与一套接口。

---

## P5（G4）删除中补 `aria-busy`

**现状**：删除按钮 `disabled` 且文案变「删除中…」，但 `aria-label` 是「删除第 N 段」，
覆盖了按钮内容 —— 屏幕阅读器听不到状态变化。

**做法**：删除中把 `aria-label` 改成「第 N 段删除中」，并加 `aria-busy`。
两条都要：`aria-busy` 表达「忙」，label 表达「忙的是哪一行」。

**还要在状态行播报**：按钮 `disabled` 后浏览器会把焦点移走，读屏器读不到一个已经失焦的
按钮上的 `aria-busy`。状态行本来就是 `aria-live="polite"`，删除中显示
「正在删除片段…」—— 这条才是真正能被听到的。

---

## P6（G5）删除后的焦点策略

**现状**：删除成功后焦点落回 `body`。连续整理片段时，按 Tab 要从页面顶部重新开始。

**策略**（写死，不留给"看情况"）：

1. 优先焦点到**下一段**的选中按钮（与选中迁移同一个判定 `pickNextSelection`）；
2. 没有下一段就到**上一段**；
3. 列表空了就聚焦空态文本（`tabIndex={-1}`），屏幕阅读器会读出「还没有片段…」；
4. 目标行找不到（并发删除的竞态）就聚焦列表容器，不把焦点留在 body。

**只在删除成功后请求**：撤销也会删/建片段，但那是用户按 Ctrl+Z 的结果，
焦点跟着跳会打断「连续撤销」。所以 `focusRequest` 由 `removeSegment` 单独发出。

---

## P7（M6）O 键太短要给提示

**现状**：出点与入点不足 `MIN_SEGMENT_MS` 时静默 return。入点还在，
但用户看到的是「按了 O 什么都没发生」。

**做法**：`useShortcuts` 增加 `onTooShort`，Workbench 在状态行显示：
「这一段太短（至少 0.1 秒）。入点还在，挪一下播放头再按 O 即可。」
文案来自 `TOO_SHORT_HINT`，下限值直接取 `MIN_SEGMENT_MS`，不再手写一遍。
提示用中性色（`text-ink-dim`），与红色错误分开 —— 太短不是失败；
写成功、删除成功、撤销、Esc 都会清掉它。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/shortcut-prefs.ts` | 偏好解析/序列化，纯函数 |
| `src/lib/shortcuts.ts` | `TOO_SHORT_HINT` |
| `src/app/tasks/[id]/work/use-shortcuts.ts` | 字符键开关、`onTooShort` |
| `src/app/tasks/[id]/work/SegmentList.tsx` | `aria-busy`、焦点请求、空态可聚焦 |
| `src/app/tasks/[id]/work/Workbench.tsx` | 开关 UI、提示状态、焦点请求 |
| `tests/shortcut-prefs.test.ts` / `tests/shortcuts.test.ts` | 新增 7 例 |

---

## 验收

**自动**

- [x] `parseSingleKeyShortcuts`：null/脏值 → 开启，`off` → 关闭，序列化互逆（5 例）
- [x] `TOO_SHORT_HINT`：含「太短」「入点还在」与 0.1 秒（2 例）
- [x] 变异：解析恒返回 true → 恰好 2 例红

**浏览器**（`scripts/browser/browser-a11y.py`，`npm run test:browser`）

- [x] 关闭开关后按空格视频不播放、按 I 不出现入点竖线；刷新后仍是关闭
- [x] 重新开启后空格能播放
- [x] 删除在途时按钮 `aria-busy="true"`、label 变「第 N 段删除中」
- [x] 删除中间一段后，焦点在下一段的选中按钮上
- [x] 删除最后一段后，焦点在空态文本上
- [x] I 后挪 50ms 按 O：出现「太短」提示，且没有 POST

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 开关只停 I/O、不停空格 | WCAG 的字符键包含空格，等于没关 |
| 关闭时连 Delete / 方向键一起停 | 非字符键不该被这个偏好影响，用户会以为整个键盘坏了 |
| 只加 `aria-busy`，不改 `aria-label` | 屏幕阅读器被 label 覆盖，听不到「删除中」 |
| 只给失焦的按钮挂 `aria-busy` | disabled 会把焦点移走，读屏器读不到；状态行必须一起播报 |
| 撤销也触发焦点请求 | 连续 Ctrl+Z 时焦点乱跳 |
| 列表空了不聚焦任何东西 | 焦点仍落回 body，和修之前一样 |
| 太短提示用红色 | 用户没犯错，红色会让人以为数据出问题了 |

---

## 完成后

```bash
git add -A && git commit -m "feat(P4-P7): 快捷键可关闭、删除态可读、焦点可续、太短有提示"
```
