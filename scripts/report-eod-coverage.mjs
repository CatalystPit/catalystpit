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

const args = process.argv.slice(2);
const MIN_PCT = Number((args.find((a) => a.startsWith('--min-pct=')) || '').split('=')[1]) || 85;
const SOURCE = LICENSED_CANDLE_SOURCES[0];
const sql = postgres(process.env.DATABASE_URL, { max: 2 });

// The universe that CAN have a bar: tickers with licensed history. A symbol the vendor has never
// covered is not a coverage failure, and counting it as one would make the alarm permanently red.
const [{ universe }] = await sql`
  select count(*)::int as universe from (
    select ticker from ticker_daily_candles where source = ${SOURCE} group by ticker) z`;

const [latest] = await sql`
  select date::text as date from ticker_daily_candles
   where source = ${SOURCE} order by date desc limit 1`;

const [{ covered }] = await sql`
  select count(distinct ticker)::int as covered from ticker_daily_candles
   where source = ${SOURCE} and date::text = ${latest.date}`;

const pct = universe ? (covered / universe) * 100 : 0;

console.log(`latest licensed session : ${latest.date}`);
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
