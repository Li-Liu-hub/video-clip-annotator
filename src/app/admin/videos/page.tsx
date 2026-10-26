/**
 * 管理员视频页：服务端取全量视频，上传与列表交互交给客户端组件。
 *
 * 守卫在页面里再调一次（布局已判角色）：本页需要 actor 去调 service，
 * 顺便让「这个页面本身必须管理员」不依赖布局的间接保护。
 */
import type { Metadata } from 'next';
import PageHeader from '@/components/page-header';
import { getDb } from '@/lib/server/db';
import { requireAdmin } from '@/lib/server/guards';
import { listVisibleVideos } from '@/lib/services/video-service';
import type { VideoSummary } from '@/lib/video-upload';
import VideoManager from './VideoManager';

export const metadata: Metadata = { title: '视频管理 · 片段标注' };

export default async function AdminVideosPage() {
  const actor = await requireAdmin();
  // 只映射展示字段：storage_path 与 uploaded_by 是内部实现，不进页面 props
  const videos: VideoSummary[] = listVisibleVideos(getDb(), actor).map((video) => ({
    id: video.id,
    filename: video.filename,
    sizeBytes: video.size_bytes,
    durationMs: video.duration_ms,
    createdAt: video.created_at,
  }));

  return (
    <div className="mx-auto max-w-[1080px]">
      <PageHeader
        title="视频"
        description="上传机器人示教视频。时长与大小随视频落库，创建任务时直接引用。"
        actions={
          <span className="tnum text-[11.5px] text-ink-faint">共 {videos.length} 个素材</span>
        }
      />

      <VideoManager initialVideos={videos} timezone={actor.timezone} />
    </div>
  );
}
