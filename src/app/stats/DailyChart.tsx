/**
 * 按日柱状图：手绘 SVG，一天一根柱子。
 *
 * 不引图表库：项目零 UI 依赖，为一张一周看两次的图把首屏 JS 从 90KB 推到 300KB+ 不值。
 * 柱子几何全在本文件算，组件不持有状态，也不读请求上下文。
 *
 * 读屏软件看不见 <rect>，故 svg 带 role="img" 与 <title>，用一句话给出区间与峰值；
 * 精确数字由下方表格承担，图只负责形状。
 */
import { formatHumanDuration } from '@/lib/duration-format';
import type { DayTotal } from '@/lib/services/stats-service';
import { barSlots } from '@/lib/chart-bars';
import { MAX_CHART_DAYS, countDays } from '@/lib/stats-range';

/** viewBox 的坐标单位，与像素无关：容器多宽，柱子就按比例铺多宽。 */
const VIEW_WIDTH = 1_000;
const VIEW_HEIGHT = 200;
/** 柱宽占一格宽度的比例，余下留作间隙 */
const BAR_WIDTH_RATIO = 0.62;
/** 有净额但极小的日子也要留一道可见的柱：与「这天没干活」必须能分辨 */
const MIN_BAR_HEIGHT = 2;
const BAR_RADIUS = 2;
const CHART_HEIGHT_CLASS = 'h-[160px]';

const AXIS_COLOR = 'var(--color-line)';
const BAR_COLOR = 'var(--color-accent-2)';
const PEAK_BAR_COLOR = 'var(--color-accent)';

type Props = {
  from: string;
  to: string;
  /** 只含「有账目」的日子，缺的日子由本组件补零（G1 的查询不补零） */
  rows: DayTotal[];
};

export default function DailyChart({ from, to, rows }: Props) {
  const dayCount = countDays(from, to);

  // 超长区间不画，也不截断：截断的柱图会让人以为「后面的日子没数据」
  if (dayCount > MAX_CHART_DAYS) {
    return (
      <p className="panel px-4 py-6 text-center text-[12px] text-ink-dim">
        区间超过 {MAX_CHART_DAYS} 天，柱状图已省略，请看下方表格。
      </p>
    );
  }

  const slots = barSlots(from, to, rows);
  const dates = slots.map((slot) => slot.date);
  const peakMs = rows.reduce((max, row) => Math.max(max, row.totalMs), 0);
  const peakDate = rows.find((row) => row.totalMs === peakMs)?.date ?? null;
  // peakMs 为 0（有账目但净额全被冲平）时用 1 兜底，避免除零把柱高变成 NaN
  const scale = peakMs > 0 ? peakMs : 1;

  const slotWidth = VIEW_WIDTH / dates.length;
  const barWidth = Math.max(1, slotWidth * BAR_WIDTH_RATIO);

  return (
    <div className="panel px-4 py-3.5">
      <svg
        role="img"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        // 不保持比例：柱子按容器宽度铺满，纵向固定 160px。图内没有文字，拉伸不会变形字体
        preserveAspectRatio="none"
        className={`block w-full ${CHART_HEIGHT_CLASS}`}
      >
        <title>
          {`${from} 至 ${to}，最高 ${peakDate ? `${peakDate} ${formatHumanDuration(peakMs)}` : '无记录'}`}
        </title>

        <line
          x1={0}
          y1={VIEW_HEIGHT}
          x2={VIEW_WIDTH}
          y2={VIEW_HEIGHT}
          stroke={AXIS_COLOR}
          strokeWidth={1}
        />

        {slots.map(({ date, totalMs }, index) => {
          /**
           * 每一天都渲染一个 rect，即使净额为 0 或负。
           *
           * 早先的写法是 `if (totalMs <= 0) return null` —— 视觉上少一根柱子，
           * 横轴也因此被压缩（8 天区间只剩 7 根，看着像「这 8 天里过了 7 天」）。
           * 更实际的理由：不渲染就没有 DOM 节点，测试无法反查「哪一天没有数据」，
           * 于是「补零」这件事变成无人守护的行为（reviewer 删掉补零，630 例全绿）。
           *
           * 0 高度柱子不可见，但它在 DOM 里；data-date 让测试能按日期定位。
           * 净额为负也不画向下的柱子：横轴下没有刻度，向下的柱子只会被读成「负的活」。
           */
          const height = totalMs > 0 ? Math.max(MIN_BAR_HEIGHT, (totalMs / scale) * VIEW_HEIGHT) : 0;
          return (
            <rect
              key={date}
              data-date={date}
              data-total-ms={totalMs}
              x={index * slotWidth + (slotWidth - barWidth) / 2}
              y={VIEW_HEIGHT - height}
              width={barWidth}
              height={height}
              rx={BAR_RADIUS}
              fill={totalMs === peakMs ? PEAK_BAR_COLOR : BAR_COLOR}
            />
          );
        })}
      </svg>

      {/* 图内不放日期文字：viewBox 会被横向拉伸，文字必然变形。轴标签交给 HTML */}
      <div className="mt-1.5 flex items-center justify-between gap-4 text-[10.5px] text-ink-faint">
        <span className="tnum">{from}</span>
        {peakDate ? <span>最高 {peakDate}</span> : null}
        <span className="tnum">{to}</span>
      </div>
    </div>
  );
}
