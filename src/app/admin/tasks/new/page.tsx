/**
 * 新建任务页（/admin/tasks/new）：服务端取视频与租户选项，交互交给客户端表单。
 *
 * 守卫在这里再调一次（布局已判角色）：本页需要 actor 去调 service，
 * 也让「这个页面本身必须管理员」不依赖布局的间接保护。
 */
import type { Metadata } from 'next';
import PageHeader from '@/components/page-header';
import { getDb } from '@/lib/server/db';
import { requireAdmin } from '@/lib/server/guards';
import { listTenantOptions } from '@/lib/services/task-service';
import { listVisibleVideos } from '@/lib/services/video-service';
import TaskForm, { type TenantOption, type VideoOption } from './TaskForm';

export const metadata: Metadata = { title: '新建任务 · 片段标注' };

type Props = { searchParams: Promise<{ videoId?: string | string[] }> };

export default async function NewTaskPage({ searchParams }: Props) {
  const actor = await requireAdmin();
  const params = await searchParams;
  const db = getDb();

  // 只映射展示字段：storage_path 与 uploaded_by 属内部实现，不进页面 props
  const videos: VideoOption[] = listVisibleVideos(db, actor).map((video) => ({
    id: video.id,
    filename: video.filename,
    durationMs: video.duration_ms,
    sizeBytes: video.size_bytes,
  }));
  const tenants: TenantOption[] = listTenantOptions(db);
  const requestedVideoId = typeof params.videoId === 'string' ? params.videoId : null;
  const initialVideoId = videos.some((video) => video.id === requestedVideoId)
    ? requestedVideoId
    : null;

  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="新建任务"
        description="选一个视频，勾选需要标注的空间。每个空间各得一条待领取任务，全部成功或全部不落库。"
        back={{ href: '/admin/tasks', label: '任务列表' }}
        actions={<span className="tnum text-[11.5px] text-ink-faint">一次发布给多个租户</span>}
      />

      <TaskForm videos={videos} tenants={tenants} initialVideoId={initialVideoId} />
    </div>
  );
}
