/**
 * 视频上传与读取的业务规则：类型白名单、大小上限、流式落盘、可见性判定。
 *
 * 不 import next/headers —— 文件根目录与数据库都由调用方注入，本层可在临时目录上单测。
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform, Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { nowMs, type DB } from '@/lib/db';
import { newId } from '@/lib/db/id';
import {
  findById,
  findVisibleToTenant,
  insertVideo,
  listAll,
  listVisibleToTenant,
  type VideoRow,
} from '@/lib/db/repos/video-repo';
import { NotFoundError, PayloadTooLargeError, ValidationError } from '@/lib/errors';
import { MAX_VIDEO_BYTES, SUPPORTED_MIME_EXTENSIONS } from '@/lib/video-limits';
import { isTenantUser, type SessionUser } from './auth-service';

// 契约要求常量从本模块导出；实现放在 lib/video-limits，客户端上传逻辑才能不引 service 而取到同一个值
export { MAX_VIDEO_BYTES };

const DEFAULT_FILENAME = '未命名.mp4';
const UNSUPPORTED_MIME_MESSAGE = '仅支持 MP4 视频';

export type UploadInput = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  stream: ReadableStream<Uint8Array>;
};

/**
 * 落盘根目录。每次调用才读 env：测试要在模块导入之后把目录指到 tmpdir，
 * 模块级常量做不到这件事。
 */
function videoRoot(): string {
  return process.env.VIDEO_DIR ?? path.join(process.cwd(), 'data', 'videos');
}

/** 磁盘绝对路径。storage_path 由本模块按 id 生成，不含用户输入。 */
export function videoFilePath(video: VideoRow): string {
  return path.join(videoRoot(), video.storage_path);
}

/** Content-Type 可能带 `; codecs=...` 参数，取主类型再查白名单。 */
function resolveMime(mimeType: string): { mimeType: string; extension: string } {
  const normalized = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  const extension = SUPPORTED_MIME_EXTENSIONS[normalized];
  if (!extension) throw new ValidationError(UNSUPPORTED_MIME_MESSAGE);
  return { mimeType: normalized, extension };
}

/**
 * 写盘并落库。调用方必须已确认是管理员。
 *
 * 返回 Promise 是契约的必然结果：真流式写盘只能 await pipeline，
 * 同步返回就得把整个文件读进内存，正是本功能点要避免的做法。
 */
export async function storeVideo(
  db: DB,
  actor: SessionUser,
  input: UploadInput,
): Promise<VideoRow> {
  const { mimeType, extension } = resolveMime(input.mimeType);
  if (!Number.isInteger(input.durationMs) || input.durationMs <= 0) {
    throw new ValidationError('缺少有效的视频时长');
  }
  // 声明的长度只用于快速拒绝；真正的上限按实际写出的字节数执行（见下方 Transform）
  if (input.sizeBytes > MAX_VIDEO_BYTES) throw new PayloadTooLargeError();

  const id = newId();
  const storedName = `${id}.${extension}`;
  const root = videoRoot();
  const finalPath = path.join(root, storedName);
  const tempPath = `${finalPath}.part`;

  await mkdir(root, { recursive: true });

  let written = 0;
  try {
    await pipeline(
      Readable.fromWeb(input.stream as unknown as NodeReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
          written += chunk.length;
          if (written > MAX_VIDEO_BYTES) {
            callback(new PayloadTooLargeError());
            return;
          }
          callback(null, chunk);
        },
      }),
      createWriteStream(tempPath),
    );
    if (written === 0) throw new ValidationError('上传内容为空');
    // 先写 .part 再 rename：中途失败留下的不是「半个正常文件」，
    // 否则库里记的长度与实际字节数不符，浏览器会一直等待剩下的字节
    await rename(tempPath, finalPath);
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }

  const row: VideoRow = {
    id,
    filename: input.filename.trim() || DEFAULT_FILENAME,
    storage_path: storedName,
    // 以实际写出的字节数为准：声明的 content-length 可短报，库里存错会让 Range 全错
    size_bytes: written,
    duration_ms: input.durationMs,
    mime_type: mimeType,
    uploaded_by: actor.id,
    created_at: nowMs(),
  };

  try {
    insertVideo(db, row);
  } catch (err) {
    // 落库失败则删掉已落盘的文件，否则磁盘上留下无人引用的孤儿
    await rm(finalPath, { force: true });
    throw err;
  }
  return row;
}

/**
 * 取可播放的视频。无权限与不存在都抛 NotFoundError，不泄露存在性。
 *
 * 管理员看全部；标注员仅当本租户有任务引用该视频时可看。
 */
export function openVideoForRead(db: DB, actor: SessionUser, videoId: string): VideoRow {
  const row =
    actor.role === 'admin'
      ? findById(db, videoId)
      : isTenantUser(actor)
        ? findVisibleToTenant(db, actor.tenantId, videoId)
        : null;
  if (!row) throw new NotFoundError('视频不存在');
  return row;
}

/** 列表的可见性规则与单条读取一致：管理员全部，标注员按任务归属。 */
export function listVisibleVideos(db: DB, actor: SessionUser): VideoRow[] {
  if (actor.role === 'admin') return listAll(db);
  return isTenantUser(actor) ? listVisibleToTenant(db, actor.tenantId) : [];
}
