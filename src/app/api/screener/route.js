import { and, asc, desc, ilike, sql } from 'drizzle-orm';
import { db } from '../../../lib/db';
import { screenerStocks } from '../../../lib/schema';
import { buildConds, SORT_MAP, FILTERS } from '../../../lib/screener-filters';
import { ensureScreenerTables } from '../../../lib/screener-data';
import { apiRateLimit } from '../../../lib/api-guard.mjs';
import { liveFieldsWithAvailability } from '../../../lib/scan/scanner-fields.mjs';
import { signalAvailability } from '../../../lib/scan/market-capabilities.mjs';
import { activeCapabilities } from '../../../lib/scan/runtime';
import { toOptions } from '../../../lib/screener-taxonomy.mjs';

export const runtime = 'nodejs';
export const maxDuration = 20;
const NO_STORE = { 'Cache-Control': 'public, max-age=30' };

// Distinct sectors and industries actually present in the visible universe.
//
// ⚠️ MEMOISED PER INSTANCE. The screener is rebuilt nightly, so this answer changes once a day
// while the meta endpoint is hit on every page load — re-running two DISTINCT scans over 17k rows
// per viewer would be exactly the "scales with users" shape the rest of this codebase spent a
// week removing.
let _taxonomy = null, _taxonomyAt = 0;
const TAXONOMY_TTL_MS = 30 * 60 * 1000;

async function classificationOptions() {
  if (_taxonomy && Date.now() - _taxonomyAt < TAXONOMY_TTL_MS) return _taxonomy;
  try {
    // market_cap > 0 is the visible universe — the same gate the rows themselves pass, so the
    // dropdown cannot offer a classification no result can have.
    const res = await db.execute(sql`
      select 'sector' as kind, sector as v from screener_stocks
        where market_cap > 0 and sector is not null and trim(sector) <> '' group by sector
      union all
      select 'industry', industry from screener_stocks
        where market_cap > 0 and industry is not null and trim(industry) <> '' group by industry`);
    const rows = res.rows ?? res;
    _taxonomy = {
      sectors: toOptions(rows.filter((r) => r.kind === 'sector').map((r) => r.v), { contains: false }),
      industries: toOptions(rows.filter((r) => r.kind === 'industry').map((r) => r.v)),
    };
    _taxonomyAt = Date.now();
  } catch {
    // A failed query leaves the registry's own lists in place rather than emptying the dropdowns.
    _taxonomy = { sectors: [], industries: [] };
    _taxonomyAt = Date.now();
  }
  return _taxonomy;
}

// GET ?filters=<json>&sort=&dir=&page=&ticker=  → screen our screener_stocks universe.
// Also returns the filter registry (once) so the client renders categories without hardcoding.
export async function GET(request) {
  const _rl = await apiRateLimit(request, 'screener', 'heavy');
  if (_rl) return _rl;

  try {
    await ensureScreenerTables();
    const sp = new URL(request.url).searchParams;

    if (sp.get('meta') === '1') {
      // ONE VOCABULARY, TWO SOURCES. The daily filters compile to SQL against screener_stocks; the
      // live ones are computed from market state and cannot. They are merged for DISPLAY only — the
      // Custom Scanner renders both from one list without needing to know which half a field is
      // from, while buildConds below still only ever sees the daily half.
      const caps = activeCapabilities();
      const live = liveFieldsWithAvailability(caps, signalAvailability);
      // ⚠️ THE CLASSIFICATION OPTIONS COME FROM THE DATA, NOT FROM A LIST SOMEBODY MAINTAINS.
      // Industry offered 27 hand-written options against 373 industries actually present, and one
      // of them matched zero rows. See lib/screener-taxonomy.mjs.
      const taxonomy = await classificationOptions();
      const filters = { ...FILTERS, ...live };
      if (taxonomy.industries.length) filters.industry = { ...filters.industry, opts: taxonomy.industries };
      if (taxonomy.sectors.length) filters.sector = { ...filters.sector, options: taxonomy.sectors.map((o) => o.value) };
      return Response.json({
        filters,
        capabilities: {
          provider: caps.id,
          label: caps.label,
          quoteFreshness: caps.quoteFreshness,
          streaming: caps.streaming,
          liveVolume: caps.liveVolume,
          consolidatedVolume: caps.consolidatedVolume,
          bidAsk: caps.bidAsk,
          extendedHours: caps.extendedHours,
        },
      }, { headers: NO_STORE });
    }

    let active = {};
    try { active = JSON.parse(sp.get('filters') || '{}') || {}; } catch { active = {}; }
    const conds = buildConds(active);
    const ticker = (sp.get('ticker') || '').toUpperCase().trim();
    if (ticker) conds.push(ilike(screenerStocks.ticker, `${ticker}%`));

    const where = conds.length ? and(...conds) : null;
    // Default ordering is a measured quantity. It used to fall back to consensus_score, a 0-100
    // blend of weighted sub-scores that nothing validated, so every unsorted screener view was
    // ranked by it. The column still exists for compatibility; it is no longer what users are shown.
    const sortCol = SORT_MAP[sp.get('sort')] || screenerStocks.insiderNet90d || screenerStocks.ticker;
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
