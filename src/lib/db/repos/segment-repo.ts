/**
 * segments 表读写：按任务列出、插入、删除。
 *
 * tenant_id 在 segments 里是刻意的冗余列，这里每条 SQL 都带它 —— 即使 task_id 已能定位，
 * 少写一次 join 就少一次「忘了加租户条件」的机会。
 */
import type { DB } from '@/lib/db';
import { OverlapError, ValidationError } from '@/lib/errors';

/** 库里的原始行（snake_case）。转换到领域字段在 service 层完成，与 TaskRow 的做法一致。 */
export type SegmentRecord = {
  id: string;
  start_ms: number;
  end_ms: number;
  label: string | null;
};

export type SegmentInsert = {
  id: string;
  taskId: string;
  tenantId: string;
  startMs: number;
  endMs: number;
  label: string | null;
  createdAt: number;
};

const OVERLAP_MESSAGE = '这个片段与已标注的区间重叠';

/** better-sqlite3 把约束失败挂在 err.code 上；触发器用 RAISE(ABORT,'OVERLAP') 抛的是普通 Error。 */
function isConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof err.code === 'string' &&
    err.code.startsWith('SQLITE_CONSTRAINT')
  );
}

function isOverlapViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('OVERLAP');
}

/**
 * 按起点升序列出某任务的片段。
 *
 * 同起点不可能同时存在（触发器保证不重叠），补 id 只为让顺序在任何实现上都确定。
 */
export function listByTask(db: DB, tenantId: string, taskId: string): SegmentRecord[] {
  return db
    .prepare(
      `SELECT id, start_ms, end_ms, label
         FROM segments
        WHERE task_id = ? AND tenant_id = ?
        ORDER BY start_ms ASC, id ASC`,
    )
    .all(taskId, tenantId) as SegmentRecord[];
}

/**
 * 插入一条片段。
 *
 * 触发器抛的是消息为 'OVERLAP' 的 SQLITE 错误，在这里译成 OverlapError：
 * 直接冒泡会让路由层按非 AppError 处理，客户端收到 500，无法区分「重叠」与「服务器炸了」。
 * RULES 要求 SQLITE_CONSTRAINT 于 repo 层译成领域错误，故译在此处而非 service。
 */
export function insertSegment(db: DB, row: SegmentInsert): void {
  try {
    db.prepare(
      `INSERT INTO segments (id, task_id, tenant_id, start_ms, end_ms, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.taskId,
      row.tenantId,
      row.startMs,
      row.endMs,
      row.label,
      row.createdAt,
    );
  } catch (err) {
    if (isOverlapViolation(err)) throw new OverlapError(undefined, OVERLAP_MESSAGE, { cause: err });
    // 正常路径已被 normalizeSegments 拦下，走到这里说明校验与写入之间数据被改坏
    if (isConstraintViolation(err)) throw new ValidationError('片段区间不合法', { cause: err });
    throw err;
  }
}

/**
 * 删除一条片段，返回是否命中。
 *
 * task_id 与 tenant_id 双谓词都不能省：只按 id 删，等于把「归属校验」的责任
 * 全部推给调用方，任何一个新接口漏判就能删掉别人的片段。
 */
export function deleteById(
  db: DB,
  tenantId: string,
  taskId: string,
  segmentId: string,
): boolean {
  const result = db
    .prepare('DELETE FROM segments WHERE id = ? AND task_id = ? AND tenant_id = ?')
    .run(segmentId, taskId, tenantId);
  return result.changes > 0;
}
