'use client';

/**
 * 提交区：片段数 + 总时长 + 提交按钮 + 内联确认。
 *
 * 确认用内联展开而非模态框：项目没有模态先例，为一个确认引入焦点管理不值；
 * 展开时片段列表仍在视野里，用户能对照着再确认「就是这些」。
 *
 * 本组件不改任何状态：提交由 Workbench 发起，成功后它 router.refresh() 让整页切成只读形态。
 */
import { useState } from 'react';

type Props = {
  segmentCount: number;
  totalMs: number;
  /** 提交中：禁用并改文案 */
  busy: boolean;
  onSubmit: () => void;
  /** 提交失败的提示。null 表示无错误 */
  error: string | null;
};

/** 工作台共用错误区（aria-live）的 id，SubmitBar 只引用它，不另起一处显示。 */
export const WORKBENCH_STATUS_ID = 'workbench-status';

const MS_PER_SECOND = 1000;

/** 毫秒 → 「12.4」：确认文案里的数字按秒说，与提交后记账的口径一致，不做分钟进位。 */
function secondsOf(ms: number): string {
  return (ms / MS_PER_SECOND).toFixed(1);
}

export default function SubmitBar({ segmentCount, totalMs, busy, onSubmit, error }: Props) {
  const [confirming, setConfirming] = useState(false);
  const empty = segmentCount === 0;

  return (
    <div className="panel px-3 py-2.5">
      {confirming && !empty ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[12.5px] text-ink">
              共 {segmentCount} 个片段，合计 {secondsOf(totalMs)} 秒
            </p>
            <p className="mt-0.5 text-[11.5px] text-ink-faint">
              提交后不能再修改，需要调整只能请管理员退回。
            </p>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              aria-describedby={error ? WORKBENCH_STATUS_ID : undefined}
              onClick={() => setConfirming(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              // 点下即禁用：请求在途时连点会发出第二个提交，服务端只会回 409
              onClick={onSubmit}
            >
              {busy ? '提交中…' : '确认提交'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11.5px] text-ink-faint">
            {empty
              ? '还没有片段，在下方时间轴上拖动标出至少一段后才能提交'
              : `共 ${segmentCount} 个片段，合计 ${secondsOf(totalMs)} 秒`}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            // 空片段时直接禁用并写明原因：让用户点了才看到「还没有标注任何片段」是多一次往返
            disabled={empty || busy}
            // 失败文案只在工作台的共用错误区显示，这里把按钮指过去：同一句话不在两处各说一遍
            aria-describedby={error ? WORKBENCH_STATUS_ID : undefined}
            onClick={() => setConfirming(true)}
          >
            {empty ? '还没有片段' : busy ? '提交中…' : '提交'}
          </button>
        </div>
      )}
    </div>
  );
}
