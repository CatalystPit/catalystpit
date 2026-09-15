// INSTITUTIONAL CUSIP → TICKER REPAIR, on authoritative evidence only.
//
// Run AFTER the targeted re-resolution pass (/api/cron/institutions-universe?disputed=1), which asks
// OpenFIGI directly for a security-level answer on every CUSIP sitting on a contaminated ticker.
//
// The rule is deliberately not a choice between candidates. For every holding on a ticker that
// carries more than one CUSIP issuer prefix:
//
//   cusip_map says this CUSIP is security X, from an authoritative source   → ticker = X
//   anything else                                                          → ticker = NULL
//
// So an Invesco fund misfiled onto IVZ is not merely stripped of a ticker — it is moved to its own,
// if OpenFIGI knows it. Nothing is guessed: no issuer-name agreement, no sponsor inference, no
// plurality, no value dominance, no hand-maintained exceptions. Every one of those was measured and
// each keeps the wrong security on some real ticker.
//
// The raw 13F facts are untouched. Only `ticker` moves, and only on holdings whose ticker is already
// in dispute.
//
//   node --env-file=.env.local scripts/repair-institutional-tickers.mjs            (dry run)
//   node --env-file=.env.local scripts/repair-institutional-tickers.mjs --apply

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const APPLY = process.argv.includes('--apply');
// REASSIGN-ONLY: write the positive corrections, null nothing.
//
// The two halves of this repair rest on opposite kinds of evidence. A reassignment happens because an
// authoritative source POSITIVELY names a different security for that CUSIP — per-CUSIP proof, and it
// cannot destroy a correct mapping. A null happens because the authority could not map the CUSIP,
// which is an ABSENCE of evidence, and OpenFIGI cannot map foreign CINS at all: BlackRock Inc's own
// 9,231 rows and Invesco Ltd's own 740 rows sit in that bucket and are correct today.
//
// So this mode runs the first UPDATE and skips the second. The 60% coverage guard is untouched and
// still blocks the nulling half, which is the half it was built to stop.
const REASSIGN_ONLY = process.argv.includes('--reassign-only');
const n = (x) => Number(x).toLocaleString('en-US');
const AUTH = ['openfigi', 'manual', 'consensus'];

// Tickers carrying CUSIPs from more than one issuer. Characters 1-6 of a CUSIP are the issuer.
const DISPUTED = `
  with pfx as (
    select ticker, left(cusip,6) p from fund_holdings
     where ticker is not null and cusip ~ '^[0-9A-Z]{9}$'
     group by ticker, left(cusip,6))
  select ticker from pfx group by ticker having count(*) > 1`;

const before = (await sql.query(`
  select count(*)::int rows,
         count(*) filter (where ticker is not null)::int with_ticker,
         count(*) filter (where ticker is null)::int null_ticker
    from fund_holdings`))[0];
const [dis] = await sql.query(`select count(*)::int t from (${DISPUTED}) d`);
const [scope] = await sql.query(`
  select count(*)::int rows, count(distinct cusip)::int cusips
    from fund_holdings where ticker is not null and cusip ~ '^[0-9A-Z]{9}$'
      and ticker in (${DISPUTED})`);

console.log('=== BEFORE ===');
console.log('  fund_holdings rows        ' + n(before.rows));
console.log('  with ticker               ' + n(before.with_ticker));
console.log('  null ticker               ' + n(before.null_ticker));
console.log('  contaminated tickers      ' + n(dis.t));
console.log('  holdings in scope         ' + n(scope.rows) + '   across ' + n(scope.cusips) + ' CUSIPs');

// How much authoritative evidence do we now have for the disputed CUSIPs?
const [cov] = await sql.query(`
  select count(distinct f.cusip)::int cusips,
         count(distinct f.cusip) filter (where m.source = any($1) and m.ticker is not null)::int authoritative,
         count(distinct f.cusip) filter (where m.source = any($1) and m.ticker is null)::int auth_unresolved,
         count(distinct f.cusip) filter (where m.source is null or not (m.source = any($1)))::int no_authority
    from fund_holdings f left join cusip_map m on m.cusip = f.cusip
   where f.ticker is not null and f.cusip ~ '^[0-9A-Z]{9}$' and f.ticker in (${DISPUTED})`, [AUTH]);
