/**
 * 工作台读取：只放行「自己领取、尚未提交」的任务。
 *
 * 四种拒绝（未领取 / 别人领取 / 其他租户 / 已提交）合并为同一个 NotFoundError：
 * 分开回不同状态码，就等于承认「这条任务确实存在」。
 */
import type { DB } from '@/lib/db';
import { findByIdForTenant } from '@/lib/db/repos/task-repo';
import { NotFoundError } from '@/lib/errors';
import type { TenantUser } from './auth-service';

export type WorkTask = {
  id: string;
  title: string;
  description: string | null;
  status: 'claimed';
  durationMs: number;
  videoFilename: string;
  streamUrl: string;
};

const TASK_NOT_FOUND_MESSAGE = '任务不存在';

/**
 * 播放地址在 service 里拼定。
 *
 * 客户端组件不拼路径：流式路由一旦改名，散在组件里的拼法会漏改；
 * 也不签临时 token —— 同源的 <video src> 天然带 Cookie，接口按 session 鉴权。
 */
function streamUrlOf(videoId: string): string {
  return `/api/videos/${videoId}/stream`;
}

/** 取工作台任务。不是自己领取的、状态不对的，一律 NotFoundError。 */
export function getWorkTask(db: DB, actor: TenantUser, taskId: string): WorkTask {
  const task = findByIdForTenant(db, taskId, actor.tenantId);
  if (!task) throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);

  // pending 没有归属、submitted 属于 E3 的只读回顾、同租户同事领取的任务不该被看到：
  // 三种情形对外都必须是 404，因此合成一个条件，避免以后有人给其中一种补回 403。
  if (task.status !== 'claimed' || task.claimed_by !== actor.id) {
    throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
  }

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: 'claimed',
    durationMs: task.estimated_ms,
    videoFilename: task.video_filename,
    streamUrl: streamUrlOf(task.video_id),
  };
}
