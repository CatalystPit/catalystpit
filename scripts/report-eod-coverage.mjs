// HOW MUCH OF THE LICENSED UNIVERSE HAS THE LATEST SESSION?
//
//   node --env-file=.env.local scripts/report-eod-coverage.mjs [--min-pct=85]
//
// ⚠️ THIS IS THE ALARM, NOT THE REPAIR. The screener prices every row from the two most recent dates
// present in ticker_daily_candles, and that coverage decayed from 13,391 tickers to 112 over several
// weeks with nothing noticing — because nothing was looking. A nightly appender that silently does
// less and less is the same failure wearing a cron badge, so the maintenance job ends with this and
// FAILS when coverage drops, which is what turns a slow rot into a notification.
//
// Read-only. It writes nothing and repairs nothing.

import postgres from 'postgres';
import { LICENSED_CANDLE_SOURCES } from '../src/lib/licensing/providers.mjs';
// ⚠️ THE SAME RULE THE SCREENER PRICES FROM. The first version of this script took the newest date in
// the table, which is how it reported 0.0% coverage on a Sunday — reproducing, inside the alarm, the
// very defect the alarm was written to catch. An alarm that fires every weekend teaches you to ignore
// it, so there is one shared rule rather than two implementations that agree on weekdays.
import { pickSessionDates } from '../src/lib/market/session-quorum.mjs';

const args = process.argv.slice(2);
const MIN_PCT = Number((args.find((a) => a.startsWith('--min-pct=')) || '').split('=')[1]) || 85;
const SOURCE = LICENSED_CANDLE_SOURCES[0];
const sql = postgres(process.env.DATABASE_URL, { max: 2 });

// The universe that CAN have a bar: tickers with licensed history. A symbol the vendor has never
// covered is not a coverage failure, and counting it as one would make the alarm permanently red.
const [{ universe }] = await sql`
  select count(*)::int as universe from (
    select ticker from ticker_daily_candles where source = ${SOURCE} group by ticker) z`;

// Counts per recent date, so the newest REAL session can be identified rather than the newest date.
const counted = await sql`
  select date::text as date, count(*)::int as n from ticker_daily_candles
   where source = ${SOURCE} group by date order by date desc limit 30`;
const [sessionDate] = pickSessionDates(counted, 1);
if (!sessionDate) {
  console.error('no licensed candles at all — nothing to measure');
  await sql.end();
  process.exit(1);
}

const [{ covered }] = await sql`
  select count(distinct ticker)::int as covered from ticker_daily_candles
   where source = ${SOURCE} and date::text = ${sessionDate}`;

const pct = universe ? (covered / universe) * 100 : 0;

// Named so a weekend run is self-explanatory rather than looking like a stale pipeline.
const newest = counted[0]?.date;
if (newest && newest !== sessionDate) {
  console.log(`newest date in table    : ${newest} (below quorum — not a market session)`);
}
console.log(`latest licensed session : ${sessionDate}`);
console.log(`universe with history   : ${universe.toLocaleString()}`);
console.log(`covered for that session: ${covered.toLocaleString()} (${pct.toFixed(1)}%)`);

// The trailing sessions, so a one-day blip reads differently from a trend.
const recent = await sql`
  select date::text as date, count(distinct ticker)::int as tickers
    from ticker_daily_candles where source = ${SOURCE} and date > now() - interval '10 days'
   group by date order by date desc limit 6`;
console.log('\nrecent sessions:');
for (const r of recent) console.log(`  ${r.date}  ${String(r.tickers).padStart(6)}`);

await sql.end();

if (pct < MIN_PCT) {
  console.error(`\n⚠️  COVERAGE BELOW ${MIN_PCT}%. The Screener prices rows from this table, so a gap here`);
  console.error('   shows up as blank prices rather than as an error. Check the appender\'s run log for');
  console.error('   request failures, and whether the vendor budget was exhausted mid-pass.');
  process.exit(1);
}
console.log(`\ncoverage is at or above the ${MIN_PCT}% floor.`);