console.log('\n=== AUTHORITATIVE COVERAGE OF THE DISPUTED CUSIPs ===');
console.log('  disputed CUSIPs                     ' + n(cov.cusips));
console.log('  authoritative mapping, has a ticker ' + n(cov.authoritative) + '   -> reassign or confirm');
console.log('  authoritative, OpenFIGI says none   ' + n(cov.auth_unresolved) + '   -> NULL');
console.log('  no authoritative mapping at all     ' + n(cov.no_authority) + '   -> NULL');
// ORDER MATTERS, AND GETTING IT WRONG IS DESTRUCTIVE. Before the re-resolution pass runs, only 93 of
// the 2,307 disputed CUSIPs carry authoritative evidence, so "authoritative or NULL" would strip
// 1.3M holdings — a quarter of every ticker assignment we hold — purely because nobody had asked
// OpenFIGI yet. The answer to that is to ask, not to proceed.
const coverage = cov.authoritative / Math.max(1, cov.cusips);
console.log('  authoritative coverage              ' + (100 * coverage).toFixed(1) + '%');
if (APPLY && REASSIGN_ONLY && coverage < 0.6) {
  console.log('  (coverage is below the guard, which is why nothing will be NULLed — reassign-only'
    + ' writes the positive corrections and leaves every unresolved holding alone)');
}
if (APPLY && !REASSIGN_ONLY && coverage < 0.6) {
  console.error('\n  REFUSING TO APPLY: only ' + (100 * coverage).toFixed(1) + '% of disputed CUSIPs have'
    + ' authoritative evidence.');
  console.error('  Run the targeted re-resolution first, then re-run this:');
  console.error('    /api/cron/institutions-universe?disputed=1&tickerCap=2500');
  process.exit(2);
}

// What the repair will do, per holding.
const [plan] = await sql.query(`
  select
    count(*) filter (where m.source = any($1) and m.ticker is not null and m.ticker = f.ticker)::int confirmed,
    count(*) filter (where m.source = any($1) and m.ticker is not null and m.ticker <> f.ticker)::int reassigned,
    count(*) filter (where m.source = any($1) and m.ticker is null)::int nulled_auth,
    count(*) filter (where m.source is null or not (m.source = any($1)))::int nulled_noauth
    from fund_holdings f left join cusip_map m on m.cusip = f.cusip
   where f.ticker is not null and f.cusip ~ '^[0-9A-Z]{9}$' and f.ticker in (${DISPUTED})`, [AUTH]);
console.log('\n=== PLAN (holdings) ===');
console.log('  ticker CONFIRMED by authority       ' + n(plan.confirmed));
console.log('  ticker REASSIGNED to the right one  ' + n(plan.reassigned));
console.log('  NULLED, authority says unresolved   ' + n(plan.nulled_auth));
console.log('  NULLED, no authority                ' + n(plan.nulled_noauth));
console.log('  ---');
console.log('  total changed                       ' + n(plan.reassigned + plan.nulled_auth + plan.nulled_noauth));

const sample = await sql.query(`
  select f.ticker old_ticker, m.ticker new_ticker, count(*)::int rows,
         (array_agg(f.issuer order by f.value desc nulls last))[1] issuer
    from fund_holdings f join cusip_map m on m.cusip = f.cusip
   where f.ticker is not null and f.cusip ~ '^[0-9A-Z]{9}$' and f.ticker in (${DISPUTED})
     and m.source = any($1) and m.ticker is not null and m.ticker <> f.ticker
   group by 1,2 order by count(*) desc limit 12`, [AUTH]);
console.log('\n  largest reassignments:');
for (const r of sample) console.log('    ' + String(r.old_ticker).padEnd(9) + '-> ' + String(r.new_ticker).padEnd(9)
  + String(r.rows).padStart(6) + ' rows   ' + String(r.issuer || '').slice(0, 36));

if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); process.exit(0); }

console.log('\n=== APPLYING (fund_holdings.ticker only)'
  + (REASSIGN_ONLY ? ' — REASSIGN-ONLY, nothing will be nulled' : '') + ' ===');

