# G3 · 统计页（三视图）

> 按人视图的最新列与审核跳转见 [R2 管理明细](42-management-details.md)。

**做什么**：一个页面，能按「日 / 人 / 任务」看工作量，能改日期区间，能导出 CSV。

**依赖**：G1、G2

**预计**：1.5 小时

---

## 项目零 UI 依赖，图表手绘

`package.json` 里只有 `better-sqlite3 / next / react / react-dom`。E2 的时间轴就是手绘 SVG。

G3 的柱状图照此办理：一天一根柱子，`<rect>` 的 `height` 按占比算。
**不要**为了一个柱状图引入图表库——那会把首屏 JS 从 90KB 推到 300KB+，
而这个页面一周看两次。

---

## 三个视图各自要回答什么

| 视图 | 用户的问题 | 主列 | 次列 |
|---|---|---|---|
| 按日 | 这几天干得怎么样 | 日期 | 总时长、条目数 |
| 按人 | 谁做得多 | 姓名 | 总时长、条目数 |
| 按任务 | 这几条任务改了几轮 | 标题 | 总时长、提交次数、退回次数 |

「按任务」的 `submitCount` / `revokeCount` 分开显示，是因为**改了几轮**是管理者真正想知道的：
一条任务提交三次才过，和一次就过，工作量数字一样，过程完全不同。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/app/stats/page.tsx` | 服务端组件：读 query、调 `listStats`、传数据 |
| `src/app/stats/StatsView.tsx` | 客户端组件：视图切换、区间切换、导出 |
| `src/app/stats/DailyChart.tsx` | 手绘 SVG 柱状图 |
| `src/lib/stats-range.ts` | 默认区间与区间快捷选项（纯函数） |
| `src/lib/duration-format.ts` | 时长格式化（若有现成的就复用 `lib/time`） |
| `tests/stats-range.test.ts` | 新增 |

---

## 契约（不可改动）

```ts
// lib/stats-range.ts
export type RangePreset = 'last7' | 'last30' | 'thisMonth';

/** 预设区间对应的 from / to（YYYY-MM-DD），按租户时区算「今天」。 */
export function rangeOf(preset: RangePreset, today: string): DateRange;

/** query 里的 dim 参数归一：非法或缺失一律回 'day'。 */
export function normalizeDimension(raw: string | string[] | undefined): StatsDimension;
```

```ts
// app/stats/page.tsx
export const metadata: Metadata = { title: '统计 · 片段标注' };
// 搜索参数：?dim=day|annotator|task&from=YYYY-MM-DD&to=YYYY-MM-DD
// 缺省：dim=day，区间=最近 7 天
```

---

## 实现要点

### 1. 区间在 URL 里，不在组件状态里

筛选条件进 `searchParams`，好处有两个：

- 刷新不丢
- 分享链接就是分享那个视图（「你看这一周的数据」）

组件内部只保留「正在切换」这种瞬时状态。

### 2. 导出链接带上当前 query

```tsx
<a href={`/api/stats/export?dim=${dim}&from=${from}&to=${to}`} download>
```

**不要**在客户端 fetch 再 `URL.createObjectURL`：那是把服务端生成的附件经过内存转一手，
大文件会卡，而且 `download` 属性对同源 GET 本来就能直接工作。

### 3. 柱状图的空态

区间内没有任何账目时，不要画一条 0 高度的空图——那看起来像坏了。显示：

```
这段时间没有记录
换个区间，或者去任务列表领一条。
```

### 4. 时长格式化

`5700ms` → `5.7s`；超过 60 秒 → `1分30秒`；超过 1 小时 → `1小时5分`。

**不要**显示「1.5 小时」这种小数——账本的精度是毫秒，展示时按人话进位。

### 5. 按人视图只对管理员有意义

标注员访问时，「按人」只有他自己一行。这种情况下视图切换里可以保留（不算错），
但要在表头下加一句「你只能看到自己的数据」。

### 6. 图表必须有文本等价物

`<svg>` 加 `role="img"` 与 `<title>`，内容形如「2026-10-20 至 2026-10-26，最高 2 小时 15 分」。
**不要**只给视觉：屏幕阅读器读不到柱子。
（E8a 的入点竖线漏了这条，已记进 INDEX 的 G5。）

---

## 验收

**自动**

- [ ] `rangeOf('last7', '2026-10-25')` → `{ from: '2026-10-19', to: '2026-10-25' }`（含今天共 7 天）
- [ ] `rangeOf('last30', ...)` → 30 天
- [ ] `rangeOf('thisMonth', '2026-10-25')` → `{ from: '2026-10-01', to: '2026-10-25' }`
- [ ] `rangeOf('thisMonth', '2026-10-01')` → `{ from: '2026-10-01', to: '2026-10-01' }`（不越界到上个月）
- [ ] 跨月边界：`rangeOf('last7', '2026-11-02')` → `from: '2026-10-27'`
- [ ] `normalizeDimension` 对非法值回 `'day'`
- [ ] 现有 610 例全绿

**手工**

- [ ] 三个视图切换正常，URL 跟着变
- [ ] 改区间后数据跟着变，刷新不丢
- [ ] 导出按钮下载的文件与当前视图一致
- [ ] 空区间显示空态文案，不是空图
- [ ] 标注员登录 → 按人视图只有自己一行 + 那行说明
- [ ] 柱状图有 `<title>`，屏幕阅读器能读出区间与峰值

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 区间放组件 state | 刷新丢筛选，链接无法分享 |
| 导出用 fetch + blob | 大文件卡内存，且多一次垃圾 URL |
| 空区间画 0 高度图 | 看起来像功能坏了 |
| 时长显示小数 | 「1.5 小时」不如「1小时30分」 |
| 引图表库 | 首屏 JS 从 90KB 到 300KB+，为一个柱子不值 |
| 图表无文本等价物 | 屏幕阅读器读不到 |

---

## 完成后

```bash
git add -A && git commit -m "feat(G3): 统计页三视图，手绘 SVG 柱状图"
```

**下一步**：H1 审计埋点收尾、H2 审计查询页。
