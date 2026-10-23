/**
 * 视频播放：每次请求校验身份后按 Range 返回字节。
 *
 * 不做静态目录，是因为静态资源知道 URL 就能下载，租户隔离会形同虚设；
 * 代价是 Range 必须自己实现，否则视频能播但拖不动进度条。
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { requireApiUser } from '@/lib/server/api-guard';
import { getDb } from '@/lib/server/db';
import { toErrorResponse } from '@/lib/errors';
import { openVideoForRead, videoFilePath } from '@/lib/services/video-service';
import { parseRange } from '@/lib/video-range';

// Edge runtime 没有 fs，本路由必须在 Node 上跑
export const runtime = 'nodejs';

/** Node 流的 Web 版交给 Response 作为响应体；toWeb 的返回类型是宽泛的 any 流，此处收窄 */
function toBodyStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireApiUser();
    const { id } = await context.params;
    const video = openVideoForRead(getDb(), actor, id);

    const size = video.size_bytes;
    const path = videoFilePath(video);
    const baseHeaders = {
      'Content-Type': video.mime_type,
      'Accept-Ranges': 'bytes',
      // 鉴权后的私有内容，禁止任何共享缓存把它发给其他租户
      'Cache-Control': 'private, no-store',
    };

    const range = parseRange(request.headers.get('range'), size);

    if (range.kind === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
      });
    }

    if (range.kind === 'full') {
      return new Response(toBodyStream(createReadStream(path)), {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(size) },
      });
    }

    return new Response(
      // createReadStream 的 end 是闭区间，与 parseRange 的语义一致
      toBodyStream(createReadStream(path, { start: range.start, end: range.end })),
      {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
          // 段长而非文件总长：写成总长浏览器读满后继续等，进度条卡在开头
          'Content-Length': String(range.end - range.start + 1),
        },
      },
    );
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
