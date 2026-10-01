// MOVE ANY REMAINING UNLICENSED CANDLE ROWS OUT OF THE LIVE TABLE, THEN LOCK THE TABLE.
//
//   node --env-file=.env.local scripts/quarantine-unlicensed-candles.mjs [--apply] [--constraint]
//
// Runs read-only by default and prints exactly what it would do. --apply performs the move; --constraint
// additionally adds the CHECK constraint.
//
// ── ⚠️ WHY A QUARANTINE RATHER THAN A FILTER IN EVERY READER ─────────────────
//
// ticker_daily_candles is read directly by about forty files — charts, the Screener, breadth, the heatmap,
// movers, Fear & Greed, Consensus, Evidence, the congressional leaderboard, the hover chart, the
// server-rendered ticker pages. Gating each of them is forty chances to miss one, and forty places for
// the next person to add a forty-first without knowing the rule exists. The provenance audit found
// exactly that failure in two other systems: a six-route list that missed a seventh, and an eleven-job
// list that missed thirteen.
//
// The invariant that needs no list is: THE LIVE TABLE CONTAINS ONLY LICENSED ROWS. Then every reader is
// correct by construction, including ones not written yet.
//
// ── ⚠️ WHY A MOVE RATHER THAN A DELETE ───────────────────────────────────────
//
// The rows are evidence. They are what the provenance inventory counts, what proves which tickers the
// licensed rebuild could not cover, and what a future licensed agreement would make usable again.
// DELETE throws that away for no benefit; the licensing requirement is that the data not be SERVED.
// So rows are copied to ticker_daily_candles_unlicensed first, the copy is verified by count, and only
// then are they removed from the live table.
//
// ── ⚠️ AND THE CHECK CONSTRAINT IS THE POINT ─────────────────────────────────
//
// Postgres then refuses an unlicensed row at the storage layer, so no code path — a new reader, a revived
// writer, a well-meaning backfill script, a migration run by hand — can reintroduce one. That is a
// stronger guarantee than any number of application-level filters, and it cannot go stale.
import postgres from 'postgres';
import { LICENSED_CANDLE_SOURCES } from '../src/lib/licensing/providers.mjs';

const APPLY = process.argv.includes('--apply');
const CONSTRAIN = process.argv.includes('--constraint');
const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const LICENSED = [...LICENSED_CANDLE_SOURCES];

const show = async (label, q) => { const r = await q; console.log(`\n-- ${label}`); for (const x of r) console.log('   ' + JSON.stringify(x)); return r; };

await show('live candle population by source', sql`
  select source, count(*)::int rows, count(distinct ticker)::int tickers,
         min(date)::text oldest, max(date)::text newest
  from ticker_daily_candles group by source order by 2 desc`);

const [{ n: unlicensed }] = await sql`
  select count(*)::int n from ticker_daily_candles where not (source = any(${LICENSED}))`;
const [{ n: tickers }] = await sql`
  select count(distinct ticker)::int n from ticker_daily_candles where not (source = any(${LICENSED}))`;
console.log(`\nunlicensed rows in the live table: ${unlicensed} across ${tickers} tickers`);

// ⚠️ WHICH TICKERS WOULD LOSE HISTORY ENTIRELY, which is the question that decides whether this is safe
// to run. A ticker with licensed rows loses nothing visible; a ticker whose ONLY rows are unlicensed goes
// dark, and that is a product consequence somebody has to agree to rather than discover.
const orphans = await sql`
  select u.ticker, u.rows
    from (select ticker, count(*)::int rows from ticker_daily_candles
           where not (source = any(${LICENSED})) group by ticker) u
   where not exists (
     select 1 from ticker_daily_candles l
      where l.ticker = u.ticker and l.source = any(${LICENSED}))
   order by u.rows desc`;
console.log(`tickers that would have NO history left: ${orphans.length}`);
if (orphans.length) {
  console.log('  worst 25 by rows:');
  for (const o of orphans.slice(0, 25)) console.log(`    ${o.ticker.padEnd(10)} ${o.rows}`);
}

