'use client';

/**
 * 统计页的交互外壳：视图切换、区间切换、导出，以及三张表。
 *
 * 三种切换都是链接或原生 GET 表单，区间只存在于 URL —— 组件里没有任何 useState。
 * 这不是「懒得写状态」：区间进了 state，刷新就丢、链接也分享不出同一个视图
 * （见 docs/steps/28-stats-page.md「区间在 URL 里」）。原生的表单提交天然满足这一点。
 *
 * 只从 service 取类型，不 import 运行期模块：那会把 repos 与 better-sqlite3 拖进浏览器 bundle。
 */
import Link from 'next/link';
import { formatHumanDuration } from '@/lib/duration-format';
import type { StatsDimension, StatsResult } from '@/lib/services/stats-service';
import { RANGE_PRESETS, countDays, queryOf, rangeOf, type DateRange } from '@/lib/stats-range';
import DailyChart from './DailyChart';

const DIMENSION_TABS: readonly { value: StatsDimension; label: string }[] = [
  { value: 'day', label: '按日' },
  { value: 'annotator', label: '按人' },
  { value: 'task', label: '按任务' },
];

/** 表头按维度穷举。列的顺序即「先看什么」：主列在最左，次数在时长右侧。 */
const COLUMNS: Record<StatsDimension, readonly string[]> = {
  day: ['日期', '总时长', '条目数'],
  annotator: ['姓名', '总时长', '条目数'],
  task: ['任务', '总时长', '提交次数', '退回次数'],
};

const ROW_CLASS =
  'border-b border-line-soft transition-colors last:border-0 hover:bg-panel-2/40';
const CELL_CLASS = 'tnum px-3 py-2.5 text-[12.5px] text-ink-dim';

type Props = {
  result: StatsResult;
  range: DateRange;
  /** 租户时区下的今天，预设区间的锚点 */
  today: string;
  isAdmin: boolean;
  /** URL 里的区间不合法或不完整，页面已回落到最近 7 天 */
  rangeAdjusted: boolean;
};

export default function StatsView({ result, range, today, isAdmin, rangeAdjusted }: Props) {
  const dimension = result.dimension;
  const query = queryOf(dimension, range);

  const activePreset =
    RANGE_PRESETS.find((preset) => {
      const candidate = rangeOf(preset.value, today);
      return candidate.from === range.from && candidate.to === range.to;
    })?.value ?? null;

  const isEmpty = result.rows.length === 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex items-center gap-2" aria-label="统计视图">
          {DIMENSION_TABS.map((tab) => (
            <Link
              key={tab.value}
              href={`/stats?${queryOf(tab.value, range)}`}
              aria-current={tab.value === dimension ? 'page' : undefined}
              className={`btn ${tab.value === dimension ? 'btn-primary' : 'btn-ghost'}`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>

        {/* 同源 GET 且带 download：浏览器直接落盘，不必先经内存转一手。
            客户端 fetch + createObjectURL 会让大文件卡在内存里，还多一个垃圾 URL */}
        <a className="btn btn-ghost" href={`/api/stats/export?${query}`} download>
          导出 CSV
        </a>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {RANGE_PRESETS.map((preset) => {
          const presetRange = rangeOf(preset.value, today);
          return (
            <Link
              key={preset.value}
              href={`/stats?${queryOf(dimension, presetRange)}`}
              aria-current={preset.value === activePreset ? 'true' : undefined}
              className={`btn ${preset.value === activePreset ? 'btn-primary' : 'btn-ghost'}`}
            >
              {preset.label}
            </Link>
          );
        })}

        {/* 原生 GET 表单：提交即换 URL，服务端重算。key 让日期框随区间重建 ——
            受控值没变时 React 会复用 DOM 节点，defaultValue 的更新不会显示出来 */}
        <form
          key={`${range.from}_${range.to}`}
          action="/stats"
          method="get"
          className="ml-auto flex flex-wrap items-end gap-2"
        >
          <input type="hidden" name="dim" value={dimension} />
          <label className="text-[11px] text-ink-faint">
            从
            <input
              type="date"
              name="from"
              defaultValue={range.from}
              className="field mt-1 w-[146px]"
            />
          </label>
          <label className="text-[11px] text-ink-faint">
            到
            <input type="date" name="to" defaultValue={range.to} className="field mt-1 w-[146px]" />
          </label>
          <button type="submit" className="btn btn-quiet">
            应用
          </button>
        </form>
      </div>

      <p className="text-[11.5px] text-ink-faint">
        {range.from} – {range.to} · 共 {countDays(range.from, range.to)} 天
      </p>

      {rangeAdjusted ? (
        <p className="text-[11.5px] text-warn">
          URL 里的区间不合法或不完整，已显示最近 7 天。
        </p>
      ) : null}

      {/* 标注员的「按人」只有自己一行，说一句比让人怀疑数据缺失好 */}
      {dimension === 'annotator' && !isAdmin ? (
        <p className="text-[11.5px] text-ink-faint">你只能看到自己的数据</p>
      ) : null}

      {isEmpty ? (
        <div className="panel px-4 py-10 text-center">
          <p className="text-[12.5px] text-ink-dim">这段时间没有记录</p>
          <p className="mt-1 text-[11.5px] text-ink-faint">换个区间，或者去任务列表领一条。</p>
        </div>
      ) : (
        <>
          {result.dimension === 'day' ? (
            <DailyChart from={range.from} to={range.to} rows={result.rows} />
          ) : null}

          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left">
                <thead>
                  <tr className="border-b border-line-soft text-[11px] text-ink-faint">
                    {COLUMNS[dimension].map((label, index) => (
                      <th
                        key={label}
                        className={`py-2.5 font-normal ${index === 0 ? 'px-4' : 'px-3'}`}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.dimension === 'day'
                    ? result.rows.map((row) => (
                        <tr key={row.date} className={ROW_CLASS}>
                          <td className="tnum px-4 py-2.5 text-[12.5px] text-ink">{row.date}</td>
                          <td className={CELL_CLASS}>{formatHumanDuration(row.totalMs)}</td>
                          <td className={CELL_CLASS}>{row.entryCount}</td>
                        </tr>
                      ))
                    : null}

                  {result.dimension === 'annotator'
                    ? result.rows.map((row) => (
                        <tr key={row.annotatorId} className={ROW_CLASS}>
                          <td className="px-4 py-2.5 text-[12.5px] text-ink">{row.displayName}</td>
                          <td className={CELL_CLASS}>{formatHumanDuration(row.totalMs)}</td>
                          <td className={CELL_CLASS}>{row.entryCount}</td>
                        </tr>
                      ))
                    : null}

                  {result.dimension === 'task'
                    ? result.rows.map((row) => (
                        <tr key={row.taskId} className={ROW_CLASS}>
                          <td className="px-4 py-2.5">
                            <div
                              className="max-w-[360px] truncate text-[12.5px] text-ink"
                              title={row.title}
                            >
                              {row.title}
                            </div>
                          </td>
                          <td className={CELL_CLASS}>{formatHumanDuration(row.totalMs)}</td>
                          {/* 提交与退回分开计数：一条任务提交三次才过，和一次就过，
                              工作量数字可以一样，过程完全不同 —— 这正是管理者要看的 */}
                          <td className={CELL_CLASS}>{row.submitCount}</td>
                          <td className={`${CELL_CLASS} ${row.revokeCount > 0 ? 'text-bad' : ''}`}>
                            {row.revokeCount}
                          </td>
                        </tr>
                      ))
                    : null}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
