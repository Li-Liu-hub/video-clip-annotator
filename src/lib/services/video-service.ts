/**
 * 视频上传与读取的业务规则：类型白名单、大小上限、流式落盘、可见性判定。
 *
 * 不 import next/headers —— 文件根目录与数据库都由调用方注入，本层可在临时目录上单测。
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform, Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { nowMs, type DB } from '@/lib/db';
import { newId } from '@/lib/db/id';
import { readMp4Duration } from '@/lib/mp4-duration';
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

/**
 * 时长上限 4 小时。
 *
 * 它是「工作量以毫秒计」这套账本的最后一道闸门：4 小时的视频标满也只有 4 小时，
 * 而一个声明成 999 小时的素材足以把整个租户的账彻底搞乱，且在统计上看不出来。
 */
export const MAX_VIDEO_DURATION_MS = 4 * 60 * 60 * 1000;

/** 客户端声明的时长与服务端解析值的允许偏差。取 2 秒：容忍容器与播放器的取整差，不容忍数量级造假。 */
export const DURATION_TOLERANCE_MS = 2_000;

const DEFAULT_FILENAME = '未命名.mp4';
const UNSUPPORTED_MIME_MESSAGE = '仅支持 MP4 视频';
const EMPTY_BODY_MESSAGE = '上传内容为空';
const UNREADABLE_DURATION_MESSAGE = '无法读取视频时长，请确认文件是完整可播放的 MP4';
const DURATION_MISMATCH_MESSAGE = '客户端声明的视频时长与文件实际时长不一致';
const MAX_DURATION_HOURS = MAX_VIDEO_DURATION_MS / (60 * 60 * 1000);

export type UploadInput = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /**
   * 客户端声明的时长。只作交叉校验 —— 落库的 estimated_ms 用服务端解析值，
   * 否则这个字段依然是上传方一句话决定工作量。
   */
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
 * 流式写进临时文件，再从落盘的字节解析真实时长。
 *
 * 为什么写盘之后再读：moov 可能在文件尾（未开 faststart 的编码器），
 * 边收边判会把合法文件误拒；一次读入内存的代价受 MAX_VIDEO_BYTES 约束。
 * 为什么解析失败直接抛错而不回落到客户端声明值：回落到声明值等于这道闸门不存在。
 *
 * 任何失败都删掉临时文件，否则磁盘上留下无人引用的 .part。
 */
async function writeTempAndResolveDuration(
  input: UploadInput,
  tempPath: string,
): Promise<{ durationMs: number; sizeBytes: number }> {
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
    if (written === 0) throw new ValidationError(EMPTY_BODY_MESSAGE);

    const parsed = readMp4Duration(await readFile(tempPath));
    if (!parsed.ok) throw new ValidationError(UNREADABLE_DURATION_MESSAGE);
    if (parsed.durationMs > MAX_VIDEO_DURATION_MS) {
      throw new ValidationError(`视频时长不能超过 ${MAX_DURATION_HOURS} 小时`);
    }
    // 偏差过大说明要么客户端撒谎，要么文件与声明不是同一个（传了一半、被换过）
    if (Math.abs(parsed.durationMs - input.durationMs) > DURATION_TOLERANCE_MS) {
      throw new ValidationError(DURATION_MISMATCH_MESSAGE);
    }
    return { durationMs: parsed.durationMs, sizeBytes: written };
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }
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
  // 声明值本身仍须是正整数：它要参与交叉校验，缺了就没法判断文件与声明是否一致
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

  const { durationMs, sizeBytes } = await writeTempAndResolveDuration(input, tempPath);
  try {
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
    size_bytes: sizeBytes,
    // 用服务端解析值而非客户端声明值：声明值只做交叉校验，落库以文件为准，
    // 否则「解析了但没用上」，造假只需把声明值控制在 2 秒容差内就能写进库里
    duration_ms: durationMs,
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
