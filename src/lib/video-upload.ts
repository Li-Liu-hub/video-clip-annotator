/**
 * 浏览器端的视频上传：上传前预检、读取时长、带进度的 XHR 上传。
 *
 * 上限与 MIME 白名单来自 lib/video-limits（纯常量模块）。
 * 不能从 video-service 取：那个模块依赖 node:fs，被浏览器 bundle 引用会在导入期失败。
 */
import { ACCEPTED_MIME, MAX_VIDEO_BYTES } from '@/lib/video-limits';

const MAX_UPLOAD_MB = MAX_VIDEO_BYTES / 1024 / 1024;
const DURATION_ERROR = '无法读取视频时长，请确认文件是完整可播放的 MP4';

export type FileCheck =
  | { ok: true }
  | { ok: false; reason: 'too-large' | 'bad-type' | 'empty' };

export type VideoSummary = {
  id: string;
  filename: string;
  sizeBytes: number;
  durationMs: number;
  createdAt: number;
};

/**
 * 纯函数，不碰 DOM。返回判别联合而不是文案：
 * 三种原因的提示语只由 UI 一处映射，服务端与组件不会各写一套。
 */
export function checkFile(file: { size: number; type: string }): FileCheck {
  // 空文件先判：它本来也不可能有合法时长，报「空文件」更贴近要修的事
  if (file.size <= 0) return { ok: false, reason: 'empty' };
  if (file.size > MAX_VIDEO_BYTES) return { ok: false, reason: 'too-large' };
  if (!ACCEPTED_MIME.some((mime) => mime === file.type)) return { ok: false, reason: 'bad-type' };
  return { ok: true };
}

/** 可用的时长：Infinity 与 0 都不能作为 x-duration-ms 上报（服务端会按 NaN / 非正数拒绝）。 */
function isUsableDuration(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds > 0;
}

/**
 * 读取视频时长（毫秒）。浏览器 API，单测覆盖不到，靠手工验收。
 *
 * moov atom 在尾部的 MP4 会让 duration 先返回 Infinity；
 * 此时 seek 到一个极大时间点，逼浏览器解析到文件尾再取真实时长。
 */
export function readDurationMs(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;

    const finish = (seconds: number) => {
      if (settled) return;
      settled = true;
      video.onloadedmetadata = null;
      video.ontimeupdate = null;
      video.onerror = null;
      URL.revokeObjectURL(url);
      resolve(Math.round(seconds * 1000));
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      video.onloadedmetadata = null;
      video.ontimeupdate = null;
      video.onerror = null;
      // 失败路径同样要释放：否则每选一个坏文件就漏一个 blob
      URL.revokeObjectURL(url);
      reject(new Error(DURATION_ERROR));
    };

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      if (isUsableDuration(video.duration)) {
        finish(video.duration);
        return;
      }
      if (Number.isFinite(video.duration)) {
        fail();
        return;
      }
      video.ontimeupdate = () => {
        video.ontimeupdate = null;
        if (isUsableDuration(video.duration)) finish(video.duration);
        else fail();
      };
      try {
        // 1e101 而非 video.duration：Infinity 无法用于定位，极大值会被浏览器钳到可解析范围
        video.currentTime = 1e101;
      } catch {
        fail();
      }
    };
    video.onerror = fail;
    video.src = url;
  });
}

export type UploadHandle = { promise: Promise<VideoSummary>; abort: () => void };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 响应体在边界上解析：非 JSON（代理错误页）不得抛 SyntaxError 冒到 UI 之外。 */
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorMessageOf(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const message = body.error.message;
  return typeof message === 'string' && message !== '' ? message : null;
}

function summaryOf(body: unknown): VideoSummary | null {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.video)) return null;
  const { id, filename, sizeBytes, durationMs, createdAt } = body.video;
  if (typeof id !== 'string' || typeof filename !== 'string') return null;
  if (!isFiniteNumber(sizeBytes) || !isFiniteNumber(durationMs) || !isFiniteNumber(createdAt)) {
    return null;
  }
  return { id, filename, sizeBytes, durationMs, createdAt };
}

/** 服务端未给中文 message 时的兜底（网关 502 之类不会带项目的错误体）。 */
function statusMessage(status: number): string {
  if (status === 401) return '登录已过期，请重新登录后再上传';
  if (status === 403) return '只有管理员可以上传视频';
  if (status === 413) return `视频超过 ${MAX_UPLOAD_MB} MB 上限`;
  return `上传失败（HTTP ${status}），请稍后重试`;
}

/**
 * 用 XMLHttpRequest 而非 fetch：fetch 的 body 是下载流，上行字节不可观测，
 * 只有 xhr.upload.onprogress 能给进度。这是 API 能力边界，不是风格偏好。
 */
export function uploadVideo(
  file: File,
  durationMs: number,
  onProgress: (ratio: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();

  const promise = new Promise<VideoSummary>((resolve, reject) => {
    xhr.upload.onprogress = (event) => {
      // lengthComputable 为 false 时 total 为 0，相除得 NaN，进度条宽度会变成 NaN%
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };

    xhr.onload = () => {
      const body = parseBody(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        const video = summaryOf(body);
        if (video) {
          resolve(video);
          return;
        }
        reject(new Error('服务器返回的数据不完整，请刷新页面确认是否已上传'));
        return;
      }
      reject(new Error(errorMessageOf(body) ?? statusMessage(xhr.status)));
    };
    xhr.onerror = () => reject(new Error('网络异常，上传失败，请检查连接后重试'));
    xhr.ontimeout = () => reject(new Error('上传超时，请重试'));
    xhr.onabort = () => reject(new Error('已取消上传'));

    xhr.open('POST', '/api/videos');
    xhr.setRequestHeader('Content-Type', file.type);
    // HTTP 头必须是 ASCII：中文文件名直接写入会抛错或乱码，服务端按约定解码
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('x-duration-ms', String(Math.round(durationMs)));
    xhr.send(file);
  });

  return { promise, abort: () => xhr.abort() };
}
