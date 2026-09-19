import { and, isNotNull, gt, desc } from 'drizzle-orm';
import { db } from '../../../lib/db';
import { screenerStocks } from '../../../lib/schema';

export const runtime = 'nodejs';

// Screener rows change when the screener rebuilds, not per request, and nothing here varies by
// viewer — so `private, no-store` was making every homepage visit re-query Postgres for data that
// was identical for everyone. 300s with a 900s stale window matches what the heatmap performance
// route already uses; the two surfaces read the same universe and should not disagree on freshness.
const CACHED = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' };
// A failure must not be cached, or one bad query is served to everyone for five minutes.
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Market heat map data — the largest names by market cap with sector + change %, grouped client-side
// into a sector treemap. Straight from our own screener_stocks universe (no external feed).
export async function GET(request) {
  try {
    const sp = new URL(request.url).searchParams;
    const limit = Math.min(400, Math.max(30, parseInt(sp.get('limit') || '180', 10) || 180));
    const rows = await db.select({
      ticker: screenerStocks.ticker, company: screenerStocks.company, sector: screenerStocks.sector,
      marketCap: screenerStocks.marketCap, changePct: screenerStocks.changePct,
    }).from(screenerStocks)
      .where(and(isNotNull(screenerStocks.marketCap), gt(screenerStocks.marketCap, 0)))
      .orderBy(desc(screenerStocks.marketCap)).limit(limit);
    return Response.json({ rows: rows.filter((r) => r.ticker) }, { headers: CACHED });
  } catch (e) {
    // Two changes, both about not lying to the caller:
    //   · the raw e.message went to the client, which is our database's words in a public response;
    //   · status 200 with rows: [] made a failed query indistinguishable from an empty market, so a
    //     broken heatmap rendered as a blank one and nothing anywhere said why.
    // The client still gets a usable shape and can show its empty state, but 503 is the truth and it
    // is what a health check can see.
    console.error(`[api/heatmap] query failed: ${e.message}`);
    return Response.json({ rows: [], error: 'heatmap_unavailable' }, { status: 503, headers: NO_STORE });
  }
}
