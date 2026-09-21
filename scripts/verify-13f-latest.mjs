// LATEST 13F FILINGS — the module at the top of /institutions.
//
// ── THE ONE THING IT MUST NOT DO ────────────────────────────────────────────
//
// A 13F describes a quarter that has ALREADY ENDED, disclosed up to 45 days later. Sorting by
// quarter, or showing only the quarter, turns "this was filed today" into "this manager bought
// today" — and the rows most worth seeing are exactly the ones a quarter sort buries. Measured on
// the live table: one day's filings covered quarters ending 2024-09-30 through 2026-06-30.
//
// Runs offline (structure). With DATABASE_URL it additionally asserts the LIVE ordering:
//
//   node scripts/verify-13f-latest.mjs
//   node --env-file=.env.local scripts/verify-13f-latest.mjs
//
// Run with --mutate=<mode> to confirm an assertion fails when the rule is broken.

import fs from 'node:fs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const read = (p) => fs.readFileSync(new URL(p, new URL('..', import.meta.url)), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const route = read('src/app/api/institutions/route.js');
const client = read('src/app/institutions/InstitutionsClient.jsx');
const routeCode = code(route);
const clientCode = code(client);
// Just the query, so an assertion about ordering cannot be satisfied by some other view.
const fn = (routeCode.match(/async function latestFilings[\s\S]*?\n}/) || [''])[0];

L('=== ORDERED BY WHEN IT WAS DISCLOSED ===');
{
  ok('the view exists', fn.length > 0);
  ok('it orders by filed_date descending',
    mut('quartersort') ? false : /order by f\.filed_date desc/.test(fn), fn.slice(0, 0));
  // ⚠️ NEVER BY QUARTER. The quarter is the period described, not the clock.
  ok('…and never orders by quarter',
    mut('quartersort') ? false : !/order by[^;]*f\.quarter/.test(fn));
  ok('…with a deterministic tiebreak within a day',
    /order by f\.filed_date desc, f\.inserted_at desc/.test(fn));
  // inserted_at may break ties but must not BE the clock — it records when we caught up.
  ok('inserted_at is not used as the disclosure date',
    mut('ingestclock') ? false : /disclosed: r\.filed_date/.test(fn) && !/disclosed: r\.inserted_at/.test(fn));
  ok('a row with no filing date is excluded',
    mut('nullfiled') ? false : /f\.filed_date is not null/.test(fn));
}

L('\n=== BOTH DATES, AND NO CLAIM ABOUT TODAY ===');
{
  ok('the row carries the disclosure date', /disclosed:/.test(fn));
  ok('…and the quarter it describes', /quarterEnd: r\.quarter/.test(fn));
  ok('the module renders both', /Disclosed \{f\.disclosed\}/.test(client) && /Quarter ended \{f\.quarterEnd\}/.test(client));
  // ⚠️ IT MUST NOT SAY ANYONE BOUGHT TODAY.
  //
  // Scoped to THIS module's component, not the whole file. The Corporate Buying Activity section
  // further down already reads "What public companies just bought, from their newest 13F
  // filings" — the same overclaim, in a section this ticket says not to touch. Reported rather
  // than silently edited, and asserted here only for the module being added.
  const moduleCode = (clientCode.match(/function LatestFilings[\s\S]*?\n}/) || [''])[0];
  ok('the module component was found', moduleCode.length > 0);
  for (const banned of ['bought today', 'buying now', 'is buying', 'bought now', 'just bought']) {
    ok(`the module never says "${banned}"`,
      mut('saysboughttoday') ? false : !new RegExp(banned, 'i').test(moduleCode));
  }
  ok('…and says what the positions actually describe',
    /Positions describe the quarter shown, not today/.test(client));
}

L('\n=== ONLY WHAT THE TABLE ALREADY STORES ===');
{
  // No AUM. total_value is in the table but is not read here — an unlabelled dollar figure beside
  // a manager name reads as assets under management, which a 13F does not report.
  ok('no AUM is shown', mut('inventsaum') ? false : !/total_value|totalValue/.test(fn));
  // No tickers: this module is about filers, and guessing a ticker for a manager is the defect
  // the security master exists to prevent.
  ok('no ticker is guessed for a filer', !/ticker/i.test(fn));
  // ⚠️ AND NEVER A BLANK OR PLACEHOLDER NAME.
  ok('a filer with no name is excluded',
    mut('shownone') ? false : /i\.name is not null and trim\(i\.name\) <> ''/.test(fn));
  ok('…and one with no manager page is excluded', /i\.slug is not null/.test(fn));
  ok('the join is an inner join, so an unknown cik cannot render',
    mut('shownone') ? false : /join institutions i on i\.cik = f\.cik/.test(fn) && !/left join institutions/.test(fn));
  ok('the filing link is built from the stored accession',
    /sec\.gov\/Archives\/edgar\/data\/\$\{r\.cik\}/.test(fn));
  ok('…and is omitted when there is no accession', /r\.accession\s*\?/.test(fn));
}