// The exact CUSIPs about to move. Captured before the write so the KV purge and the cusip_map
// cleanup below touch precisely this set and nothing else.
const moved = (await sql.query(`
  select distinct f.cusip from fund_holdings f join cusip_map m on m.cusip = f.cusip
   where f.ticker is not null and f.cusip ~ '^[0-9A-Z]{9}$' and f.ticker in (${DISPUTED})
     and m.source = any($1) and m.ticker is not null and m.ticker <> f.ticker`, [AUTH]))
  .map((r) => r.cusip);
console.log('  CUSIPs being corrected  ' + n(moved.length));

// Reassign where an authoritative mapping names a different security.
const r1 = await sql.query(`
  update fund_holdings f set ticker = m.ticker
    from cusip_map m
   where m.cusip = f.cusip and m.source = any($1) and m.ticker is not null
     and f.ticker is not null and f.cusip ~ '^[0-9A-Z]{9}$'
     and f.ticker <> m.ticker
     and f.ticker in (${DISPUTED})`, [AUTH]);
console.log('  reassigned  ' + n(r1.rowCount ?? plan.reassigned));

if (!REASSIGN_ONLY) {
  // NULL everything the authority cannot vouch for. Raw facts stay; only the derived ticker goes.
  const r2 = await sql.query(`
    update fund_holdings f set ticker = null
     where f.ticker is not null and f.cusip ~ '^[0-9A-Z]{9}$'
       and f.ticker in (${DISPUTED})
       and not exists (
         select 1 from cusip_map m
          where m.cusip = f.cusip and m.source = any($1) and m.ticker is not null)`, [AUTH]);
  console.log('  nulled      ' + n(r2.rowCount ?? (plan.nulled_auth + plan.nulled_noauth)));
} else {
  console.log('  nulled      0   (reassign-only: ' + n(plan.nulled_auth + plan.nulled_noauth)
    + ' unresolved holdings left exactly as they are)');
}

// KV holds a 90-day CUSIP→ticker cache with no invalidation path. A reassigned CUSIP whose stale key
// survives would be promoted straight back the next time resolveCusips() sees it, undoing the write.
// ONLY the reassigned CUSIPs are touched; no other key is read or removed.
const KV_URL = process.env.KV_REST_API_URL, KV_TOKEN = process.env.KV_REST_API_TOKEN;
let kvPurged = 0, kvMissing = 0;
if (KV_URL && KV_TOKEN && moved.length) {
  for (let i = 0; i < moved.length; i += 25) {
    const batch = moved.slice(i, i + 25);
    const res = await Promise.all(batch.map((c) =>
      fetch(`${KV_URL}/del/${encodeURIComponent(`catalystpit:cusip:${c}`)}`,
        { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` } })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    for (const r of res) { if (r && Number(r.result) > 0) kvPurged++; else kvMissing++; }
  }
}
console.log('  KV cusip keys purged  ' + n(kvPurged) + '   (already absent: ' + n(kvMissing) + ')');

// cusip_map hygiene: a name-inferred row is dead weight once the authority has answered the same
// CUSIP. Scoped to the CUSIPs this run actually corrected.
const r3 = moved.length ? await sql.query(`
  delete from cusip_map
   where source = 'sec-name' and cusip = any($1)
     and exists (select 1 from cusip_map m2 where m2.cusip = cusip_map.cusip and m2.source = any($2))`,
  [moved, AUTH]) : { rowCount: 0 };
console.log('  cusip_map sec-name rows removed ' + n(r3.rowCount ?? 0));

const after = (await sql.query(`
  select count(*)::int rows,
         count(*) filter (where ticker is not null)::int with_ticker,
         count(*) filter (where ticker is null)::int null_ticker
    from fund_holdings`))[0];
const [dis2] = await sql.query(`select count(*)::int t from (${DISPUTED}) d`);
console.log('\n=== AFTER ===');
console.log('  rows          ' + n(after.rows) + '   (unchanged: ' + (after.rows === before.rows) + ')');
console.log('  with ticker   ' + n(before.with_ticker) + ' -> ' + n(after.with_ticker));
console.log('  null ticker   ' + n(before.null_ticker) + ' -> ' + n(after.null_ticker));
console.log('  contaminated tickers  ' + n(dis.t) + ' -> ' + n(dis2.t));
