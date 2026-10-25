/**
 * 视频列表与上传。
 *
 * 只做请求上下文与 HTTP 契约：取身份、读头、交给 video-service。
 * 大小上限与类型白名单都在 service，避免路由层出现无人测试的业务判断。
 */
import { NextResponse } from 'next/server';
import { requireApiAdmin, requireApiUser } from '@/lib/server/api-guard';
import { requireSameOrigin } from '@/lib/server/require-same-origin';
import { getDb } from '@/lib/server/db';
import { ValidationError, toErrorResponse } from '@/lib/errors';
import { listVisibleVideos, storeVideo, type UploadInput } from '@/lib/services/video-service';

// 上传落盘用 fs 流，Edge runtime 没有文件系统
export const runtime = 'nodejs';

const DURATION_HEADER = 'x-duration-ms';
const FILENAME_HEADER = 'x-filename';

type VideoSummary = {
  id: string;
  filename: string;
  sizeBytes: number;
  durationMs: number;
  createdAt: number;
};

/** 对外 DTO：storage_path 与 uploaded_by 属于内部实现，不出网。 */
function toSummary(video: {
  id: string;
  filename: string;
  size_bytes: number;
  duration_ms: number;
  created_at: number;
}): VideoSummary {
  return {
    id: video.id,
    filename: video.filename,
    sizeBytes: video.size_bytes,
    durationMs: video.duration_ms,
    createdAt: video.created_at,
  };
}

function errorResponse(err: unknown): NextResponse {
  const { status, body } = toErrorResponse(err);
  return NextResponse.json(body, { status });
}

/**
 * x-filename 由客户端 encodeURIComponent：HTTP 头只能放 ASCII，中文名直接写会抛错。
 * 解码失败说明头被手工改坏，退回空串交给 service 的默认名，不让 %E4%.. 进库展示。
 */
function decodeFilename(raw: string | null): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

/**
 * 从头里取出上传参数。filename 只是展示名，不参与落盘路径；
 * 缺 content-length 时按 0 交给 service，实际字节数由流式写入统计。
 */
function readUploadInput(request: Request): UploadInput {
  const durationText = request.headers.get(DURATION_HEADER);
  if (!durationText) throw new ValidationError('缺少视频时长');
  const durationMs = Number(durationText);
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new ValidationError('视频时长不合法');
  }

  const stream = request.body;
  if (!stream) throw new ValidationError('请求体为空');

  const declaredSize = Number(request.headers.get('content-length') ?? '');
  return {
    filename: decodeFilename(request.headers.get(FILENAME_HEADER)),
    mimeType: request.headers.get('content-type') ?? '',
    sizeBytes: Number.isFinite(declaredSize) ? declaredSize : 0,
    durationMs,
    stream,
  };
}

export async function POST(request: Request) {
  try {
    const actor = await requireApiAdmin();
    requireSameOrigin(request);
    const video = await storeVideo(getDb(), actor, readUploadInput(request));
    return NextResponse.json({ ok: true, video: toSummary(video) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET() {
  try {
    const actor = await requireApiUser();
    const videos = listVisibleVideos(getDb(), actor).map(toSummary);
    return NextResponse.json({ ok: true, videos });
  } catch (err) {
    return errorResponse(err);
  }
}
