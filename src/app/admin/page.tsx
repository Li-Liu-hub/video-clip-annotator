/** /admin 根路径：暂无独立总览页，直接进视频管理。 */
import { redirect } from 'next/navigation';

export default function AdminHome() {
  redirect('/admin/videos');
}
