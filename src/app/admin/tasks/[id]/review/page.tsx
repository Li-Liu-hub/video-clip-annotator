/** 管理员提交审核页：冻结片段播放、版本回顾与退回。 */
import { notFound } from 'next/navigation';
import PageHeader from '@/components/page-header';
import { NotFoundError } from '@/lib/errors';
import { getDb } from '@/lib/server/db';
import { requireAdmin } from '@/lib/server/guards';
import { getTaskReview } from '@/lib/services/review-query-service';
import ReviewPlayer from './ReviewPlayer';

export const metadata = { title: '审核提交 · 片段标注' };

export default async function ReviewPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string; returnPage?: string; status?: string }>;
}) {
  const actor = await requireAdmin();
  const { id } = await params;
  const query = await searchParams;
  let review;
  try { review = getTaskReview(getDb(), actor, id); } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const page = Number(query.returnPage);
  const back = new URLSearchParams();
  if (Number.isInteger(page) && page > 1) back.set('page', String(page));
  if (query.status === 'submitted' || query.status === 'rejected') back.set('status', query.status);
  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader title={review.title} description={`${review.tenantName} · ${review.videoFilename}`}
        back={{ href: `/admin/tasks${back.size ? `?${back}` : ''}`, label: '任务列表' }} />
      <ReviewPlayer key={id} review={review} timezone={actor.timezone} initialDate={query.date} />
    </div>
  );
}
