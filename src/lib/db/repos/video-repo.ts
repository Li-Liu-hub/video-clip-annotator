/**
 * videos 表读写。
 *
 * 视频是平台共享资产，表上没有 tenant_id，因此这里没有租户谓词；
 * 但标注员的可见范围仍由任务归属决定，查询带 EXISTS(tasks.tenant_id)，
 * 避免「拿到 id 就能看」。
 */
import type { DB } from '@/lib/db';
import { ValidationError } from '@/lib/errors';

export type VideoRow = {
  id: string;
  filename: string;
  storage_path: string;
  size_bytes: number;
  duration_ms: number;
  mime_type: string;
  uploaded_by: string;
  created_at: number;
};

const VIDEO_COLUMNS =
  'id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at';

/** better-sqlite3 把约束失败挂在 err.code 上。RULES 要求在 repo 层译成领域错误。 */
function isConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof err.code === 'string' &&
    err.code.startsWith('SQLITE_CONSTRAINT')
  );
}

export function insertVideo(db: DB, video: VideoRow): void {
  try {
    db.prepare(
      `INSERT INTO videos (id, filename, storage_path, size_bytes, duration_ms, mime_type, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      video.id,
      video.filename,
      video.storage_path,
      video.size_bytes,
      video.duration_ms,
      video.mime_type,
      video.uploaded_by,
      video.created_at,
    );
  } catch (err) {
    // 正常路径已校验过时长与字节数，能撞上 CHECK 说明调用方拼错了输入
    if (isConstraintViolation(err)) throw new ValidationError('视频信息不合法', { cause: err });
    throw err;
  }
}

export function findById(db: DB, id: string): VideoRow | null {
  const row = db.prepare(`SELECT ${VIDEO_COLUMNS} FROM videos WHERE id = ?`).get(id);
  return (row as VideoRow | undefined) ?? null;
}

/** 标注员的可读范围：至少有一个本租户任务引用了该视频。 */
export function findVisibleToTenant(db: DB, tenantId: string, id: string): VideoRow | null {
  const row = db
    .prepare(
      `SELECT ${VIDEO_COLUMNS} FROM videos v
        WHERE v.id = ?
          AND EXISTS (SELECT 1 FROM tasks t WHERE t.video_id = v.id AND t.tenant_id = ?)`,
    )
    .get(id, tenantId);
  return (row as VideoRow | undefined) ?? null;
}

/** 管理员列表：全部视频。 */
export function listAll(db: DB): VideoRow[] {
  return db
    .prepare(`SELECT ${VIDEO_COLUMNS} FROM videos ORDER BY created_at DESC, id`)
    .all() as VideoRow[];
}

export function listVisibleToTenant(db: DB, tenantId: string): VideoRow[] {
  return db
    .prepare(
      `SELECT ${VIDEO_COLUMNS} FROM videos v
        WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.video_id = v.id AND t.tenant_id = ?)
        ORDER BY v.created_at DESC, v.id`,
    )
    .all(tenantId) as VideoRow[];
}
