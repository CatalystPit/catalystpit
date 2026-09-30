// ONE PROVIDER REACHES THE CALENDAR — the fix for a live duplicate-display bug, pinned.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-dividends-source.mjs
//
// ⚠️ WHAT WAS WRONG, MEASURED ON THE LIVE PUBLIC CALENDAR. dividend_events is keyed on
// (source, source_event_id), so polygon and tiingo each hold a row for the same corporate action —
// correct storage, and a display bug. The `distinct on` collapsed the identical ones and could not
// collapse:
//
//   float noise      CMSC 2026-09-30 → 0.36719999999999997 (polygon) vs 0.3672 (tiingo)
//   a null one side  ABALX, ABNDX … payment_date and record_date present from one, null from the other
//   granularity      NCDL 2026-09-30 → $0.36 + $0.02 (polygon, both typed regular) vs $0.38 (tiingo)
//
// /api/dividends/calendar returned 11 duplicated (ticker, ex-date) pairs in the first 500 rows of a
// 30-day window, NCDL three times. Across the last 30 days plus everything upcoming: 1,021 pairs.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { calendarSource, LICENSED_DIVIDEND_SOURCE, PROVIDERS, activeDividendProvider } from '../src/lib/dividends/providers/index.mjs';
import { calendarRange, calendarCount, calendarSectorCounts, calendarTypeCounts, dividendSyncState } from '../src/lib/dividends/dividend-store.js';
import { typeOptions } from '../src/lib/dividends/dividend-view.mjs';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const today = new Date().toISOString().slice(0, 10);
const plus = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

