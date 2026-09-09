import { and, asc, desc, ilike, sql } from 'drizzle-orm';
import { db } from '../../../lib/db';
import { screenerStocks } from '../../../lib/schema';
import { buildConds, SORT_MAP, FILTERS } from '../../../lib/screener-filters';
import { ensureScreenerTables } from '../../../lib/screener-data';

export const runtime = 'nodejs';
export const maxDuration = 20;
const NO_STORE = { 'Cache-Control': 'public, max-age=30' };

// GET ?filters=<json>&sort=&dir=&page=&ticker=  → screen our screener_stocks universe.
// Also returns the filter registry (once) so the client renders categories without hardcoding.
export async function GET(request) {
  try {
    await ensureScreenerTables();
    const sp = new URL(request.url).searchParams;

    if (sp.get('meta') === '1') {
      return Response.json({ filters: FILTERS }, { headers: NO_STORE });
    }

    let active = {};
    try { active = JSON.parse(sp.get('filters') || '{}') || {}; } catch { active = {}; }
    const conds = buildConds(active);
    const ticker = (sp.get('ticker') || '').toUpperCase().trim();
    if (ticker) conds.push(ilike(screenerStocks.ticker, `${ticker}%`));

    const where = conds.length ? and(...conds) : null;
    const sortCol = SORT_MAP[sp.get('sort')] || screenerStocks.consensusScore;
    const dirFn = sp.get('dir') === 'asc' ? asc : desc;
    const pageSize = Math.min(100, Math.max(10, parseInt(sp.get('pageSize') || '50', 10) || 50));
    const page = Math.max(0, parseInt(sp.get('page') || '0', 10) || 0);

    // Build queries without ever passing .where(undefined) (some Drizzle builds error on it).
    let rowsQ = db.select().from(screenerStocks);
    let cntQ = db.select({ n: sql`count(*)`.mapWith(Number) }).from(screenerStocks);
    if (where) { rowsQ = rowsQ.where(where); cntQ = cntQ.where(where); }
    const [rows, [{ n }]] = await Promise.all([
      rowsQ.orderBy(dirFn(sortCol), asc(screenerStocks.ticker)).limit(pageSize).offset(page * pageSize),
      cntQ,
    ]);

    const activeCount = Object.keys(active).filter((k) => FILTERS[k]?.available && active[k] && Object.keys(active[k]).length).length;
    return Response.json({ rows, total: n, page, pageSize, activeCount }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[screener] ${e.message}`);
    return Response.json({ rows: [], total: 0, error: e.message }, { status: 200, headers: NO_STORE });
  }
}
