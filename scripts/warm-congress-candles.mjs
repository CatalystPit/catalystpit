// scripts/warm-congress-candles.mjs
//
// Fetch 3 years of daily bars for every ticker Congress has traded and cache them in
// ticker_daily_candles. One Polygon call per ticker (stocks are unlimited on our plan).
//
//   node --env-file=.env.local scripts/warm-congress-candles.mjs [--dry-run] [--limit=N]
//
// Serves two purposes: the Best 30-Day Record module needs a price from 30 days ago on the same
// series as today's price, and Phase 3's chart reads the same cache, so warming it here means the
// first user to open a ticker does not pay for a cold fetch.
// Idempotent: already-cached days conflict away, so re-running only fills gaps.
import { neon } from '@neondatabase/serverless';
import { fetchPolygonDaily, historyFloor, lastFetchableDay } from '../src/lib/congress-chart.mjs';

const DRY = process.argv.includes('--dry-run');
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const sql = neon(process.env.DATABASE_URL);
const from = historyFloor(), to = lastFetchableDay();

const tickers = await sql.query(
  `SELECT ticker, count(*)::int n FROM congress_trades WHERE ticker IS NOT NULL GROUP BY ticker ORDER BY count(*) DESC`);
console.log(`${tickers.length} congress tickers, window ${from} .. ${to}${DRY ? '  [DRY RUN]' : ''}`);

let done = 0, stored = 0, noData = 0, failed = 0;
for (const { ticker } of tickers.slice(0, LIMIT === Infinity ? tickers.length : LIMIT)) {
  const [cov] = await sql.query(
    'SELECT min(date)::text mn, max(date)::text mx FROM ticker_daily_candles WHERE ticker = $1', [ticker]);
  // Already spans the window (tolerating a few days at the head for listings/holidays)?
  if (cov?.mn && cov?.mx && cov.mx >= to && new Date(cov.mn) - new Date(from) < 7 * 864e5) { done++; continue; }
  if (DRY) { done++; continue; }

  const { ok, bars, reason } = await fetchPolygonDaily(ticker, from, to);
  if (!ok) { failed++; console.error(`  ${ticker}: ${reason}`); continue; }
  if (!bars.length) { noData++; done++; continue; }
  for (let i = 0; i < bars.length; i += 1000) {
    const batch = bars.slice(i, i + 1000);
    const params = []; const values = batch.map((b) => {
      const t = [ticker, b.date, b.open, b.high, b.low, b.close, b.volume, 'polygon'];
      const base = params.length; params.push(...t);
      return `(${t.map((_, j) => `$${base + j + 1}`).join(',')})`;
    }).join(',');
    const res = await sql.query(
      `INSERT INTO ticker_daily_candles (ticker,date,open,high,low,close,volume,source)
       VALUES ${values} ON CONFLICT (ticker,date) DO NOTHING RETURNING 1`, params);
    stored += res.length;
  }
  done++;
  if (done % 100 === 0) console.log(`  ${done}/${tickers.length} · ${stored} bars stored · ${noData} no-data · ${failed} failed`);
}
console.log(`\nDONE: ${done} tickers processed, ${stored} bars stored, ${noData} with no Polygon data, ${failed} failed`);
