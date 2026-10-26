/**
 * 统计区间的纯计算：预设区间、URL 区间的兜底、维度归一、按天铺格。
 *
 * 无请求上下文、无运行期依赖，服务端页面与客户端视图共用同一份 ——
 * 两处各算一次「最近 7 天」，跨月的那个月迟早差一天。
 */
import type { StatsDimension } from '@/lib/services/stats-service';

export type RangePreset = 'last7' | 'last30' | 'thisMonth';

/** 闭区间，两端都是落库即定型的 YYYY-MM-DD。账本查询与此处的区间计算共用这一份。 */
export type DateRange = { from: string; to: string };

const DAY_MS = 86_400_000;
const LAST7_DAYS = 7;
const LAST30_DAYS = 30;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_FIRST_DAY = '-01';

/**
 * 日柱上限。
 *
 * 区间来自 URL，图表要按天铺柱子。不设上限时，手填「0001-01-01 至 9999-12-31」
 * 会让渲染循环跑三百多万次、生成同样多的 <rect> —— 一个查询串就能把页面拖死。
 * 366 天足够覆盖任何正常的「看一段日子」，再多柱子也已细到无法分辨。
 */
export const MAX_CHART_DAYS = 366;

/** 快捷区间的顺序与文案。放在这里而不是组件里：两处各写一份，文案与取值迟早对不上。 */
export const RANGE_PRESETS: readonly { value: RangePreset; label: string }[] = [
  { value: 'last7', label: '最近 7 天' },
  { value: 'last30', label: '最近 30 天' },
  { value: 'thisMonth', label: '本月' },
];

/**
 * 日期加减天数。
 *
 * 一律在 UTC 零点上做算术：本地时间在夏令时切换那天只有 23 或 25 小时，
 * 「最近 7 天」会变成 6 天或 8 天。UTC 没有夏令时。
 */
function shiftDays(date: string, delta: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 是不是真实存在的一天。
 *
 * 正则之外再走一次 UTC 往返：`2026-02-31` 会被 Date 归一到 3 月 3 日，
 * 归一后与输入不等即拒绝；`2026-13-45` 直接解析成 NaN。
 * 不用本地时区解析 —— `new Date('2026-10-25')` 按 UTC 读、按本地打印，东八区会差一天。
 */
function isIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** 查询串可能重复给同一个键，一律取第一个（与 page-param 取页码同一口径）。 */
function firstOf(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value === '' ? undefined : value;
}

/**
 * 预设区间 → from / to。都含今天：`last7` 是「今天 + 前 6 天」，共 7 天。
 *
 * `thisMonth` 用字符串取月初而不是做减一个月的日期运算：月份长度不一，
 * `Date` 的月份回退会溢出（3 月 31 日减一个月得到 3 月 3 日）。
 */
export function rangeOf(preset: RangePreset, today: string): DateRange {
  switch (preset) {
    case 'last7':
      return { from: shiftDays(today, -(LAST7_DAYS - 1)), to: today };
    case 'last30':
      return { from: shiftDays(today, -(LAST30_DAYS - 1)), to: today };
    case 'thisMonth':
      return { from: `${today.slice(0, 7)}${MONTH_FIRST_DAY}`, to: today };
  }
}

/** 三个维度是穷举的；用 Record 而非数组，加维度时这里会编译报错而不是静默判为非法。 */
const DIMENSIONS: Record<StatsDimension, true> = { day: true, annotator: true, task: true };

function isDimension(value: string): value is StatsDimension {
  return Object.hasOwn(DIMENSIONS, value);
}

/**
 * URL 的 dim 归一。非法或缺失一律回 day：
 * 为一次手改的查询串显示错误页，比显示默认视图更糟（/admin/tasks 对 status 同样处理）。
 */
export function normalizeDimension(raw: string | string[] | undefined, isAdmin = true): StatsDimension {
  const value = firstOf(raw);
  if (!isAdmin && value === 'annotator') return 'day';
  return value !== undefined && isDimension(value) ? value : 'day';
}

/**
 * 从 URL 取区间，不合法就回落「最近 7 天」。
 *
 * 页面的区间是外部输入，直接交给 listStats 会抛 ValidationError 让整页变错误页。
 * 校验口径与 service 一致（真实日历日 + from <= to），所以不会带着坏区间去查库；
 * 回落时用 adjusted 告诉页面「用户原本填的东西没被采纳」，好在界面上说一句。
 */
export function resolveRange(
  rawFrom: string | string[] | undefined,
  rawTo: string | string[] | undefined,
  today: string,
): { range: DateRange; adjusted: boolean } {
  const from = firstOf(rawFrom);
  const to = firstOf(rawTo);
  const provided = from !== undefined || to !== undefined;

  if (from !== undefined && to !== undefined && isIsoDate(from) && isIsoDate(to) && from <= to) {
    return { range: { from, to }, adjusted: false };
  }
  return { range: rangeOf('last7', today), adjusted: provided };
}

/** 闭区间内的天数。两端都是 UTC 零点，差值必为整天。 */
export function countDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/**
 * 闭区间内的每一天，升序。
 *
 * 图表要一天一根柱子，没账目的日子也得占一格 —— 否则柱子的疏密会随「有无记录」
 * 而不是随日期变化，横轴就骗人了。补零在这里做，因为它是展示层的事（G1 的查询不补零）。
 */
export function datesInRange(from: string, to: string): string[] {
  const days = countDays(from, to);
  if (days <= 0) return [];
  const out: string[] = [];
  for (let index = 0; index < days; index += 1) out.push(shiftDays(from, index));
  return out;
}

/**
 * 视图链接与导出链接共用的查询串。
 *
 * 放在 lib 而不是组件里：它决定「导出的到底是哪个视图」，
 * 是必须被测试守住的一处 —— 留在客户端组件内时，
 * 把 dimension 写死成 'day' 不会有任何用例变红（reviewer 实测 630 例全绿）。
 */
export function queryOf(dimension: StatsDimension, range: DateRange): string {
  return new URLSearchParams({
    dim: dimension,
    from: range.from,
    to: range.to,
  }).toString();
}
