// Scans daily price history for breaks and records the verdict in ticker_price_quality /
// ticker_price_breaks, which every return calculation then consults.
//
//   node --env-file=.env.local scripts/scan-price-breaks.mjs               # congress tickers
//   node --env-file=.env.local scripts/scan-price-breaks.mjs --all         # every ticker with candles
//   node --env-file=.env.local scripts/scan-price-breaks.mjs LAZR PARA     # named tickers
//   node --env-file=.env.local scripts/scan-price-breaks.mjs --dry         # report, write nothing
//
// Re-run after warming candles or adding tickers. It is idempotent: a ticker's rows are replaced,
// and a ticker that turns out clean has its verdict recorded as clean rather than left stale.
import { neon } from '@neondatabase/serverless';
import { analyzeSeries } from '../src/lib/price-continuity.mjs';

const sql = neon(process.env.DATABASE_URL);
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ALL = args.includes('--all');
const named = args.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());

const tickers = named.length
  ? named.map((ticker) => ({ ticker }))
  : ALL
    ? await sql`select distinct ticker from ticker_daily_candles order by 1`
    : await sql`select distinct ticker from congress_trades where ticker is not null order by 1`;

console.log(`${DRY ? 'DRY RUN, ' : ''}scanning ${tickers.length} tickers`);

let scanned = 0, clean = 0; const flagged = [];
for (const { ticker } of tickers) {
  const bars = await sql`select date::text as date, close from ticker_daily_candles where ticker = ${ticker} order by date`;
  if (!bars.length) continue;
  scanned++;
  const a = analyzeSeries(bars);
  const bad = !a.usable || a.breaks.length > 0;
  if (bad) flagged.push({ ticker, a }); else clean++;

  if (DRY) continue;
  await sql`delete from ticker_price_breaks where ticker = ${ticker}`;
  for (const b of a.breaks) {
    await sql`insert into ticker_price_breaks (ticker, break_date, kind, ratio, anomaly, before_level, after_level, gap_days)
              values (${ticker}, ${b.date}, ${b.kind}, ${b.ratio}, ${b.anomaly}, ${b.before}, ${b.after}, ${b.gap})
              on conflict (ticker, break_date) do update set kind = excluded.kind, ratio = excluded.ratio,
                anomaly = excluded.anomaly, before_level = excluded.before_level,
                after_level = excluded.after_level, gap_days = excluded.gap_days`;
  }
  await sql`insert into ticker_price_quality (ticker, usable, reason, last_break, break_count, bars, level, scanned_at)
            values (${ticker}, ${a.usable}, ${a.reason}, ${a.lastBreak}, ${a.breaks.length}, ${a.bars}, ${a.level}, now())
            on conflict (ticker) do update set usable = excluded.usable, reason = excluded.reason,
              last_break = excluded.last_break, break_count = excluded.break_count, bars = excluded.bars,
              level = excluded.level, scanned_at = now()`;
}

console.log(`\nscanned ${scanned}  clean ${clean}  flagged ${flagged.length}`);
for (const f of flagged) {
  console.log(`  ${f.ticker.padEnd(8)} ${(f.a.reason || 'break').padEnd(16)} ${f.a.breaks.map((b) => `${b.date} x${b.ratio} ${b.kind} anom${b.anomaly}`).join('  ')}`);
}
if (DRY) console.log('\nNothing written. Re-run without --dry.');
