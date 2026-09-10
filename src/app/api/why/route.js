import { and, eq, desc, sql } from 'drizzle-orm';
import { db } from '../../../lib/db';
import { eightkFilings, screenerStocks } from '../../../lib/schema';
import { classifyItems } from '../../../lib/eightk';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// "Why is it moving?" for a single symbol — GROUNDED in actual Catalyst Pit data (recent 8-K + the
// market reaction we already track), never AI speculation. Returns the most recent catalyst filing
// plus reaction context (change %, RVOL, near-high, volume, convergence) for the Terminal panel.
const TICKER_RE = /^[A-Z]{1,5}$/;

export async function GET(request) {
  const symbol = (new URL(request.url).searchParams.get('symbol') || '').toUpperCase().trim();
  if (!TICKER_RE.test(symbol)) return Response.json({ symbol: null, catalyst: null, context: null }, { headers: NO_STORE });

  const [catalyst, context] = await Promise.all([
    // Most recent 8-K in the last 7 days = the grounded catalyst.
    (async () => {
      try {
        const [f] = await db.select({ items: eightkFilings.items, material: eightkFilings.material, url: eightkFilings.filingUrl, filedAt: eightkFilings.filedAt })
          .from(eightkFilings)
          .where(and(eq(eightkFilings.ticker, symbol), sql`${eightkFilings.filedAt} >= now() - interval '7 days'`))
          .orderBy(desc(eightkFilings.filedAt)).limit(1);
        if (!f) return null;
        const cls = classifyItems(f.items);
        const agoMin = Math.max(0, Math.round((Date.now() - new Date(f.filedAt).getTime()) / 60000));
        return { type: cls.primaryLabel || 'SEC filing', source: '8-K', material: !!f.material, url: f.url || null, agoMin };
      } catch { return null; }
    })(),
    // Reaction context from our screener universe.
    (async () => {
      try {
        const [r] = await db.select({
          company: screenerStocks.company, price: screenerStocks.price, changePct: screenerStocks.changePct,
          relVol: screenerStocks.relVol, volume: screenerStocks.volume, high20d: screenerStocks.high20d,
          newsCategory: screenerStocks.newsCategory, breakingToday: screenerStocks.breakingToday, consensusScore: screenerStocks.consensusScore,
        }).from(screenerStocks).where(eq(screenerStocks.ticker, symbol)).limit(1);
        if (!r) return null;
        return {
          company: r.company || null, price: r.price ?? null, changePct: r.changePct ?? null,
          relVol: r.relVol ?? null, volume: r.volume ?? null,
          nearHigh: r.high20d != null && r.high20d >= -2,        // within 2% of the 20-day high
          newsCategory: r.newsCategory || null, breakingToday: !!r.breakingToday, consensusScore: r.consensusScore ?? null,
        };
      } catch { return null; }
    })(),
  ]);

  return Response.json({ symbol, catalyst, context }, { headers: NO_STORE });
}
