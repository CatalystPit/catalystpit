// SCREENER — end-to-end integrity for the live path (/api/screener → ScreenerClient).
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-screener-integrity.mjs
//
// ⚠️ WHAT THIS GUARDS. Three defects were found by auditing production and none of them threw:
//
//   1. Every DESCENDING sort returned a first page of nothing but NULLs. Postgres orders NULLS FIRST
//      on DESC, drizzle's desc() adds no NULLS clause, and so "sort by market cap" — the first thing
//      anyone does with a screener — showed blank rows beginning at AAA.
//   2. A P/E of 2,965,890,570,601,113,600, from dividing by an eps_ttm of 3.47e-18 that passed a
//      `> 0` guard.
//   3. A database failure rendered as "No stocks match these filters", because the route answers
//      HTTP 200 with an error field and the client only checked r.ok.
//
// Each produced a plausible page rather than an error, which is why each is asserted here.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const one = async (q) => (await q)[0];

L('⚠️ a NULL never outranks a value');
{
  const route = read('src/app/api/screener/route.js');
  // ⚠️ THE CLAUSE ITSELF, because nothing else can express this. `desc(col)` renders no NULLS clause
  // and Postgres then defaults to NULLS FIRST — which is how a screener came to lead with blanks.
  ok('⚠️ the primary ordering states `nulls last`', /nulls last/i.test(route));
  ok('⚠️ …for BOTH directions, not just the one Postgres gets wrong',
    /const dirSql = sp\.get\('dir'\) === 'asc' \? sql`asc` : sql`desc`/.test(route)
    && /sql`\$\{sortCol\} \$\{dirSql\} nulls last`/.test(route));
  ok('…and drizzle\'s bare desc() is no longer used for the sort', !/orderBy\(dirFn\(/.test(route));
  ok('⚠️ the ticker tiebreak survives, which is what keeps pagination stable',
    /asc\(screenerStocks\.ticker\)/.test(route));

  // Production: every sortable numeric column must put its values before its nulls.
  // ⚠️ short_float LEFT THIS LIST, AND IS ASSERTED EMPTY INSTEAD. "Sorting by it leads with values"
  // presumes the column can be populated. It cannot: its denominator is FREE float, which no approved
  // source publishes, and the near-neighbour the SEC does publish — shares OUTSTANDING — is a different
  // quantity that would understate every ratio. So an empty short_float is the correct state, and a sort
  // check against it was asserting the presence of data we are not entitled to serve.
  //
  // Dropping it from the list would quietly stop testing the column, so the assertions after this loop
  // replace it with the stronger claim: it must be ENTIRELY null. If a float ever reappears from an
  // unapproved source that trips — which the old assertion would have greeted as a pass.
  const SORTABLE = ['price', 'change_pct', 'volume', 'rel_vol', 'market_cap', 'rsi14',
    'insider_net_90d', 'perf_1m', 'perf_3m', 'pe'];
  for (const col of SORTABLE) {
    const r = await sql.query(
      `select count(*)::int n from (select ${col} v from screener_stocks order by ${col} desc nulls last, ticker asc limit 50) z where v is null`);
    ok(`${col} desc leads with values, not nulls`, r[0].n === 0, `${r[0].n}/50 null`);
  }

  // ⚠️ THE FLOAT COLUMNS MUST BE EMPTY, which is a claim about licensing rather than coverage. Every
  // row of ticker_float carried source = 'fmp', and the Screener went on joining to it for weeks after the
  // provider was retired — 114 float_shares and 101 short_float values served to users the whole time,
  // while the suite that checked the FETCHER was green. These two read the table users are served from.
  const flt = (await sql.query(
    `select count(float_shares)::int f, count(short_float)::int sf from screener_stocks`))[0];
  ok('⚠️ no float share count is served', flt.f === 0, `${flt.f} rows carry one`);
  ok('⚠️ …and no % of float derived from one is served', flt.sf === 0, `${flt.sf} rows carry one`);
}

L('⚠️ a ratio is not a ratio when its denominator is arithmetic residue');
{
  const src = read('src/lib/screener-data.js');
  ok('the eps floor exists and is named', /MIN_MEANINGFUL_EPS = 0\.001/.test(src));
  ok('⚠️ P/E uses it rather than a bare `> 0`', /epsTtm >= MIN_MEANINGFUL_EPS\) \? px \/ fd\.epsTtm/.test(src));
  ok('…and so does payoutRatio, which divides by the same figure', /epsTtm >= MIN_MEANINGFUL_EPS\) \? \(m\.annualDividend/.test(src));
  const r = await one(sql`select
    count(*) filter (where pe > 1e6)::int absurd,
    count(*) filter (where pe < 0)::int negative,
    count(*) filter (where pe = 0)::int zero,
    max(pe) mx from screener_stocks`);
  ok('⚠️ no stored P/E is astronomic', r.absurd === 0, `${r.absurd} rows, max ${r.mx}`);
  // ⚠️ NEGATIVE EARNINGS MUST BE NULL, NOT ZERO. A 0 would read as "no premium", which is the
  // opposite of "this company loses money".
  ok('⚠️ a loss-making company has a NULL P/E, never 0', r.negative === 0 && r.zero === 0,
    `${r.negative} negative / ${r.zero} zero`);
  const orphan = await one(sql`select count(*)::int n from screener_stocks s
    join screener_fundamentals f on f.ticker = s.ticker
    where f.eps_ttm > 0 and f.eps_ttm < 0.001 and s.pe is not null`);
  ok('no row keeps a P/E derived from a sub-floor eps', orphan.n === 0, `${orphan.n}`);
}

L('⚠️ one security, one row');
{
  const r = await one(sql`select count(*)::int total, count(distinct ticker)::int uniq from screener_stocks`);
  ok('no duplicate tickers', r.total === r.uniq, `${r.total} / ${r.uniq}`);
  // ⚠️ THE CONSTRAINT, NOT TODAY'S DATA — a primary key is what makes the nightly upsert idempotent.
  const pk = await sql`select indexdef from pg_indexes where tablename='screener_stocks' and indexdef ilike '%unique%'`;
  ok('⚠️ …enforced by a unique index on ticker', pk.some((i) => /\(ticker\)/.test(i.indexdef)), JSON.stringify(pk.map((i) => i.indexdef)));
  const bad = await one(sql`select count(*)::int n from screener_stocks where ticker !~ '^[A-Z][A-Z0-9.-]{0,9}$'`);
  ok('every ticker is symbol-shaped (so every link is well-formed)', bad.n === 0, `${bad.n}`);
}

L('⚠️ identity comes from the canonical master, not from a classification');
{
  const { isSicDescription } = await import('../src/lib/sic-descriptions.mjs');
  const rows = await sql`select ticker, company from screener_stocks where company is not null`;
  const sicNamed = rows.filter((r) => isSicDescription(r.company));
  // ⚠️ THE ORIGINAL CONTAMINATION: a company whose "name" was its SIC description, because the
  // resolver fell through to a classification when it had no name.
  ok('⚠️ no company name is an SIC description', sicNamed.length === 0,
    sicNamed.slice(0, 3).map((r) => `${r.ticker}="${r.company}"`).join(', '));
  const eq = await one(sql`select
    count(*) filter (where lower(btrim(company)) = lower(btrim(industry)))::int ind,
    count(*) filter (where lower(btrim(company)) = lower(btrim(sector)))::int sec
    from screener_stocks where company is not null`);
  ok('⚠️ no company name equals its own industry', eq.ind === 0, `${eq.ind}`);
  ok('…nor its sector', eq.sec === 0, `${eq.sec}`);
  // The names the historical bugs were found on.
  for (const [t, want] of [['XOM', 'EXXON'], ['ZTS', 'ZOETIS'], ['SIRI', 'SIRIUS'], ['BRK.B', 'BERKSHIRE']]) {
    const r = await one(sql`select company from screener_stocks where ticker = ${t}`);
    ok(`${t} is named canonically`, !!r && String(r.company).toUpperCase().includes(want), `"${r?.company}"`);
  }
}

L('⚠️ filters compare numbers, and a NULL is not a match');
{
  const src = read('src/lib/screener-filters.js');
  // ⚠️ Number(), NOT THE FORMATTED STRING. A filter comparing "1,000" lexically is the classic way a
  // screener silently returns the wrong set.
  ok('⚠️ range bounds are coerced to numbers before comparing',
    /gte\(c, Number\(cond\.min\)\)/.test(src) && /lte\(c, Number\(cond\.max\)\)/.test(src));
  ok('a bool filter requires a real boolean, not a truthy string', /typeof cond\.eq === 'boolean'/.test(src));
  ok('⚠️ a LIVE field can never reach the SQL builder', /if \(f\.live\) continue;/.test(src));
  ok('an unknown or unavailable filter key is skipped', /if \(!f \|\| !f\.available \|\| !cond\) continue;/.test(src));
  // The requested sort now passes through sanitizeSort first — a non-Pro caller may not order by a gated
  // column, because the ordering publishes the ranking it hides — and the result is still allowlisted
  // through SORT_MAP. Both properties matter, so both are asserted.
  ok('the sort column is allowlisted through SORT_MAP', /SORT_MAP\[sortKey\]/.test(read('src/app/api/screener/route.js')));
  ok('⚠️ …after the gated columns have been refused',
    /sanitizeSort\(sp\.get\('sort'\), \{ pro \}\)/.test(read('src/app/api/screener/route.js')));

  // Production semantics: inclusive bounds, and NULLs excluded by the range itself.
  const inRange = await one(sql`select count(*)::int n from screener_stocks where price >= 1 and price <= 1`);
  ok('an exactly-equal min/max range is inclusive', inRange.n > 0, `${inRange.n} rows at exactly 1.00`);
  const nullsIn = await one(sql`select count(*)::int n from screener_stocks where price >= 1 and price is null`);
  ok('⚠️ a range filter cannot admit a row with no value', nullsIn.n === 0, `${nullsIn.n}`);
  // AND semantics: two filters cannot return more than either alone.
  const a = await one(sql`select count(*)::int n from screener_stocks where price >= 10`);
  const b = await one(sql`select count(*)::int n from screener_stocks where market_cap >= 1e10`);
  const both = await one(sql`select count(*)::int n from screener_stocks where price >= 10 and market_cap >= 1e10`);
  ok('⚠️ combining filters narrows, never widens', both.n <= Math.min(a.n, b.n), `${a.n} / ${b.n} -> ${both.n}`);
}

L('⚠️ a broken screener does not say "no stocks match"');
{
  const route = read('src/app/api/screener/route.js');
  // ⚠️ MATCHED ON THE RETURN, NOT THE WORDS. The comment above the fix quotes the old
  // `error: e.message` to explain what was wrong, so searching the file for that text finds the
  // explanation rather than a violation — it failed exactly that way on the first run.
  const errorReturn = (route.match(/return Response\.json\(\{[^}]*error:[^}]*\}[^;]*;/g) || []).join(' ');
  ok('⚠️ the route never returns the exception text to the client',
    errorReturn.length > 0 && !/e\.message/.test(errorReturn), errorReturn.slice(0, 110));
  ok('…it returns an opaque flag instead', /error: 'unavailable'/.test(route));
  const client = read('src/app/screener/ScreenerClient.jsx');
  // ⚠️ THE FAILURE ARRIVES AS HTTP 200, so r.ok alone cannot see it.
  ok('⚠️ the client treats that flag as a failure, not as an empty result',
    /if \(j\?\.error\) throw new Error/.test(client));
  ok('…and has a distinct error state to render', /Couldn't run the screen/.test(client));
  ok('…kept separate from the genuine zero-match message', /No stocks match these filters/.test(client));
}

L('⚠️ derived fields still use the corrected keys');
{
  const src = read('src/lib/screener-data.js');
  // 13F: the operative filing per POSITION, which includes class — the corrected key.
  ok('⚠️ the 13F consumption dedupes on (cik, quarter, cusip, class)',
    /distinct on \(cik, quarter, cusip, class\)/.test(src));
  ok('…with put_call constrained, completing the operative key', /put_call = ''/.test(src));
  // Form 4: superseded filings excluded — this file was one of the six forgotten consumers.
  ok('⚠️ the insider aggregate excludes retracted Form 4 filings',
    /insider_trades\.superseded_by IS NULL/.test(src));
}

L('⚠️ entitlement: the screener is tier-independent, which is what makes its cache safe');
{
  // ⚠️ EXECUTED, NOT GREPPED. A missing re-export is invisible to a text search — that is how
  // isRealtime came to be undefined at six call sites while 118 assertions stayed green.
  const ent = await import('../src/lib/entitlements.js');
  for (const n of ['isRealtime', 'isProTier', 'resolveUserTier', 'eodCutoffIso']) {
    ok(`lib/entitlements.js exports a callable ${n}`, typeof ent[n] === 'function');
  }
  const route = read('src/app/api/screener/route.js');
  // ⚠️ THE PREMISE OF THIS ASSERTION WAS FALSE, AND IT HELD THE LEAK OPEN. It read "the route resolves no
  // tier, so no tier-specific data can enter its cache", on the reasoning that the rows are the nightly
  // batch and therefore identical for everyone. The rows were NOT identical in what they should have
  // been allowed to contain: eight of the columns are derived aggregates over datasets gated to ten
  // records on their own boards. The response was `public, max-age=30`, so it was also cacheable.
  //
  // The correct invariant is the COUPLING rather than the absence: the route may resolve a tier, and if
  // it does, nothing it returns may be publicly cached. Asserted in that form so neither half can change
  // without the other.
  const resolvesTier = /resolveUserAccess|isProTier/.test(route);
  ok('⚠️ the route resolves a tier, because the rows carry the Pro aggregate', resolvesTier);
  ok('⚠️ …and therefore nothing it returns is publicly cacheable',
    !resolvesTier || (!/'public, max-age/.test(route) && /'private, no-store'/.test(route)));
  ok('…and the price overlay goes through the entitlement-aware quotes API',
    /\/api\/quotes\?symbols=/.test(read('src/app/screener/ScreenerClient.jsx')));
  // ⚠️ AND THIS ONE WAS PASSING ON A COMMENT. It asserted `public, max-age=30` is present — which stopped
  // being the policy when the response began varying by entitlement, and remained "true" only because
  // the replacement comment QUOTES the old value while explaining why it went. A quotation is not a rule;
  // that is the fourth time that distinction has cost an assertion in this codebase. Matched on the
  // actual header constant now, and inverted to the policy that is genuinely in force.
  const headerDecl = (route.match(/const [A-Z_0-9]+ = \{ 'Cache-Control': '[^']+' \}/g) || []);
  ok('⚠️ the only cache policy declared is private and uncached',
    headerDecl.length === 1 && /'private, no-store'/.test(headerDecl[0]), JSON.stringify(headerDecl));
  ok('…so a per-tier answer can never be served from a shared cache',
    !headerDecl.some((d) => /public/.test(d)));
}

L('the table is indexed for the columns it filters on');
{
  const idx = (await sql`select indexdef from pg_indexes where tablename='screener_stocks'`).map((r) => r.indexdef);
  for (const col of ['price', 'market_cap', 'sector']) {
    ok(`${col} is indexed`, idx.some((d) => new RegExp(`\\(${col}\\)`).test(d)));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
