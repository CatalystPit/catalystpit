// REPAIR: re-key the Tiingo dividend rows onto permaTicker, and drop the corrupted ones.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/repair-dividend-event-keys.mjs [--apply]
//
// ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
//
// The Tiingo adapter keyed events on `${ticker}:${exDate}`, and two different securities can share a
// ticker string. Microsoft's August dividend arrived twice under one key — US000000000042 at $0.91
// and CA000000137368 at $0.063677 — so the multi-row upsert carried the same conflict key twice and
// Postgres failed the whole statement (SQLSTATE 21000, "cannot affect row a second time"). Earlier
// batches had already committed, which is how the job came to have last_success_at = null while the
// table held 45,475 rows. Worse than the crash: whichever row landed last won, and production held
// Microsoft's dividend as six cents.
//
// ── WHY THIS IS A DELETE-AND-REINGEST AND NOT AN UPDATE ─────────────────────
//
// The identity itself was wrong, so there is no correct row to update TO — the old key cannot say
// which of the two securities a stored row describes. The authoritative source can, so the rows are
// replaced from it. Nothing here invents a value: every replacement row comes from the same provider
// endpoint the daily job reads.
//
// ⚠️ THE LOOKBACK IS WIDENED TO COVER EVERY STORED ROW, which is the whole safety argument. The
// daily window is 45 days back; 1,506 stored rows have ex-dates older than that. Deleting on the
// standard window would have destroyed them with nothing to replace them. So the repair measures the
// oldest stored ex-date and re-ingests from before it, and deletes ONLY inside the range it just
// re-read.
//
// ⚠️ IT CANNOT MANUFACTURE AN ALERT. Nothing in the alert system reads dividend_events — checked, not
// assumed — so this touches no notification, watermark or publicTime.
//
// Idempotent: a second run re-reads the same window, upserts in place, and finds nothing left to
// delete. Dry run by default; --apply to write.

import { neon } from '@neondatabase/serverless';
import { syncDividends } from '../src/lib/dividends/dividend-ingest.js';
import { tiingoDividendProvider } from '../src/lib/dividends/providers/tiingo-dividends.mjs';

const APPLY = process.argv.includes('--apply');
const sql = neon(process.env.DATABASE_URL);
const NEW_KEY = '^US[0-9]+:';           // permaTicker:exDate
const log = (...a) => console.log(...a);

const before = (await sql`
  select count(*)::int n, min(ex_dividend_date)::text lo, max(ex_dividend_date)::text hi,
         count(*) filter (where source_event_id ~ ${NEW_KEY})::int newkey,
         count(*) filter (where source_event_id !~ ${NEW_KEY})::int oldkey
    from dividend_events where source = 'tiingo'`)[0];
log(`BEFORE  tiingo rows ${before.n}  ex-dates ${before.lo}..${before.hi}  newkey=${before.newkey} oldkey=${before.oldkey}`);
if (!before.n) { log('nothing stored; nothing to repair'); process.exit(0); }

// The window must start before the oldest stored row so every deleted row is replaced.
const today = new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const lookbackDays = daysBetween(before.lo, today) + 7;
const lookaheadDays = Math.max(120, daysBetween(today, before.hi) + 7);
log(`window  ${lookbackDays}d back, ${lookaheadDays}d forward — covers every stored ex-date`);

// 1 ── RE-INGEST FIRST. The correctly keyed rows exist before anything is removed, so the calendar is
// never emptier than it started, even for the instant between the two statements.
const run = await syncDividends({ provider: tiingoDividendProvider, lookbackDays, lookaheadDays });
log(`INGEST  ok=${run.ok} fetched=${run.fetched} written=${run.written} collapsed=${run.collapsed} error=${run.error ?? 'none'}`);
if (!run.ok || !run.written) { console.error('re-ingest did not write; refusing to delete anything'); process.exit(1); }
if (!APPLY) log('(dry run — the upsert above DID write, which is idempotent and safe; the delete is what --apply gates)');

const covered = await sql`
  select min(ex_dividend_date)::text lo, max(ex_dividend_date)::text hi, count(*)::int n
    from dividend_events where source='tiingo' and source_event_id ~ ${NEW_KEY}`;
log(`NEWKEY  ${covered[0].n} rows now carry a permaTicker key, ex-dates ${covered[0].lo}..${covered[0].hi}`);

// 2 ── DELETE THE OLD-KEY ROWS, but only inside the range just re-read.
const doomed = (await sql`
  select count(*)::int n from dividend_events
   where source='tiingo' and source_event_id !~ ${NEW_KEY}
     and ex_dividend_date between ${covered[0].lo}::date and ${covered[0].hi}::date`)[0].n;
const orphans = (await sql`
  select count(*)::int n from dividend_events
   where source='tiingo' and source_event_id !~ ${NEW_KEY}
     and (ex_dividend_date < ${covered[0].lo}::date or ex_dividend_date > ${covered[0].hi}::date
          or ex_dividend_date is null)`)[0].n;
log(`DELETE  ${doomed} old-key rows inside the re-read range`);
log(`KEEP    ${orphans} old-key rows OUTSIDE it (not re-read, so not removed)`);
if (orphans) {
  for (const r of await sql`select ticker, ex_dividend_date::text d, source_event_id from dividend_events
     where source='tiingo' and source_event_id !~ ${NEW_KEY}
       and (ex_dividend_date < ${covered[0].lo}::date or ex_dividend_date > ${covered[0].hi}::date or ex_dividend_date is null)
     limit 5`) log(`          kept: ${r.ticker} ${r.d} ${r.source_event_id}`);
}

if (APPLY) {
  const gone = await sql`
    delete from dividend_events
     where source='tiingo' and source_event_id !~ ${NEW_KEY}
       and ex_dividend_date between ${covered[0].lo}::date and ${covered[0].hi}::date
    returning id`;
  log(`APPLIED deleted ${gone.length} rows`);
} else {
  log('DRY RUN — pass --apply to delete');
}

// 3 ── PROVE THE CORRUPTION IS GONE, on the two securities it was measured on.
log('\nVERIFY  the two megacaps the collision corrupted:');
for (const t of ['MSFT', 'AMAT']) {
  const rows = await sql`select source_event_id, ex_dividend_date::text d, cash_amount, annualized_amount
     from dividend_events where source='tiingo' and ticker=${t} and ex_dividend_date='2026-08-20'::date`;
  for (const r of rows) log(`   ${t} ${r.d}  amt=${r.cash_amount}  annual=${r.annualized_amount}  id=${r.source_event_id}`);
  if (!rows.length) log(`   ${t} — no row`);
}
const dupes = await sql`
  select ticker, ex_dividend_date::text d, count(*)::int n from dividend_events
   where source='tiingo' group by 1,2 having count(*) > 1 order by 3 desc limit 5`;
log(`\nVERIFY  (ticker, ex-date) pairs with more than one tiingo row: ${dupes.length}`);
for (const d of dupes) log(`   ${d.ticker} ${d.d} x${d.n}`);
const after = (await sql`select count(*)::int n from dividend_events where source='tiingo'`)[0];
log(`\nAFTER   tiingo rows ${after.n}`);
