import { and, isNotNull, gt, desc } from 'drizzle-orm';
import { db } from '../../../lib/db';
import { screenerStocks } from '../../../lib/schema';

export const runtime = 'nodejs';
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
    return Response.json({ rows: rows.filter((r) => r.ticker) }, { headers: NO_STORE });
  } catch (e) {
    return Response.json({ rows: [], error: e.message }, { status: 200, headers: NO_STORE });
  }
}
