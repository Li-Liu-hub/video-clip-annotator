# STEP 07 · 统计与导出

**目标**：管理员能看到三个维度的数据，能导出 CSV。

**前置**：06 完成（账本里有数据）

**预计**：2 小时

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/services/statsService.ts` | 三个视图的查询 |
| `src/app/api/stats/daily/route.ts` | 按天 / 按人 |
| `src/app/api/stats/tasks/route.ts` | 按任务 |
| `src/app/api/stats/export/route.ts` | CSV |
| `src/app/admin/page.tsx` | 概览 |
| `src/app/admin/stats/page.tsx` | 三视图切换 |
| `src/components/admin/{StatTable,DailyChart,TaskQualityTable}.tsx` | 展示组件 |

---

## 三个视图的数据源不同

| 视图 | 数据源 | 查询 |
|---|---|---|
| 按天 | `ledger_entries` | `SUM(delta_ms) GROUP BY entry_date` |
| 按人 | `ledger_entries` | 加 `annotator_id` 维度 |
| 按任务 | `submissions` | 取 `segment_count`、`total_ms` 排序 |

**前两个读账本，第三个读存档。** 账本回答「总量」，存档回答「构成」。
这是刻意的分工：账本里没有「这个任务标了几段」这种信息，也不该有。

---

## 关键实现

### 1. 按天 + 按人一次查出来

不要查两次。用一条 SQL 带 `annotator_id`，前端按需聚合：

```sql
SELECT l.entry_date,
       l.annotator_id,
       u.display_name              AS annotator_name,
       SUM(l.delta_ms)             AS total_ms
  FROM ledger_entries l
  JOIN users u ON u.id = l.annotator_id
 WHERE l.entry_date BETWEEN ? AND ?
   AND (? IS NULL OR l.tenant_id = ?)      -- 管理员传 NULL 即不筛选
 GROUP BY l.entry_date, l.annotator_id
 ORDER BY l.entry_date, l.annotator_id;
```

前端：「按天」视图对 date 求和；「按人」视图直接展示。

**注意 `(? IS NULL OR l.tenant_id = ?)` 这种写法**在 SQLite 里可以，但更清晰的做法是
在 service 层拼接条件——本项目采用后者，避免参数占位符的坑。

### 2. 按任务视图：用来发现异常

```sql
SELECT t.id, t.title, v.filename,
       s.segment_count, s.total_ms, s.local_date,
       u.display_name AS annotator
  FROM tasks t
  JOIN videos v      ON v.id = t.video_id
  JOIN submissions s ON s.task_id = t.id AND s.superseded_by IS NULL
  JOIN users u       ON u.id = s.annotator_id
 WHERE t.status = 'submitted'
   AND s.local_date BETWEEN ? AND ?
 ORDER BY s.segment_count ASC, s.total_ms DESC;
```

**按片段数升序排**，最前面是「只标了 1 段但时长很长」的任务——通常意味着标注员偷懒，
把整段视频当成一个片段提交了。管理员看到这个才会去抽查。

给这一列加视觉提示：`segment_count <= 2` 且 `total_ms > 20000` 时标黄。

### 3. 标注员只能看自己

```ts
const scopeTenant = actor.role === 'admin'
  ? (query.tenantId ?? null)      // 管理员可筛选，也可看全部
  : actor.tenantId;               // 标注员强制自己的
```

**标注员传 `?tenantId=` 无效**，直接在 service 层覆盖。

### 4. CSV 导出

```ts
export async function GET(req: Request) {
  // ...鉴权、取数

  const rows: string[] = [];
  rows.push(['任务标题','标注员','提交日期','提交时间','序号','入点','出点','时长','标签']
    .map(csvCell).join(','));

  for (const r of data) {
    rows.push([
      r.title, r.annotator, r.localDate, formatClock(r.submittedAt),
      String(r.index), formatMs(r.startMs), formatMs(r.endMs),
      formatMs(r.endMs - r.startMs), r.label ?? '',
    ].map(csvCell).join(','));
  }

  // BOM 必须有，否则 Excel 打开是乱码
  const body = '\uFEFF' + rows.join('\r\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="segments_${from}_${to}.csv"`,
    },
  });
}

function csvCell(v: string) {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
```

**`\uFEFF` 不能省。** 没有 BOM 的 UTF-8 CSV 在中文 Windows 的 Excel 里会显示成乱码，
这是最常见的「我这边好好的」问题。

**`formatMs` 用 `00:02.100` 格式**，不要用毫秒数——导出的表是给人看的。

### 5. 导出要记审计

```
writeAudit(tx, actor, 'stats.export', null, null, { from, to, tenantId, rowCount });
```

导出意味着数据离开系统，这是审计关心的动作。

---

## 图表

按天趋势用一个简单的柱状图即可。**不要引入图表库**（recharts 有 400KB+，且和 Tailwind v4 样式冲突）。

手写 SVG 柱状图，30 行：

```tsx
<svg viewBox={`0 0 ${days.length * 40} 120`}>
  {days.map((d, i) => (
    <rect key={d.date} x={i * 40 + 8} y={120 - h(d.totalMs)}
          width={24} height={h(d.totalMs)} rx={3} fill="#8b93f8" />
  ))}
</svg>
```

`h(ms) = (ms / maxMs) * 100`，注意 `maxMs` 为 0 时不要除零。

---

## 验收标准

- [ ] 按天视图：7 天的柱子，高度与数据成比例
- [ ] 按人视图：三个标注员各有数值，合计等于按天视图当天总量
- [ ] 按任务视图：片段数为 1 的行排在最前，且标黄
- [ ] 标注员登录只能看到自己那一行，页面上没有「按任务」tab
- [ ] 导出 CSV 用 Excel 打开，中文正常、列对齐
- [ ] 导出的总时长与页面显示一致
- [ ] 导出一个空区间 → 只有表头，不报错
- [ ] 审计页能看到刚才的导出记录

---

## 容易错的地方

| 陷阱 | 后果 |
|---|---|
| CSV 漏 BOM | Excel 中文乱码 |
| 用 `,` 分割但字段里有逗号 | 列错位 |
| CSV 用 `\n` 换行 | 部分 Excel 版本把所有行挤在一格 |
| 标注员能传 `tenantId` | 越权看他人数据 |
| 按任务视图用 `ledger_entries` | 账本里没有 segment_count，查不出来 |
| 图表除零 | `NaN` 高度，柱子消失 |
| 日期区间用 `BETWEEN` 但没校验 `from <= to` | 返回空集，用户以为坏了 |

---

## 完成后

统计能看了，数据能导出了。但此时系统还「不可追溯」——没人知道谁在什么时候做了什么。
下一步补上审计。