L('⚠️ 1 — the calendar reads exactly one source, and it is the licensed one');
{
  const store = code('src/lib/dividends/dividend-store.js');
  ok('⚠️ the shared condition builder filters on source',
    /const conds = \[sql`d\.source = \$\{calendarSource\(\)\}`/.test(store));
  // ⚠️ IN THE SHARED BUILDER, NOT IN calendarRange. Rows, count and both facets are built from
  // calendarConditions; putting the filter in one query would make the total describe a different set
  // than the table under it — the contradiction this file already carries a scar from.
  ok('⚠️ …which is what rows, count and every facet are built from',
    (store.match(/calendarConditions\(\{ from, to, dateCol/g) || []).length >= 4);
  ok('…and nothing re-adds a second source anywhere', !/source (in|=) \(/i.test(store));
  ok('the freshness query is scoped to the same source',
    /from dividend_events where source = \$\{source\}/.test(store));

  // ⚠️ THE FALLBACK IS THE LICENSED FEED, WHICH IS NOT activeDividendProvider's DEFAULT. That one falls
  // back to polygon for ingest-compatibility reasons predating the licence. For DISPLAY that is the
  // wrong way round: polygon's redistribution rights are recorded as unconfirmed, and this value
  // decides what gets published — so a missing env var must not be able to publish uncleared rows.
  ok('⚠️ an unset DIVIDEND_PROVIDER displays the licensed source', calendarSource({}) === LICENSED_DIVIDEND_SOURCE);
  ok('⚠️ …and so does an unrecognised one', calendarSource({ DIVIDEND_PROVIDER: 'twelvedata' }) === LICENSED_DIVIDEND_SOURCE);
  ok('⚠️ …and an empty string', calendarSource({ DIVIDEND_PROVIDER: '' }) === LICENSED_DIVIDEND_SOURCE);
  ok('the licensed source is Tiingo, the commercially licensed provider', LICENSED_DIVIDEND_SOURCE === 'tiingo');
  ok('…and it is a registered provider', !!PROVIDERS[LICENSED_DIVIDEND_SOURCE]);
  ok('a recognised provider IS honoured, so a swap needs no code change',
    calendarSource({ DIVIDEND_PROVIDER: 'polygon' }) === 'polygon'
    && calendarSource({ DIVIDEND_PROVIDER: 'TIINGO' }) === 'tiingo');
  // ⚠️ NO NEW VENDOR. The registry is exactly the two adapters that already existed.
  ok('⚠️ no data vendor was added', Object.keys(PROVIDERS).sort().join(',') === 'polygon,tiingo');
  ok('…and no unlicensed vendor appears in the dividends code',
    !/twelvedata|twelve_data|finnhub|fmp|financialmodeling/i.test(
      read('src/lib/dividends/dividend-store.js') + read('src/lib/dividends/providers/index.mjs')));
  // ⚠️ INGEST AND DISPLAY MUST NEVER DISAGREE, FOR ANY CONFIGURATION. They did: activeDividendProvider
  // fell back to polygon and calendarSource to tiingo, so an unset DIVIDEND_PROVIDER meant ingestion
  // wrote rows the calendar would never read. Nothing would have failed — the board would simply have
  // stopped advancing while every run reported success. That is the exact failure this repository keeps
  // paying to rediscover, so it is pinned across every env shape rather than for the current one.
  for (const env of [{}, { DIVIDEND_PROVIDER: '' }, { DIVIDEND_PROVIDER: 'tiingo' },
    { DIVIDEND_PROVIDER: 'polygon' }, { DIVIDEND_PROVIDER: 'POLYGON' }, { DIVIDEND_PROVIDER: 'nonsense' }]) {
    const shown = calendarSource(env);
    const written = activeDividendProvider(env).id;
    ok(`⚠️ ingest and display agree for ${JSON.stringify(env)}`, shown === written, `writes ${written}, shows ${shown}`);
  }
  console.log(`         calendarSource() here = ${calendarSource()} · ingest provider = ${activeDividendProvider().id}`);
}

L('⚠️ 2 — measured against the live table: no duplicate reaches the reader');
{
  const to = plus(30);
  const [rows, total, sectors, types] = await Promise.all([
    calendarRange({ from: today, to, limit: 1000 }),
    calendarCount({ from: today, to }),
    calendarSectorCounts({ from: today, to }),
    calendarTypeCounts({ from: today, to }),
  ]);
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.ticker}|${String(r.ex_dividend_date).slice(0, 10)}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1);
  ok('⚠️ ZERO (ticker, ex-date) pairs appear more than once', dups.length === 0,
    dups.slice(0, 5).map(([k, n]) => `${k} ×${n}`).join(', '));
  ok('⚠️ the count equals the rows it describes', rows.length === total, `${rows.length} rows vs total ${total}`);
  ok('the sector facet sums to the same total', sectors.reduce((a, s) => a + s.n, 0) === total);
  ok('⚠️ …and so does the type facet', types.reduce((a, t) => a + t.n, 0) === total);
  // ⚠️ THE FACET MUST NOT APPLY THE FILTER IT DESCRIBES. Asked with a type already selected it has to
  // keep reporting every type in the window — otherwise the dropdown reads "1" for the chosen option
  // and "0" for all the others, which is the exact bug the sector facet's comment records. Mutation
  // testing found this uncovered: dropping `type: null` changes nothing unless a type is actually set,
  // so the check has to set one.
  const withFilter = await calendarTypeCounts({ from: today, to, type: types[0].type });
  ok('⚠️ the type facet ignores the type filter, as the sector facet ignores sector',
    withFilter.length === types.length && withFilter.reduce((a, t) => a + t.n, 0) === total,
    `${JSON.stringify(withFilter)} vs unfiltered ${JSON.stringify(types)}`);
  // ⚠️ AND THE STRUCTURAL GUARD, BECAUSE THE BEHAVIOURAL ONE ABOVE CANNOT DISCRIMINATE TODAY. The
  // licensed provider supplies no type, so 'unknown' is the ONLY value in the window — filtering by it
  // returns the same set whether or not the facet drops the filter, and mutation testing duly survived.
  // It will start discriminating the day a provider classifies types; until then this is what holds the
  // line. Both facets are checked, so neither can lose its exemption quietly.
  const storeText = code('src/lib/dividends/dividend-store.js');
  ok('⚠️ the type facet drops the type filter in its conditions',
    /calendarTypeCounts[\s\S]{0,400}?calendarConditions\(\{ from, to, dateCol, \.\.\.filters, type: null \}\)/.test(storeText));
  ok('…and the sector facet drops the sector filter',
    /calendarSectorCounts[\s\S]{0,400}?calendarConditions\(\{ from, to, dateCol, \.\.\.filters, sector: null \}\)/.test(storeText));
  // ⚠️ AND EVERY COUNTING QUERY SHARES THE ROWS' DISTINCT KEY. With one source there are no duplicate
  // rows left, so count(*) and count(distinct …) agree on today's data and no behavioural assertion can
  // tell them apart — a facet written with count(*) would pass every check above and then double its
  // numbers the day a second source is displayed again. This is the structural guard for that.
  const storeSrc = code('src/lib/dividends/dividend-store.js');
  const KEY = /count\(distinct \(\$\{dateCol\}, d\.ticker, d\.cash_amount, d\.payment_date, d\.record_date\)\)/g;
  const counts = (storeSrc.match(/count\(distinct |count\(\*\)::int as n/g) || []).length;
  ok('⚠️ every facet and count uses the rows’ distinct key',
    counts > 2 && (storeSrc.match(KEY) || []).length === counts,
    `${(storeSrc.match(KEY) || []).length} of ${counts} counting queries`);
  ok('the board is not empty, so these checks mean something', rows.length > 100, `${rows.length} rows`);
  ok('…and it is sorted by the organising date',
    rows.every((r, i) => i === 0 || String(rows[i - 1].ex_dividend_date) <= String(r.ex_dividend_date)));

  // ⚠️ THE THREE MEASURED CASES, BY NAME. Each was rendering twice; each must now render once.
  for (const t of ['NCDL', 'CMSC', 'GJT']) {
    const hits = rows.filter((r) => r.ticker === t);
    if (!hits.length) { console.log(`         (${t} not in this window — skipped)`); continue; }
    const byDate = new Map();
    for (const h of hits) byDate.set(String(h.ex_dividend_date).slice(0, 10), (byDate.get(String(h.ex_dividend_date).slice(0, 10)) || 0) + 1);
    ok(`⚠️ ${t} appears once per ex-date`, [...byDate.values()].every((n) => n === 1), JSON.stringify([...byDate]));
  }

  // ⚠️ AND THE OTHER SOURCE'S ROWS ARE STILL THERE — nothing was deleted to achieve this.
  const kept = await sql`select source, count(*)::int n from dividend_events group by source order by n desc`;
  ok('⚠️ no rows were deleted from the other provider',
    kept.length === 2 && kept.every((k) => k.n > 1000), JSON.stringify(kept));
  const leaked = await sql`select count(*)::int n from dividend_events where source <> ${calendarSource()}`;
  console.log(`         ${leaked[0].n} rows from the non-displayed source remain stored, unread by the calendar`);
}

L('⚠️ 3 — the type filter cannot offer an option that matches nothing');
{
  const to = plus(30);
  const types = await calendarTypeCounts({ from: today, to });
  const facet = typeOptions(types);
  ok('the facet is non-empty', facet.options.length > 0, JSON.stringify(types));
  ok('⚠️ every offered option has rows behind it', facet.options.every((o) => o.n > 0), JSON.stringify(facet.options));
  // ⚠️ THE DEAD-CONTROL BUG: three hard-coded options against a provider that supplies no type.
  const client = code('src/app/dividends/DividendsClient.jsx');
  ok('⚠️ the dropdown no longer hard-codes Regular/Special/Capital gain',
    !/<option value="regular">/.test(client) && !/<option value="special">/.test(client)
    && !/<option value="capital_gain">/.test(client));
  ok('…it renders the facet instead', /typeFacet\.options\.map/.test(client));
  ok('…derived from the API response', /typeOptions\(data\?\.types\)/.test(client));
  // Filtering by an offered value must return rows, which is the whole point.
  const first = facet.options[0].value;
  const n = await calendarCount({ from: today, to, type: first });
  ok(`⚠️ filtering by the offered "${first}" returns rows`, n > 0, String(n));
  ok('⚠️ …and unknown is labelled honestly, not relabelled "Regular"',
    facet.options.every((o) => o.value !== 'unknown' || o.label === 'Unclassified'));
  // The route must actually send it, or the client silently falls back to nothing.
  const route = code('src/app/api/dividends/calendar/route.js');
  ok('the route computes and returns the type facet',
    /calendarTypeCounts\(\{ from, to, mode, \.\.\.filters \}\)/.test(route) && /events, sectors, types,/.test(route));
  ok('…and the switched-off payload carries the same shape', /types: \[\]/.test(route));
}

L('⚠️ 4 — freshness describes the rows on the board, not the whole table');
{
  const sync = await dividendSyncState();
  const scoped = await sql`select count(*)::int n, max(updated_at)::text u from dividend_events where source = ${calendarSource()}`;
  const all = await sql`select count(*)::int n from dividend_events`;
  ok('⚠️ the event count is the displayed source only', sync.events === scoped[0].n,
    `${sync.events} vs source ${scoped[0].n} vs table ${all[0].n}`);
  ok('⚠️ …which is smaller than the whole table, so the scoping is doing work',
    scoped[0].n < all[0].n, `${scoped[0].n} of ${all[0].n}`);
  ok('asOf is populated', !!sync.updatedAt, String(sync.updatedAt));
  ok('…and upcoming is non-zero, so the calendar has a future', sync.upcoming > 0, String(sync.upcoming));
}

L('⚠️ 5 — a broken read is still not an empty calendar');
{
  // ⚠️ THE FAILURE-AS-ABSENCE RULE, RE-PINNED HERE because this change touched the read path. A
  // calendar whose entire content is dates must not answer "nothing is scheduled" when it means "the
  // query failed".
  const route = read('src/app/api/dividends/calendar/route.js');
  ok('⚠️ a read failure returns 503, not 200 with an empty list', /status: 503/.test(route));
  ok('…and does not leak the error to the caller', /error: 'calendar_unavailable'/.test(route)
    && !/e\.message \}/.test(route.replace(/console\.log[^\n]*/g, '')));
  ok('…and the switched-off state is a deliberate 200 with a flag, not an error',
    /enabled: false/.test(route) && /reason:/.test(route));
  const client = read('src/app/dividends/DividendsClient.jsx');
  ok('⚠️ the client treats a non-ok response as an error state', /!r\.ok/.test(client) || /throw/.test(client));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
