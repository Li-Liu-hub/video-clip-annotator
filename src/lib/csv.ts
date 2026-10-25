/**
 * CSV 生成：BOM、公式注入防护、按 RFC 4180 转义。
 *
 * 只做「值 → 文本」，不碰统计口径 —— 列的含义由调用方（导出路由）决定。
 */

/** 导出给 Excel 的 CSV 必须带 BOM，否则中文乱码。 */
export const CSV_BOM = '\uFEFF';

/** RFC 4180 要求 CRLF；Excel 对纯 LF 的兼容性时好时坏。 */
const CRLF = '\r\n';

/**
 * Excel 把这几个字符开头的单元格当公式执行（`=HYPERLINK(...)` 即可外联）。
 * 任务标题、姓名都是用户可填的，导出文件因此可能成为攻击载体。
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/** 逗号、引号、换行都必须整体加引号：只处理逗号的话，带换行的标题会把一行拆成两行。 */
const NEEDS_QUOTE = /[",\n\r]/;

/**
 * 把一个单元格转成 CSV 安全的形式。
 *
 * 三件事：防公式注入（= + - @ 开头加前缀）、包引号（含 , " 换行时）、
 * 内部引号翻倍。
 */
export function escapeCell(value: string | number | null): string {
  if (value === null) return '';

  // 数字走 String()：不加千分位，否则 5,700 会被当成两列
  const text = String(value);
  // 数字也照加前缀：代价是负号开头的数变成文本，安全优先于这点格式
  const guarded = FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix))
    ? `'${text}`
    : text;

  return NEEDS_QUOTE.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** 拼成完整 CSV 文本（含 BOM 与 CRLF 行尾）。 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (string | number | null)[][],
): string {
  const lines = [
    headers.map(escapeCell).join(','),
    ...rows.map((row) => row.map(escapeCell).join(',')),
  ];
  return CSV_BOM + lines.join(CRLF) + CRLF;
}