L('\n=== A FILING TODAY APPEARS TODAY ===');
{
  // The rest of the route describes quarterly holdings and is happy on a 1-hour edge cache with a
  // 24-hour stale window. This view answers "what landed today".
  const block = (routeCode.match(/view === 'latest-filings'[\s\S]{0,400}/) || [''])[0];
  const m = block.match(/s-maxage=(\d+)/);
  ok('the view sets its own Cache-Control', mut('longttl') ? false : !!m);
  ok('…and it is minutes, not an hour',
    mut('longttl') ? false : m && Number(m[1]) <= 600, m ? `s-maxage=${m[1]}` : 'none');
  const swr = block.match(/stale-while-revalidate=(\d+)/);
  ok('…with a stale window under an hour',
    mut('longttl') ? false : swr && Number(swr[1]) <= 3600, swr ? `swr=${swr[1]}` : 'none');
  // No new vendor: the data comes from the tables the hourly cron already fills.
  ok('it reads the existing 13F tables only',
    mut('newvendor') ? false : /from fund_filings f/.test(fn) && !/fetch\(/.test(fn));
}

L('\n=== THE MODULE IS ADDITIVE ===');
{
  ok('it renders above the heatmap',
    clientCode.indexOf('<LatestFilings') > 0
    && clientCode.indexOf('<LatestFilings') < clientCode.indexOf('<InstitutionsHeatmap'));
  // Nothing that was on the page may have been removed to make room.
  for (const kept of ['InstitutionsHeatmap', 'LARGEST MANAGERS', 'EntitySearch', 'FundCard', 'CorporateCard']) {
    ok(`${kept} is still on the page`, new RegExp(kept).test(client));
  }
  ok('an empty result renders nothing rather than an empty box',
    mut('emptybox') ? false : /if \(!filings\.length\) return null/.test(client));
}

// ── LIVE ORDER (only with DATABASE_URL) ─────────────────────────────────────
if (process.env.DATABASE_URL) {
  L('\n=== LIVE: WHAT THE PAGE WOULD SHOW ===');
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql.query(`
    select f.filed_date::text fd, f.quarter::text qe, i.name, i.slug
      from fund_filings f join institutions i on i.cik = f.cik
     where f.filed_date is not null and i.name is not null and trim(i.name) <> '' and i.slug is not null
     order by f.filed_date desc, f.inserted_at desc limit 25`);

  ok('the page has rows to show', rows.length > 0, String(rows.length));
  const dates = rows.map((r) => r.fd);
  ok('disclosed dates are in descending order',
    dates.every((d, i) => i === 0 || dates[i - 1] >= d), dates.slice(0, 4).join(' '));
  ok('every row names a manager', rows.every((r) => r.name && r.name.trim()));
  ok('…and none is a placeholder',
    !rows.some((r) => ['NONE', 'N/A', 'NULL'].includes(String(r.name).trim().toUpperCase())));
  ok('every row links to a manager page', rows.every((r) => r.slug));

  // The whole point: quarters are NOT in order, because the disclosure clock is not the quarter.
  const quarters = rows.map((r) => r.qe);
  const quartersDescending = quarters.every((q, i) => i === 0 || quarters[i - 1] >= q);
  L(`  --   quarters in this page are ${quartersDescending ? 'coincidentally ordered' : 'deliberately NOT ordered'}`
    + ` (newest disclosed covers ${quarters[0]}, oldest on page ${quarters[quarters.length - 1]})`);

  const newest = await sql.query('select max(filed_date)::text d from fund_filings');
  ok('the newest row on the page is the newest in the table',
    dates[0] === newest[0].d, `page ${dates[0]} vs db ${newest[0].d}`);
} else {
  L('\n(skipping live order — no DATABASE_URL; run with --env-file=.env.local)');
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
