import { recentCandidates, mode } from '../../../../lib/x-publisher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Operator-only inspection of what Catalyst Pit WOULD have posted.
//
// NOT public. It requires the same bearer secret the cron routes use, sends `noindex` and
// `no-store`, and returns 401 with no body detail when the secret is absent or wrong. It is
// read-only: there is no way to publish, edit or delete a candidate through it.
const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  const auth = request.headers.get('authorization');
  const key = new URL(request.url).searchParams.get('key');
  const ok = CRON_SECRET && (auth === `Bearer ${CRON_SECRET}` || key === CRON_SECRET);
  if (!ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const limit = Number(new URL(request.url).searchParams.get('limit') || 50);
  const rows = await recentCandidates(limit);
  return Response.json({
    mode: mode(),
    liveCallsMade: 0,
    count: rows.length,
    candidates: rows.map((r) => ({
      timestamp: r.created_at,
      eventPublishedAt: r.published_at,
      canonicalEventSeq: String(r.event_seq),
      canonicalHeadline: r.headline,
      sourcesMerged: r.source_count,
      eligibility: r.reason,
      impact: r.impact,
      ticker: r.ticker,
      shape: r.shape,
      proposedText: r.post_text,
      charCount: r.char_count,
      status: r.status,
      attempts: r.attempts,
      xPostId: r.x_post_id,
      failureReason: r.failure_reason,
    })),
  }, { headers: { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
}
