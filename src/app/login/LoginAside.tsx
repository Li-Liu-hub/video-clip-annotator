/** 登录页左栏：只讲一件事——数字为什么不会再变。lg 以下由 page.tsx 隐藏。 */

/** 三条规则各自对应库里的一处机制，写在下面是为了可核对，不是口号。 */
const POINTS = [
  {
    title: '区间不重叠',
    body: '同一任务内的片段禁止交叠，由数据库触发器兜底，重复计时进不了库。',
  },
  {
    title: '提交即冻结',
    body: '提交写入不可变存档与只追加账本，日后再改也另记一笔，不覆盖已发生的数字。',
  },
  {
    title: '按提交日归集',
    body: '日期在提交时按租户时区固化，查询期不再换算，历史不会随时间或时区漂移。',
  },
] as const;

export default function LoginAside() {
  return (
    <aside className="hidden flex-col justify-between border-r border-line-soft bg-panel/60 px-12 py-12 lg:flex xl:px-16">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-2/20 ring-1 ring-accent-2/40">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="1.5" y="3" width="13" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" className="text-accent" />
            <path d="M6.5 6.4v3.2l2.8-1.6-2.8-1.6Z" fill="currentColor" className="text-accent" />
          </svg>
        </span>
        <span className="text-[15px] font-medium tracking-tight text-ink">片段标注</span>
        <span className="tag">不可变账本</span>
      </div>

      <div className="max-w-[420px] py-10">
        <h2 className="text-[30px] font-medium leading-[1.35] tracking-tight text-ink">
          把「数字对不上」
          <br />
          从流程里删掉。
        </h2>
        <p className="mt-4 text-[13px] leading-relaxed text-ink-dim">
          手工汇总的账，改一次就要对一次。规则收进数据库后，历史日期的数字就不再需要事后核对。
        </p>

        <ul className="mt-10 space-y-6">
          {POINTS.map((point, index) => (
            <li key={point.title} className="flex gap-4">
              <span className="tnum mt-px text-[11px] leading-5 text-ink-faint">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="block">
                <span className="block text-[13.5px] font-medium text-ink">{point.title}</span>
                <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-faint">
                  {point.body}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-[11px] text-ink-faint">机器人示教视频 · 片段标注与工作量核算</p>
    </aside>
  );
}
