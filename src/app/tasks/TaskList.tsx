'use client';

/**
 * 任务列表：表格 + 分页 + 行内领取/归还/退回，标注员页与管理员页共用。
 *
 * 共用而非各写一份的原因：两页只差「租户列」与「操作列」，
 * 拆成两份后状态配色与空态文案必然各自漂移。
 *
 * 本文件是客户端组件（操作成功后就地把行状态改掉），但列表仍以服务端 props 为准：
 * 操作结果以「行覆盖」叠加而不是复制一份列表 —— 复制后翻页会拿旧数据覆盖服务器的新结果。
 * 因此不 import 服务端模块：TaskRow 来自 task-service，会把数据层拖进 bundle；
 * 这里只声明用到的展示字段，页面侧的 TaskRow 与之结构兼容。
 * 退回原因的长度上限取自 lib/review-limits，与服务端校验共用同一个数字。
 */
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { MAX_REASON_LENGTH } from '@/lib/review-limits';
import { formatDuration, localDateOf } from '@/lib/time';

type TaskStatus = 'pending' | 'claimed' | 'submitted' | 'rejected';

type TaskListItem = {
  id: string;
  title: string;
  status: TaskStatus;
  claimed_by: string | null;
  estimated_ms: number;
  video_filename: string;
  tenant_name: string;
  claimed_by_name: string | null;
  /** 退回原因。标注员与管理员都要看到，否则「退回」只是一次无声的状态变更。 */
  reject_reason: string | null;
  created_at: number;
};

type TaskListProps = {
  items: TaskListItem[];
  showTenant: boolean;
  timezone: string;
  /** 当前标注员。管理员传 null：管理员不参与标注，整列操作都不渲染。 */
  currentUser: { id: string; displayName: string } | null;
  /** 管理员审核入口。没有「通过」按钮：提交即计入，审核只做退回。 */
  canReject?: boolean;
};

type TaskPagerProps = {
  total: number;
  page: number;
  pageSize: number;
  basePath: string;
  /** 翻页时保留的查询条件（如 status）。 */
  query?: Record<string, string>;
};

/**
 * 状态标签的文案与配色。
 * 四色只在设计 token 里定义过，组件不得写死色值；pending 取中性灰，表示「还没有归属」。
 */
const STATUS: Record<TaskStatus, { label: string; className: string }> = {
  pending: { label: '待领取', className: 'text-ink-dim' },
  claimed: { label: '进行中', className: 'text-accent' },
  submitted: { label: '已提交', className: 'text-good' },
  rejected: { label: '已退回', className: 'text-bad' },
};

/** 409 是正常竞争而非故障：文案只说事实，不摆出错误姿态。 */
const CLAIM_CONFLICT_NOTICE = '这条任务刚被其他人领走了';
const RELEASE_CONFLICT_NOTICE = '这条任务已不在你名下';
const REJECT_CONFLICT_NOTICE = '这条任务已不在待审核状态';
const ACTION_FAILED_NOTICE = '操作失败，请刷新页面后重试';

/**
 * 一行的本地状态。
 *
 * 只存「这次操作改变了什么」，不存整行：服务端一有新的 props，
 * 未被操作的行自动回到服务器版本，不需要同步逻辑。
 */
type RowUi = {
  /** 请求中：按钮立即禁用，防重复提交 */
  busy: boolean;
  notice: string | null;
  /** 以下四项为 undefined 时以 props 为准 */
  status?: TaskStatus;
  claimedBy?: string | null;
  claimedByName?: string | null;
  rejectReason?: string | null;
};

const EMPTY_ROW_UI: RowUi = { busy: false, notice: null };

