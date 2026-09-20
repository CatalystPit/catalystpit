// STEP A — SNAPSHOT THE EXACT ROWS THE REPAIR WILL MODIFY. Writes only to the backup table.
//
// Rollback must not depend on a vendor still being willing and able to serve the same numbers, so
// the previous production state is copied verbatim first: every column, the provenance, the run id
// and the timestamp. Restoring is then a single UPDATE ... FROM against this table.
//
// ── WHICH ROWS ──────────────────────────────────────────────────────────────
//
// The canonical policy says trader-facing history is SPLIT-ADJUSTED. Polygon rows already are.
// Tiingo rows are TOTAL RETURN, so within the 16 confirmed tickers it is the TIINGO rows that are
// on the wrong convention and those alone that change. Unaffected tickers are not touched, and
// nothing outside the confirmed set is considered — an unverified candidate is not corruption.
//
// Run: node --env-file=.env.local research/seam-repair-snapshot.mjs

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const L = (s = '') => console.log(s);

import { CONFIRMED } from './seam-confirmed.mjs';

const RUN_ID = `seam_repair_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;

await sql.query(`
  CREATE TABLE IF NOT EXISTS ticker_daily_candles_backup (
    run_id      text NOT NULL,
    ticker      text NOT NULL,
    date        date NOT NULL,
    open        double precision NOT NULL,
    high        double precision NOT NULL,
    low         double precision NOT NULL,
    close       double precision NOT NULL,
    volume      double precision NOT NULL,
    source      text NOT NULL,
    backed_up_at timestamptz NOT NULL DEFAULT now(),
    reason      text,
    PRIMARY KEY (run_id, ticker, date))`);

L(`run ${RUN_ID}`);
L(`confirmed seam tickers: ${CONFIRMED.length}`);

L('\n=== rows in scope (tiingo-sourced rows on the 16 confirmed tickers) ===');
const scope = await sql.query(`
  select ticker, source, count(*)::int n, min(date)::text mn, max(date)::text mx
    from ticker_daily_candles
   where ticker = any($1) group by ticker, source order by ticker, source`, [CONFIRMED]);
let toChange = 0;
L(`${'ticker'.padEnd(8)} ${'source'.padEnd(9)} ${'rows'.padStart(7)}  range`);
for (const r of scope) {
  if (r.source === 'tiingo') toChange += Number(r.n);
  L(`${r.ticker.padEnd(8)} ${String(r.source).padEnd(9)} ${String(r.n).padStart(7)}  ${r.mn} -> ${r.mx}`);
}
L(`\nrows that will be modified (tiingo only): ${toChange.toLocaleString()}`);

const inserted = await sql.query(`
  insert into ticker_daily_candles_backup (run_id, ticker, date, open, high, low, close, volume, source, reason)
  select $1, ticker, date, open, high, low, close, volume, source,
         'pre-repair snapshot: tiingo rows on confirmed adjustment-seam tickers'
    from ticker_daily_candles
   where ticker = any($2) and source = 'tiingo'
  on conflict (run_id, ticker, date) do nothing
  returning 1`, [RUN_ID, CONFIRMED]);
L(`\nsnapshot written: ${inserted.length.toLocaleString()} rows`);

// Prove the snapshot is complete and faithful before anything is allowed to change.
const verify = await sql.query(`
  select
    (select count(*) from ticker_daily_candles where ticker = any($1) and source='tiingo')::int live,
    (select count(*) from ticker_daily_candles_backup where run_id=$2)::int backed_up,
    (select count(*) from ticker_daily_candles c
       join ticker_daily_candles_backup b
         on b.run_id=$2 and b.ticker=c.ticker and b.date=c.date
      where c.source='tiingo' and c.ticker = any($1)
        and (c.open is distinct from b.open or c.high is distinct from b.high
          or c.low is distinct from b.low or c.close is distinct from b.close
          or c.volume is distinct from b.volume or c.source is distinct from b.source))::int mismatched`,
[CONFIRMED, RUN_ID]);
const v = verify[0];
L('\n=== snapshot verification ===');
L(`  live rows in scope : ${v.live}`);
L(`  rows backed up     : ${v.backed_up}`);
L(`  value mismatches   : ${v.mismatched}`);
const okSnap = Number(v.live) === Number(v.backed_up) && Number(v.mismatched) === 0;
L(`  SNAPSHOT ${okSnap ? 'COMPLETE AND FAITHFUL' : 'INCOMPLETE — DO NOT PROCEED'}`);

L('\nrollback for this run:');
L('  update ticker_daily_candles c set open=b.open, high=b.high, low=b.low, close=b.close,');
L('         volume=b.volume, source=b.source');
L('    from ticker_daily_candles_backup b');
L(`   where b.run_id='${RUN_ID}' and c.ticker=b.ticker and c.date=b.date;`);
L(`\nRUN_ID=${RUN_ID}`);
process.exit(okSnap ? 0 : 1);
