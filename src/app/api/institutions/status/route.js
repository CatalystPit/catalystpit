import { db } from '../../../../lib/db';
import { fundHoldings, fundFilings } from '../../../../lib/schema';
import { sql } from 'drizzle-orm';

export const runtime = 'nodejs';

// Read-only diagnostic (public — aggregate counts of public 13F data). Lets us confirm whether
// the ingestion has written anything, without needing the cron secret. Visit /api/institutions/status.
export async function GET() {
  try {
    const [f] = await db.select({ c: sql`count(*)`.mapWith(Number) }).from(fundFilings);
    const [h] = await db.select({ c: sql`count(*)`.mapWith(Number) }).from(fundHoldings);
    const sample = await db
      .select({ cik: fundFilings.cik, quarter: fundFilings.quarter, holdingsCount: fundFilings.holdingsCount, totalValue: fundFilings.totalValue })
      .from(fundFilings).limit(10);
    return Response.json({ ok: true, filings: f.c, holdings: h.c, sample }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
