'use client';

/**
 * 审计列表：只读表格，详情就地折叠。
 *
 * 没有删除、也没有编辑入口 —— 一条能被人事后擦掉或补注的审计，就不再是记录而是观点。
 * 不与服务端共享类型：import AuditRow 会把数据层拖进浏览器 bundle，
 * 这里只声明用到的展示字段，页面侧的 AuditRow 与之结构兼容。
 */
import { useState } from 'react';
import {
  actorLabelOf,
  detailPreviewOf,
  targetLabelOf,
  type DetailEntry,
} from '@/lib/audit-display';
import { auditActionLabel } from '@/lib/audit-labels';
import { formatDateTime } from '@/lib/time';

type AuditListItem = {
  id: string;
  createdAt: number;
  actorName: string | null;
  attemptedUsername: string | null;
  action: string;
  targetId: string | null;
  targetTitle: string | null;
  detail: string | null;
};

type AuditTableProps = {
  rows: AuditListItem[];
  /** 租户时区：审计时间按使用者的时区显示到秒 */
  timezone: string;
};



/**
 * detail 是 TEXT 存的 JSON，可能是老格式或手改过的坏串。
 * 解析失败返回 null 由调用方回落到原文：展示层不该因为一条脏数据显示不出来。
 */
function detailEntriesOf(detail: string): DetailEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(detail);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }));
  } catch {
    return null;
  }
}

/** 折叠时的一行摘要：`reason: 200 字的退回原因` 这类长值必须先截断再显示。 */

export default function AuditTable({ rows, timezone }: AuditTableProps) {
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});

  function toggle(id: string) {
    setOpenIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  if (rows.length === 0) {
    return (
      <div className="panel px-4 py-10 text-center">
        <p className="text-[12.5px] text-ink-dim">这段时间没有符合条件的记录</p>
      </div>
    );
  }

  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[840px] text-left">
          <thead>
            <tr className="border-b border-line-soft text-[11px] text-ink-faint">
              <th className="px-4 py-2.5 font-normal">时间</th>
              <th className="px-3 py-2.5 font-normal">谁</th>
              <th className="px-3 py-2.5 font-normal">动作</th>
              <th className="px-3 py-2.5 font-normal">对象</th>
              <th className="px-4 py-2.5 font-normal">详情</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const entries = row.detail === null ? null : detailEntriesOf(row.detail);
              const open = openIds[row.id] === true;

              return (
                <tr key={row.id} className="border-b border-line-soft last:border-0">
                  <td className="tnum whitespace-nowrap px-4 py-2.5 align-top text-[11.5px] text-ink-faint">
                    {formatDateTime(row.createdAt, timezone)}
                  </td>
                  <td className="px-3 py-2.5 align-top text-[12px] text-ink-dim">
                    <div className="max-w-[150px] truncate" title={actorLabelOf(row)}>
                      {actorLabelOf(row)}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 align-top text-[12px] text-ink">
                    <span className="tag">{auditActionLabel(row.action)}</span>
                  </td>
                  <td className="px-3 py-2.5 align-top text-[12px] text-ink-dim">
                    <div className="max-w-[200px] truncate" title={row.targetTitle ?? row.targetId ?? ''}>
                      {targetLabelOf(row)}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 align-top text-[11.5px] text-ink-dim">
                    {row.detail === null ? (
                      <span className="text-ink-faint">{'—'}</span>
                    ) : (
                      <>
                        {open && entries ? (
                          <dl className="space-y-0.5">
                            {entries.map((entry) => (
                              <div key={entry.key} className="flex gap-2">
                                <dt className="shrink-0 text-ink-faint">{entry.key}</dt>
                                <dd className="break-all">{entry.value}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          <p className="max-w-[280px] break-all">
                            {open ? row.detail : detailPreviewOf(row.detail, entries)}
                          </p>
                        )}
                        <button
                          type="button"
                          className="mt-1 text-[11px] text-accent hover:underline"
                          onClick={() => toggle(row.id)}
                        >
                          {open ? '收起' : '展开'}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
