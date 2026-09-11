// Backfill subsequent-performance (1d/1w/1m/6m) for insider trades via Polygon (unlimited stocks).
// Efficient: ONE bars fetch + ONE bulk UPDATE per ticker (VALUES join via sql.query).
// Processes most-recently-active tickers first. Run:
//   node --env-file=.env.local scripts/enrich-insider-perf.mjs [tickerLimit]
import { neon } from '@neondatabase/serverless';
import { computePerf } from '../src/lib/insider-perf.mjs';
const sql = neon(process.env.DATABASE_URL);
const K = process.env.POLYGON_API_KEY;
const today = new Date().toISOString().slice(0, 10);
const tickerLimit = parseInt(process.argv[2] || '20000', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function polyBars(ticker) {
  try {
    const r = await fetch(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/2018-01-01/${today}?adjusted=true&sort=asc&limit=50000&apiKey=${K}`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.results || []).map((b) => ({ date: new Date(b.t).toISOString().slice(0, 10), c: b.c }));
  } catch { return []; }
}

const tickers = await sql`SELECT ticker, MAX(filing_date) mx FROM insider_trades
  WHERE ticker IS NOT NULL AND perf_priced_at IS NULL AND transaction_date IS NOT NULL
  GROUP BY ticker ORDER BY mx DESC LIMIT ${tickerLimit}`;
console.log(`tickers to perf-enrich: ${tickers.length}`);

let done = 0, rowsSet = 0, noData = 0;
for (const { ticker } of tickers) {
  try {
    const trades = await sql`SELECT id, transaction_date td, price_per_share pps FROM insider_trades
      WHERE ticker=${ticker} AND perf_priced_at IS NULL AND transaction_date IS NOT NULL`;
    const bars = await polyBars(ticker);
    if (!bars.length) {
      // mark attempted so we don't refetch a dead/unlisted ticker forever
      await sql`UPDATE insider_trades SET perf_priced_at=now() WHERE ticker=${ticker} AND perf_priced_at IS NULL AND transaction_date IS NOT NULL`;
      noData++; done++; continue;
    }
    const ups = trades.map((t) => {
      const p = computePerf(bars, t.td, Number(t.pps), today);
      return { id: t.id, ...p };
    });
    for (let i = 0; i < ups.length; i += 500) {
      const chunk = ups.slice(i, i + 500);
      const vals = chunk.map((_, j) => `($${j * 5 + 1}::int,$${j * 5 + 2}::float8,$${j * 5 + 3}::float8,$${j * 5 + 4}::float8,$${j * 5 + 5}::float8)`).join(',');
      const params = chunk.flatMap((u) => [u.id, u.p1d, u.p1w, u.p1m, u.p6m]);
      await sql.query(
        `UPDATE insider_trades AS t SET perf_1d=v.p1d, perf_1w=v.p1w, perf_1m=v.p1m, perf_6m=v.p6m, perf_priced_at=now()
         FROM (VALUES ${vals}) AS v(id,p1d,p1w,p1m,p6m) WHERE t.id=v.id`, params);
      rowsSet += chunk.length;
    }
    done++;
    if (done % 200 === 0) console.log(`  ${done}/${tickers.length} tickers · ${rowsSet} trades · ${noData} no-data`);
  } catch (e) { console.log(`  ${ticker}: ${e.message}`); }
  await sleep(40);
}
console.log(`DONE: ${done} tickers · ${rowsSet} trades perf-set · ${noData} no-data tickers`);
