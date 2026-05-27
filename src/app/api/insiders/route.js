import { db } from '../../../lib/db';
import { insiderTrades } from '../../../lib/schema';
import { desc, eq } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = searchParams.get('ticker')?.toUpperCase().trim() || null;
    const limitRaw = parseInt(searchParams.get('limit') ?? '200', 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 200, 1), 1000);

    let q = db.select().from(insiderTrades);
    if (ticker) q = q.where(eq(insiderTrades.ticker, ticker));
    q = q.orderBy(desc(insiderTrades.filingDate), desc(insiderTrades.transactionDate)).limit(limit);

    const trades = await q;
    console.log(`[insiders_api] ticker=${ticker ?? 'ALL'} limit=${limit} returned=${trades.length}`);
    return Response.json({ trades, count: trades.length, ticker, limit });
  } catch (e) {
    console.log(`[insiders_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
