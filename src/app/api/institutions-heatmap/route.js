import { db } from '../../../lib/db';
import { sql } from 'drizzle-orm';

export const runtime = 'nodejs';

// Sector-grouped institutional position changes for the heatmap. Reads the precomputed
// institution_heatmap aggregate rather than joining two 1.3M-row quarters per request; rebuilding
// that aggregate is how new backfill data reaches this page.
//
// Every integrity guard is applied upstream in the aggregate (rankable common/ADR only, filer scale
// normalisation, row plausibility against market price, amendment-composed quarters, funds present
// in both quarters), so nothing here can render an unguarded number.

const CACHE = { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600' };
const UNCLASSIFIED = 'Unclassified';

export async function GET(request) {
  try {
    const limit = Math.min(600, Math.max(40, parseInt(new URL(request.url).searchParams.get('limit') ?? '260', 10) || 260));

    const [{ rows: metaRows }, { rows }] = await Promise.all([
      db.execute(sql`select quarter::text q, prev_quarter::text pq, tickers, sectored_tickers,
        covered_value, excluded_value, unclassified_value, funds_both, funds_current, computed_at
        from institution_heatmap_meta order by quarter desc limit 1`),
      db.execute(sql`select ticker, sector, issuer, cur_shares, prev_shares, delta_shares,
        pct_change, cur_value, funds, is_new
        from institution_heatmap
        where quarter = (select max(quarter) from institution_heatmap)
        order by cur_value desc limit ${limit}`),
    ]);

    const meta = metaRows?.[0] || null;
    const bySector = new Map();
    for (const r of rows || []) {
      // A missing sector is never guessed. It goes to its own group so the value stays visible and
      // the reader can see how much of the map is unclassified.
      const key = r.sector || UNCLASSIFIED;
      if (!bySector.has(key)) bySector.set(key, { sector: key, value: 0, tickers: [] });
      const g = bySector.get(key);
      const value = Number(r.cur_value) || 0;
      g.value += value;
      g.tickers.push({
        ticker: r.ticker,
        issuer: r.issuer,
        sector: r.sector || null,
        curShares: Number(r.cur_shares) || 0,
        prevShares: Number(r.prev_shares) || 0,
        deltaShares: Number(r.delta_shares) || 0,
        pctChange: r.pct_change == null ? null : Number(r.pct_change),
        value,
        funds: Number(r.funds) || 0,
        isNew: !!r.is_new,
      });
    }
    const sectors = [...bySector.values()].sort((a, b) => b.value - a.value);
    for (const s of sectors) s.tickers.sort((a, b) => b.value - a.value);

    return Response.json({
      quarter: meta?.q || null,
      prevQuarter: meta?.pq || null,
      sectors,
      shown: (rows || []).length,
      coverage: meta && {
        tickers: Number(meta.tickers),
        sectoredTickers: Number(meta.sectored_tickers),
        coveredValue: Number(meta.covered_value),
        excludedValue: Number(meta.excluded_value),
        unclassifiedValue: Number(meta.unclassified_value),
        fundsBoth: Number(meta.funds_both),
        fundsCurrent: Number(meta.funds_current),
        computedAt: meta.computed_at,
      },
      // The 13F backfill is still ingesting, so a prior quarter is less complete than the current
      // one. The UI must say so rather than presenting these as settled.
      provisional: true,
    }, { headers: CACHE });
  } catch (e) {
    console.error('[institutions_heatmap]', e);
    return Response.json({ error: 'heatmap unavailable' }, { status: 500 });
  }
}