if (!APPLY) {
  console.log('\n[DRY RUN] nothing moved. Re-run with --apply (and --constraint to lock the table).');
  await sql.end();
  process.exit(0);
}

// 1. The quarantine table mirrors the live one, plus when a row was moved and by what.
await sql`CREATE TABLE IF NOT EXISTS ticker_daily_candles_unlicensed (
  ticker TEXT NOT NULL, date DATE NOT NULL,
  open DOUBLE PRECISION, high DOUBLE PRECISION, low DOUBLE PRECISION, close DOUBLE PRECISION,
  volume DOUBLE PRECISION, source TEXT NOT NULL,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL DEFAULT 'provider redistribution rights not established',
  PRIMARY KEY (ticker, date, source)
)`;

// 2. Copy, then verify the copy, then remove. In that order, and never the other.
const copied = await sql`
  insert into ticker_daily_candles_unlicensed (ticker, date, open, high, low, close, volume, source)
  select ticker, date, open, high, low, close, volume, source
    from ticker_daily_candles where not (source = any(${LICENSED}))
  on conflict (ticker, date, source) do nothing
  returning 1`;
console.log(`\ncopied to quarantine: ${copied.length}`);

const [{ n: inQuarantine }] = await sql`
  select count(*)::int n from ticker_daily_candles_unlicensed`;
const [{ n: stillLive }] = await sql`
  select count(*)::int n from ticker_daily_candles where not (source = any(${LICENSED}))`;
console.log(`quarantine now holds ${inQuarantine}; live table still has ${stillLive} unlicensed`);

// ⚠️ THE GUARD BEFORE THE DELETE. Every row about to be removed must already exist in the quarantine,
// matched on its own key — not merely "the counts look close".
const [{ n: unprotected }] = await sql`
  select count(*)::int n from ticker_daily_candles c
   where not (c.source = any(${LICENSED}))
     and not exists (select 1 from ticker_daily_candles_unlicensed q
                      where q.ticker = c.ticker and q.date = c.date and q.source = c.source)`;
if (unprotected > 0) {
  console.error(`\nREFUSING TO DELETE: ${unprotected} unlicensed rows are not in the quarantine.`);
  await sql.end();
  process.exit(1);
}
console.log('every unlicensed row is safely copied — proceeding to remove from the live table');

const del = await sql`delete from ticker_daily_candles where not (source = any(${LICENSED})) returning 1`;
console.log(`removed from the live table: ${del.length}`);

await show('live candle population after', sql`
  select source, count(*)::int rows, count(distinct ticker)::int tickers from ticker_daily_candles group by 1 order by 2 desc`);

// 3. Lock it.
if (CONSTRAIN) {
  const list = LICENSED.map((s) => `'${s}'`).join(',');
  try {
    await sql.unsafe(`ALTER TABLE ticker_daily_candles
      ADD CONSTRAINT ck_candle_source_licensed CHECK (source = ANY (ARRAY[${list}]::text[]))`);
    console.log(`\nCHECK constraint added: source must be one of ${list}`);
  } catch (e) {
    console.log(`\nconstraint not added: ${e.message}`);
  }
  // Prove it bites, then roll the probe back. A constraint nobody tested is a comment.
  try {
    await sql.begin(async (tx) => {
      await tx`insert into ticker_daily_candles (ticker, date, open, high, low, close, volume, source)
               values ('ZZPROBE', '1990-01-02', 1, 1, 1, 1, 0, 'polygon')`;
      throw new Error('INSERT SUCCEEDED — the constraint does not bite');
    });
  } catch (e) {
    if (/INSERT SUCCEEDED/.test(e.message)) { console.error(`  ${e.message}`); process.exitCode = 1; }
    else console.log(`  verified: an unlicensed insert is refused by the database (${String(e.message).slice(0, 80)})`);
  }
}

await sql.end();
