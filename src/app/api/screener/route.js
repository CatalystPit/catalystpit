import { and, asc, ilike, sql } from 'drizzle-orm';
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
    // ⚠️ NULLS LAST, OR EVERY DESCENDING SORT LEADS WITH THE ROWS THAT HAVE NO VALUE.
    //
    // Postgres orders NULLS FIRST on DESC and NULLS LAST on ASC, and drizzle's desc() adds no NULLS
    // clause — so every descending numeric sort this screener offered returned a first page that was
    // 100% nulls. Measured in production before this change, page 1 of `dir=desc`:
    //
    //   sort=marketCap  50/50 rows NULL, row 1 = AAA      sort=changePct  50/50 NULL
    //   sort=price      50/50 rows NULL, row 1 = AAAZX     sort=volume     50/50 NULL
    //   sort=pe         50/50 rows NULL                    (ASC was correct throughout)
    //
    // So "sort by market cap" — the first thing anyone does with a screener — showed blank rows
    // beginning at AAA, and the default view (insider_net_90d desc) buried its own ranking under
    // 14,828 null rows: the largest disclosed net insider buying in the table, RSG at $1.38B, sat on
    // page 297 of 361 while the top of the list was alphabetical.
    //
    // A null is "we do not know", and an unknown must never outrank a known value in a ranking view.
    // Stated for BOTH directions rather than relying on the ASC default, so the two cannot diverge if
    // the default ever changes. The ticker tiebreak stays: it is what keeps pagination stable when a
    // primary value ties, which after this change is most of the table.
    const dirSql = sp.get('dir') === 'asc' ? sql`asc` : sql`desc`;
    const orderPrimary = sql`${sortCol} ${dirSql} nulls last`;
    const pageSize = Math.min(100, Math.max(10, parseInt(sp.get('pageSize') || '50', 10) || 50));
    const page = Math.max(0, parseInt(sp.get('page') || '0', 10) || 0);

    // Build queries without ever passing .where(undefined) (some Drizzle builds error on it).
    let rowsQ = db.select().from(screenerStocks);
    let cntQ = db.select({ n: sql`count(*)`.mapWith(Number) }).from(screenerStocks);
    if (where) { rowsQ = rowsQ.where(where); cntQ = cntQ.where(where); }
    const [rows, [{ n }]] = await Promise.all([
      rowsQ.orderBy(orderPrimary, asc(screenerStocks.ticker)).limit(pageSize).offset(page * pageSize),
      cntQ,
    ]);

    const activeCount = Object.keys(active).filter((k) => FILTERS[k]?.available && active[k] && Object.keys(active[k]).length).length;
    return Response.json({ rows, total: n, page, pageSize, activeCount }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[screener] ${e.message}`);
    // ⚠️ AN OPAQUE FLAG, NOT THE EXCEPTION TEXT. This returned `error: e.message`, so a failing query
    // handed the client whatever Postgres said — column names, relation names, connection detail. The
    // message belongs in the log above, where it already is; the client only needs to know that this
    // is a failure rather than an answer.
    //
    // ⚠️ AND THE FLAG IS THE ONLY THING SEPARATING "BROKEN" FROM "NOTHING MATCHED". The status stays
    // 200 so the client can render its own state, which means an empty `rows` here is indistinguishable
    // from a legitimate zero-match unless the client reads this field — and it did not, so a database
    // failure rendered as "No stocks match these filters. Widen them or clear a chip." See the
    // matching change in ScreenerClient's load().
    return Response.json({ rows: [], total: 0, error: 'unavailable' }, { status: 200, headers: NO_STORE });
  }
}