export default function TaskList({
  items,
  showTenant,
  timezone,
  currentUser,
  canReject = false,
}: TaskListProps) {
  const [rows, setRows] = useState<Record<string, RowUi>>({});
  /** 正在填退回原因的任务 id；null 表示没有展开的输入区 */
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [rejectDraft, setRejectDraft] = useState('');

  const showActions = currentUser !== null || canReject;
  // 表头：任务/[租户]/时长/状态/领取人/创建日期/[操作]
  const columnCount = 5 + (showTenant ? 1 : 0) + (showActions ? 1 : 0);

  function updateRow(taskId: string, patch: Partial<RowUi>) {
    setRows((prev) => ({
      ...prev,
      [taskId]: { ...EMPTY_ROW_UI, ...prev[taskId], ...patch },
    }));
  }

  /**
   * 领取或归还。成功后就地改行，不整页跳转也不调 router.refresh()：
   * 后者会让被抢走的那一行直接消失，恰恰是最该看到冲突提示的时候。
   * 服务器语义已在 service 里落库，页面刷新后自然一致。
   */
  async function act(taskId: string, kind: 'claim' | 'release') {
    // 按钮已禁用，这里再兜一层：双击不能发出第二个请求
    if (rows[taskId]?.busy) return;
    updateRow(taskId, { busy: true, notice: null });

    let status: number;
    try {
      const response = await fetch(`/api/tasks/${taskId}/${kind}`, { method: 'POST' });
      status = response.status;
    } catch {
      // 网络层失败与 5xx 同处理：恢复可点，让人重试
      updateRow(taskId, { busy: false, notice: ACTION_FAILED_NOTICE });
      return;
    }

    if (status === 200) {
      updateRow(
        taskId,
        kind === 'claim'
          ? {
              busy: false,
              status: 'claimed',
              claimedBy: currentUser?.id ?? null,
              claimedByName: currentUser?.displayName ?? null,
            }
          : { busy: false, status: 'pending', claimedBy: null, claimedByName: null },
      );
      return;
    }

    if (status === 409) {
      updateRow(taskId, {
        busy: false,
        notice: kind === 'claim' ? CLAIM_CONFLICT_NOTICE : RELEASE_CONFLICT_NOTICE,
        // 领取冲突说明这条已被别人拿走；本端拿不到是谁，领取人留空而不是编一个名字
        ...(kind === 'claim'
          ? { status: 'claimed' as const, claimedBy: null, claimedByName: null }
          : {}),
      });
      return;
    }

    updateRow(taskId, { busy: false, notice: ACTION_FAILED_NOTICE });
  }

  /**
   * 退回并冲正。成功后就地把行改成「已退回」并显示原因，不整页刷新：
   * 管理员常要连续处理一批，刷新会把筛选与滚动位置一起丢掉。
   */
  async function reject(taskId: string) {
    if (rows[taskId]?.busy) return;

    // 前端先拦一次空原因：省一次往返，服务端仍有同样的校验（直接调 API 也要挡住）
    const reason = rejectDraft.trim();
    if (reason.length === 0) {
      updateRow(taskId, { notice: '请填写退回原因' });
      return;
    }

    updateRow(taskId, { busy: true, notice: null });

    let status: number;
    try {
      const response = await fetch(`/api/tasks/${taskId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      status = response.status;
    } catch {
      updateRow(taskId, { busy: false, notice: ACTION_FAILED_NOTICE });
      return;
    }

    if (status === 200) {
      updateRow(taskId, { busy: false, status: 'rejected', rejectReason: reason });
      setRejectTarget(null);
      setRejectDraft('');
      return;
    }

    setRejectTarget(null);
    // 409 多半是标注员刚好重新提交：不能假装退回成功，行状态也不改
    updateRow(taskId, {
      busy: false,
      notice: status === 409 ? REJECT_CONFLICT_NOTICE : ACTION_FAILED_NOTICE,
    });
  }

  if (items.length === 0) {
    return (
      <div className="panel px-4 py-10 text-center">
        <p className="text-[12.5px] text-ink-dim">暂时没有任务</p>
      </div>
    );
  }

  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left">
          <thead>
            <tr className="border-b border-line-soft text-[11px] text-ink-faint">
              <th className="px-4 py-2.5 font-normal">任务</th>
              {showTenant ? <th className="px-3 py-2.5 font-normal">租户</th> : null}
              <th className="px-3 py-2.5 font-normal">时长</th>
              <th className="px-3 py-2.5 font-normal">状态</th>
              <th className="px-3 py-2.5 font-normal">领取人</th>
              <th className="px-4 py-2.5 font-normal">创建日期</th>
              {showActions ? <th className="px-4 py-2.5 text-right font-normal">操作</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((task) => {
              const ui = rows[task.id];
              const status = ui?.status ?? task.status;
              const claimedBy = ui?.claimedBy !== undefined ? ui.claimedBy : task.claimed_by;
              const claimedByName =
                ui?.claimedByName !== undefined ? ui.claimedByName : task.claimed_by_name;
              const rejectReason =
                ui?.rejectReason !== undefined ? ui.rejectReason : task.reject_reason;
              const statusMeta = STATUS[status];
              const busy = ui?.busy ?? false;
              const mine = currentUser !== null && claimedBy === currentUser.id;

              return (
                <Fragment key={task.id}>
                  <tr className="border-b border-line-soft transition-colors hover:bg-panel-2/40">
                    <td className="px-4 py-2.5">
                      {/* 标题是识别任务的主信息；视频名作副行，因为同一段素材常有多个任务 */}
                      <div
                        className="max-w-[320px] truncate text-[12.5px] text-ink"
                        title={task.title}
                      >
                        {task.title}
                      </div>
                      <div
                        className="mt-0.5 max-w-[320px] truncate text-[11px] text-ink-faint"
                        title={task.video_filename}
                      >
                        {task.video_filename}
                      </div>
                    </td>
                    {showTenant ? (
                      <td className="px-3 py-2.5 text-[12px] text-ink-dim">{task.tenant_name}</td>
                    ) : null}
                    <td className="tnum px-3 py-2.5 text-[12px] text-ink-dim">
                      {formatDuration(task.estimated_ms, false)}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`tag ${statusMeta.className}`}>{statusMeta.label}</span>
                      {/* 退回原因就地显示：管理员与标注员都不必再点开一次才知道哪里不合格 */}
                      {status === 'rejected' && rejectReason ? (
                        <div
                          className="mt-1 max-w-[180px] truncate text-[11px] text-bad"
                          title={rejectReason}
                        >
                          {rejectReason}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-ink-dim">
                      {claimedByName ?? '—'}
                    </td>
                    <td className="tnum px-4 py-2.5 text-[12px] text-ink-faint">
                      {localDateOf(task.created_at, timezone)}
                    </td>
                    {showActions ? (
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {currentUser ? (
                            <>
                              {status === 'pending' ? (
                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  disabled={busy}
                                  onClick={() => void act(task.id, 'claim')}
                                >
                                  领取
                                </button>
                              ) : null}

                              {status === 'claimed' && mine ? (
                                <>
                                  <Link className="btn btn-quiet" href={`/tasks/${task.id}/work`}>
                                    继续标注
                                  </Link>
                                  <button
                                    type="button"
                                    className="btn btn-quiet"
                                    disabled={busy}
                                    onClick={() => void act(task.id, 'release')}
                                  >
                                    归还
                                  </button>
                                </>
                              ) : null}

                              {status === 'claimed' && !mine ? (
                                <span className="text-[11.5px] text-ink-faint">进行中</span>
                              ) : null}
                            </>
                          ) : null}

                          {canReject && status === 'submitted' ? (
                            <button
                              type="button"
                              className="btn btn-quiet"
                              disabled={busy}
                              onClick={() => {
                                // 再点一次收起，避免一条列表里开着好几个输入区
                                setRejectTarget(rejectTarget === task.id ? null : task.id);
                                setRejectDraft('');
                                updateRow(task.id, { notice: null });
                              }}
                            >
                              退回
                            </button>
                          ) : null}
                        </div>
                        {ui?.notice ? (
                          <p role="alert" className="mt-1 text-[11px] text-warn">
                            {ui.notice}
                          </p>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>

                  {/* 原因输入另起一行：塞进操作列会把窄表格挤成一条竖排文字 */}
                  {rejectTarget === task.id ? (
                    <tr className="border-b border-line-soft bg-panel-2/40 last:border-0">
                      <td colSpan={columnCount} className="px-4 pb-3">
                        <label
                          className="block text-[11.5px] text-ink-dim"
                          htmlFor={`reject-${task.id}`}
                        >
                          退回原因（必填，不超过 {MAX_REASON_LENGTH} 字）
                        </label>
                        <textarea
                          id={`reject-${task.id}`}
                          className="field mt-1.5 h-16 resize-y"
                          maxLength={MAX_REASON_LENGTH}
                          placeholder="写清哪里不合格，标注员会在自己的任务列表里看到"
                          value={rejectDraft}
                          disabled={busy}
                          onChange={(event) => setRejectDraft(event.target.value)}
                        />
                        <div className="mt-2 flex items-center justify-end gap-2">
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={busy}
                            onClick={() => setRejectTarget(null)}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busy}
                            onClick={() => void reject(task.id)}
                          >
                            确认退回
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 单页时整块不渲染：一个永远点不动的翻页条只是噪音。 */
export function TaskPager({ total, page, pageSize, basePath, query }: TaskPagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  /** 翻页要带上当前查询条件：丢掉 status 会让第 2 页悄悄回到「全部任务」。 */
  function hrefOf(target: number): string {
    const search = new URLSearchParams(query ?? {});
    search.set('page', String(target));
    return `${basePath}?${search.toString()}`;
  }

  return (
    <nav
      className="mt-3 flex items-center justify-end gap-2.5 text-[11.5px] text-ink-faint"
      aria-label="分页"
    >
      <span className="tnum">
        第 {page} / {totalPages} 页
      </span>
      {page > 1 ? (
        <Link className="btn btn-ghost" href={hrefOf(page - 1)}>
          上一页
        </Link>
      ) : null}
      {page < totalPages ? (
        <Link className="btn btn-ghost" href={hrefOf(page + 1)}>
          下一页
        </Link>
      ) : null}
    </nav>
  );
}
