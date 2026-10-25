# G2 · CSV 导出

**做什么**：把 G1 的三种统计导出成 CSV，能在 Excel 里直接打开。

**依赖**：G1

**预计**：0.5 小时

---

## 三个必须处理对的细节

CSV 看起来简单，但这三件事错一个，用户拿到的文件就是坏的：

### 1. BOM：不加，Excel 打开是乱码

Excel（尤其是中文 Windows）默认按本地代码页读 `.csv`，
没有 UTF-8 BOM 的话，「姓名」会显示成「濮撳悕」。

```
\uFEFF日期,总时长,条目数
```

BOM 只加在**导出给 Excel** 的文件上。其他场景（比如程序读取）加了反而碍事——
但这一版只有「给人下载」一个入口，所以统一加。

### 2. CSV 注入：以 `=` `+` `-` `@` 开头的值要加前缀

```
=HYPERLINK("http://evil","点我")
```

Excel 会把它当公式执行。用户填的任务标题里有这种内容时，导出的文件就是一张攻击载体。

**规则**：字段以 `= + - @ \t \r` 开头时，前面加一个单引号 `'`。

代价是以负号开头的数字会变成文本——但统计里没有负数（`totalMs` 在导出时取绝对值展示？
不，净额可能为 0 但不会是负的，因为退回只能冲掉已有的提交）。
即便如此也照加：安全优先于格式，且这类字段（标题、姓名）本来就不是数字。

### 3. 转义：引号、逗号、换行

含 `"` `,` `\n` `\r` 的字段要整体用 `"` 包起来，内部的 `"` 变成 `""`。

**不要**只处理逗号：用户在退回原因/任务标题里换行是常事。

---

## 产出

| 文件 | 说明 |
|---|---|
| `src/lib/csv.ts` | `toCsv(headers, rows)` 纯函数 + `escapeCell` |
| `src/app/api/stats/export/route.ts` | `GET`，`?dim=&from=&to=`，返回 `text/csv` |
| `tests/csv.test.ts` | 新增 |

---

## 契约（不可改动）

```ts
// lib/csv.ts
/** 导出给 Excel 的 CSV 必须带 BOM，否则中文乱码。 */
export const CSV_BOM = '\uFEFF';

/**
 * 把一个单元格转成 CSV 安全的形式。
 *
 * 三件事：防公式注入（= + - @ 开头加前缀）、包引号（含 , " 换行时）、
 * 内部引号翻倍。
 */
export function escapeCell(value: string | number | null): string;

/** 拼成完整 CSV 文本（含 BOM 与 CRLF 行尾）。 */
export function toCsv(headers: readonly string[], rows: readonly (string | number | null)[][]): string;
```

```ts
// app/api/stats/export/route.ts
// GET /api/stats/export?dim=day|annotator|task&from=YYYY-MM-DD&to=YYYY-MM-DD
// Content-Type: text/csv; charset=utf-8
// Content-Disposition: attachment; filename="stats-day-2026-10-01_2026-10-31.csv"
// 文件名用 ASCII：中文文件名在部分浏览器/代理下会被截断或乱码
```

---

## 实现要点

### 1. 行尾用 CRLF

`\r\n` 而不是 `\n`。RFC 4180 要求 CRLF，Excel 对 LF 的兼容性时好时坏。

### 2. 数字不加千分位

`5700` 而不是 `5,700`。后者会被 CSV 当成两列。

### 3. 时长列给两种单位

导出的表里同时给「毫秒」和「秒」：程序读毫秒不丢精度，人看秒有直觉。

```
日期,总时长(毫秒),总时长(秒),条目数
2026-10-25,5700,5.7,1
```

### 4. 空值

`null` → 空字符串，不是 `"null"`。

### 5. 复用 G1 的查询

导出**不重新写一遍 SQL**。调 `listStats` 拿结果，再映射成表格：
两份查询必然在一次 schema 变更后分叉，而导出的数字与页面对不上时最难查。

---

## 验收

**自动**

- [ ] `escapeCell('普通')` → `普通`
- [ ] `escapeCell('含,逗号')` → `"含,逗号"`
- [ ] `escapeCell('含"引号')` → `"含""引号"`
- [ ] `escapeCell('含\n换行')` → 带引号
- [ ] `escapeCell('=1+1')` → `'=1+1`（加了单引号前缀）
- [ ] `escapeCell('+86')` / `escapeCell('-1')` / `escapeCell('@x')` 同上
- [ ] `escapeCell(null)` → `''`
- [ ] `toCsv` 开头是 BOM
- [ ] `toCsv` 行尾是 `\r\n`
- [ ] 表头与数据行数正确
- [ ] 现有 547 例全绿

> G1 的测试会把总数推到 560 左右，G2 在此基础上再加。

**手工**

- [ ] 浏览器打开导出链接 → 下载 `.csv`
- [ ] Excel 打开 → 中文正常、列不串、日期列是文本不是 `####`
- [ ] 造一条标题为 `=1+1` 的任务再导出 → Excel 里显示 `'=1+1`，不执行公式

---

## 易错点

| 陷阱 | 后果 |
|---|---|
| 不加 BOM | Excel 中文乱码 |
| 不防公式注入 | 导出的文件变成攻击载体 |
| 只转义逗号 | 含换行的字段把一行拆成两行 |
| 数字加千分位 | 一列变两列 |
| 空值写成 `"null"` | Excel 里出现字面量 null |
| 导出重写一遍 SQL | 与页面的数字分叉，且最难查 |
| 文件名用中文 | 部分浏览器/代理下乱码或截断 |

---

## 完成后

```bash
git add -A && git commit -m "feat(G2): CSV 导出，含 BOM 与公式注入防护"
```

**下一步**：G3 统计页三视图。
