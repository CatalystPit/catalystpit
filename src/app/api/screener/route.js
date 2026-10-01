import { and, asc, ilike, sql } from 'drizzle-orm';
import { db } from '../../../lib/db';
import { screenerStocks } from '../../../lib/schema';
import { buildConds, SORT_MAP, FILTERS } from '../../../lib/screener-filters';
import { ensureScreenerTables } from '../../../lib/screener-data';
import { apiRateLimit } from '../../../lib/api-guard.mjs';
import { liveFieldsWithAvailability } from '../../../lib/scan/scanner-fields.mjs';
import { signalAvailability, callerCapabilities } from '../../../lib/scan/market-capabilities.mjs';
import { callerHasRealtime, resolveUserAccess, isProTier } from '../../../lib/entitlements';
import { PRO_AGGREGATE_FIELDS, isProAggregateField, stripProAggregate, sanitizeFilters, sanitizeSort } from '../../../lib/screener-entitlement.mjs';
import { activeCapabilities } from '../../../lib/scan/runtime';
import { toOptions } from '../../../lib/screener-taxonomy.mjs';

export const runtime = 'nodejs';
export const maxDuration = 20;
// ⚠️ TWO POLICIES, BECAUSE THE RESPONSE NOW VARIES BY ENTITLEMENT.
//
// This was one constant named NO_STORE whose value was `public, max-age=30` — publicly cacheable,
// despite the name. That was survivable while every caller got an identical payload. It is not
// survivable now: the rows carry the Pro aggregate for a Pro caller and not for anyone else, so a
// shared cache would hand one tier's payload to another, in both directions. A Free user getting a
// cached Pro page is the leak this whole task is about; a Pro user getting a cached Free page is the
// downgrade bug item 9 asks about. The meta endpoint already varied by entitlement (quoteFreshness) and
// had the same hazard.
//
// Every response this route produces now depends on who is asking, so there is no public variant left
// to keep — a second constant would only be an invitation to reach for the wrong one.
const PRIVATE_NO_STORE = { 'Cache-Control': 'private, no-store' };

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
      // ⚠️ RESOLVED ONCE, SERVER-SIDE, FROM THE CLERK SESSION. No header, cookie or query parameter
      // participates, and a lookup failure falls to Free — the same fail-closed shape every other
      // gated route in this codebase uses.
      let pro = false;
      try { pro = isProTier((await resolveUserAccess()).tier); } catch { pro = false; }
      const caps = activeCapabilities();
      // ⚠️ THE METADATA DESCRIBES WHAT THIS CALLER GETS, NOT WHAT THE ACCOUNT CAN DO. This endpoint
      // takes no auth, so it was telling anyone who asked that the feed was realtime while serving
      // them the 15-minute delayed snapshot. Resolved from the Clerk session only; no header,
      // cookie or query parameter participates, so a forged tier cannot reach it.
      const served = callerCapabilities(caps, { realtime: await callerHasRealtime() });
      const live = liveFieldsWithAvailability(caps, signalAvailability);
      // ⚠️ THE CLASSIFICATION OPTIONS COME FROM THE DATA, NOT FROM A LIST SOMEBODY MAINTAINS.
      // Industry offered 27 hand-written options against 373 industries actually present, and one
      // of them matched zero rows. See lib/screener-taxonomy.mjs.
      const taxonomy = await classificationOptions();
      const filters = { ...FILTERS, ...live };
      // ⚠️ A CONTROL THAT CANNOT WORK MUST NOT BE OFFERED AS WORKING. The Pro aggregate filters are
      // refused server-side for a non-Pro caller, so leaving them `available: true` would render a
      // dropdown that silently returns the unfiltered set — the "functional control that fails" pattern.
      // Marked unavailable with the same `available` flag the UI already honours for live fields, and
      // carrying a reason so the UI can say why rather than just greying it out.
      if (!pro) {
        for (const k of PRO_AGGREGATE_FIELDS) {
          if (filters[k]) filters[k] = { ...filters[k], available: false, proOnly: true, unavailable: 'Pit Pro' };
        }
      }
      if (taxonomy.industries.length) filters.industry = { ...filters.industry, opts: taxonomy.industries };
      if (taxonomy.sectors.length) filters.sector = { ...filters.sector, options: taxonomy.sectors.map((o) => o.value) };
      return Response.json({
        filters,
        // The client needs this to render the right control without a second request or a tier guess.
        pro,
        proAggregateFields: PRO_AGGREGATE_FIELDS,
        capabilities: {
          // ⚠️ THE INTERNAL PROVIDER ID IS NOT SHIPPED. This endpoint takes no auth, so
          // `provider: "tiingo-realtime"` was served to anyone who fetched it — a vendor identifier
          // and an entitlement descriptor, neither of which any client reads (checked: only
          // CustomScannerPanel consumes this payload, and only `label`). Withheld rather than
          // renamed, because the honest amount of licensing internals to publish is none.
          //
          // `label` stays: it is rendered to the reader as "Current feed: …", and whether our data
          // vendor must, may, or must not be named to users is an attribution term in the licence,
          // not something to decide here. Flagged for the owner.
          // ⚠️ THE PROVIDER LABEL IS NO LONGER SERVED. It was `caps.label` — "Tiingo (real-time
          // consolidated)" — and the UI rendered it as "Current feed: …". The Tiingo agreement's
          // attribution clause is satisfied on the legal pages, in the exact wording it requires, and
          // does NOT ask for the vendor beside every quote, screener or scan result. A per-surface
          // feed label is also an implementation detail: it names our plan tier to anyone who fetches
          // this endpoint, which takes no auth.
          //
          // What a reader actually needs here is the FRESHNESS of the data they are being served, and
          // that is below — already capped to this caller's entitlement.
          quoteFreshness: served.quoteFreshness,
          streaming: served.streaming,
          liveVolume: served.liveVolume,
          consolidatedVolume: served.consolidatedVolume,
          bidAsk: served.bidAsk,
          extendedHours: served.extendedHours,
        },
      }, { headers: PRIVATE_NO_STORE });
    }

    let active = {};
    try { active = JSON.parse(sp.get('filters') || '{}') || {}; } catch { active = {}; }
    // ⚠️ ENTITLEMENT IS RESOLVED BEFORE THE QUERY IS BUILT, not after the rows come back. Filtering and
    // ordering by a gated column leak it just as surely as returning it: a filter answers "which of the
    // 18,036 have insider buying", and a sort publishes that ranking in order. So the gate reaches the
    // SQL, not only the payload.
    let pro = false;
    try { pro = isProTier((await resolveUserAccess()).tier); } catch { pro = false; }
    const { filters: allowed, dropped } = sanitizeFilters(active, { pro });
    active = allowed;
    const conds = buildConds(active);
    const ticker = (sp.get('ticker') || '').toUpperCase().trim();
    if (ticker) conds.push(ilike(screenerStocks.ticker, `${ticker}%`));

    const where = conds.length ? and(...conds) : null;
    // Default ordering is a measured quantity. It used to fall back to consensus_score, a 0-100
    // blend of weighted sub-scores that nothing validated, so every unsorted screener view was
    // ranked by it. The column still exists for compatibility; it is no longer what users are shown.
    // ⚠️ THE DEFAULT ORDERING WAS ITSELF A GATED FIELD. insiderNet90d ranked every unsorted request,
    // including an anonymous one — so stripping the cell alone would have left the Pro ranking fully
    // readable through the row order. A non-Pro caller is re-pointed at market cap.
    const { sort: sortKey, refused: sortRefused } = sanitizeSort(sp.get('sort'), { pro });
    const sortCol = SORT_MAP[sortKey]
      || (pro ? screenerStocks.insiderNet90d : screenerStocks.marketCap)
      || screenerStocks.ticker;
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
    // ⚠️ THE LAST GATE, AND THE ONE THAT CANNOT BE REASONED AROUND. db.select() returns the whole row,
    // so every new column lands here automatically — which is exactly how these eight came to be
    // published. Stripping on the way out means a column added to screener_stocks tomorrow is exposed
    // only if somebody also adds it to the non-gated set, rather than by default.
    const safeRows = pro ? rows : rows.map(stripProAggregate);
    return Response.json({
      rows: safeRows, total: n, page, pageSize, activeCount, pro,
      // Told, not silently substituted: the caller asked for something they cannot have, and a client
      // that quietly showed unfiltered results as if they were filtered would be the worse failure.
      ...(dropped.length ? { droppedFilters: dropped } : {}),
      ...(sortRefused ? { sortRefused: true } : {}),
    }, { headers: PRIVATE_NO_STORE });
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
    return Response.json({ rows: [], total: 0, error: 'unavailable' }, { status: 200, headers: PRIVATE_NO_STORE });
  }
}
