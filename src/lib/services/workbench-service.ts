/**
 * 工作台读取：只放行「自己领取、claimed 或已提交」的任务。
 *
 * 四种拒绝（未领取 / 别人领取 / 其他租户 / 已退回）合并为同一个 NotFoundError：
 * 分开回不同状态码，就等于承认「这条任务确实存在」。
 * 已提交放行是为了只读回顾（E8）：能看内容，改不了片段。
 *
 * 归属与状态的判定不在这里重写：requireReadableTask 是唯一一份。
 * 抄一遍的代价是「工作台能开、片段列表 404」这类静默分叉 —— 改状态机时只改一处。
 */
import { withBasePath } from '@/lib/base-path';
import type { DB } from '@/lib/db';
import type { TenantUser } from './auth-service';
import { requireReadableTask } from './segment-service';

export type WorkTask = {
  id: string;
  title: string;
  description: string | null;
  status: 'claimed' | 'submitted';
  durationMs: number;
  videoFilename: string;
  streamUrl: string;
  /**
   * 上一轮退回的原因。只在「退回后重新打开」时非空，提交后清空。
   *
   * 必须由服务端带下来：TaskList 只在 status='rejected' 时显示原因，
   * 重新打开后状态已是 claimed —— 不带下来的话，标注员打开工作台就看不到要改什么了。
   */
  rejectReason: string | null;
};

/**
 * 播放地址在 service 里拼定。
 *
 * 客户端组件不拼路径：流式路由一旦改名，散在组件里的拼法会漏改；
 * 也不签临时 token —— 同源的 <video src> 天然带 Cookie，接口按 session 鉴权。
 */
function streamUrlOf(videoId: string): string {
  return withBasePath(`/api/videos/${videoId}/stream`);
}

/** 取工作台任务。不是自己领取的、状态不对的，一律 NotFoundError。 */
export function getWorkTask(db: DB, actor: TenantUser, taskId: string): WorkTask {
  const task = requireReadableTask(db, actor, taskId);

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    durationMs: task.estimated_ms,
    rejectReason: task.reject_reason,
    videoFilename: task.video_filename,
    streamUrl: streamUrlOf(task.video_id),
  };
}
