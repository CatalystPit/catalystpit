// Fills ticker_daily_candles for the institutional equity universe, so the heatmap's plausibility
// guard has a quarter-end close to test against. Today it has one for 1,032 of 8,945 rankable
// tickers, which is why the map shows 260 names instead of a thousand.
//
// Scope is deliberately narrow: rankable common and ADR positions only, from 2025-09-01, which
// covers every real 13F quarter end we hold with margin either side. A contiguous range rather than
// four snapshots around the quarter ends, because sparse storage would read as listing gaps to the
// continuity detector and manufacture breaks that are really just holes in our own data.
//
// Touches nothing the running backfills touch: Polygon is a different provider from SEC EDGAR, and
// this only ever inserts candles.
//
//   node --env-file=.env.local scripts/warm-institution-candles.mjs [--limit=N] [--dry]
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const KEY = process.env.POLYGON_API_KEY;
const arg = (k) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.split('=')[1] : null; };
const DRY = process.argv.includes('--dry');
const LIMIT = Number(arg('limit') || 0) || Infinity;
const FROM = '2025-09-01';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polygon returns 403 for a today-only window on our entitlement, so stop at the previous day.
const d = new Date(); d.setUTCDate(d.getUTCDate() - 1);
const TO = d.toISOString().slice(0, 10);

const todo = await sql`
  with rk as (
    select distinct h.ticker from fund_holdings h
      join security_position_class c on c.cusip = h.cusip and c.cls = h.class and c.put_call = h.put_call
     where h.quarter = (select max(quarter) from fund_holdings)
       and c.rankable and h.ticker is not null
  ),
  val as (
    select h.ticker, sum(h.value) v from fund_holdings h
     where h.quarter = (select max(quarter) from fund_holdings) and h.ticker is not null
     group by h.ticker
  )
  select rk.ticker, coalesce(val.v, 0)::float as v from rk
    left join val on val.ticker = rk.ticker
   -- The test is QUARTER-END coverage, not recency. Most of these tickers already carry recent bars
   -- warmed for the screener, yet only 1,032 have a close near the 13F quarter end, which is the
   -- one bar the plausibility guard actually needs.
   where not exists (
     select 1 from ticker_daily_candles k
      where k.ticker = rk.ticker
        and k.date between (select max(quarter) from fund_holdings) - 12
                       and (select max(quarter) from fund_holdings)
   )
   order by coalesce(val.v, 0) desc`;

console.log(`${todo.length.toLocaleString()} tickers need recent bars (${FROM} .. ${TO})${DRY ? ' [DRY]' : ''}`);
if (DRY) { console.log(todo.slice(0, 15).map((t) => t.ticker).join(', ')); process.exit(0); }

let done = 0, inserted = 0, empty = 0, failed = 0;
for (const { ticker } of todo.slice(0, LIMIT === Infinity ? todo.length : LIMIT)) {
  try {
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${FROM}/${TO}`
      + `?adjusted=true&sort=asc&limit=50000&apiKey=${KEY}`;
    const r = await fetch(url);
    if (!r.ok) { failed++; await sleep(r.status === 429 ? 4000 : 120); continue; }
    const j = await r.json();
    const bars = (j.results || []).map((b) => ({
      ticker, date: new Date(b.t).toISOString().slice(0, 10),
      open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v ?? 0, source: 'polygon',
    })).filter((b) => b.close > 0);
    if (!bars.length) { empty++; done++; await sleep(110); continue; }
    for (let i = 0; i < bars.length; i += 500) {
      const chunk = bars.slice(i, i + 500);
      const vals = chunk.map((_, k) => { const o = k * 8;
        return `($${o+1},$${o+2}::date,$${o+3}::float8,$${o+4}::float8,$${o+5}::float8,$${o+6}::float8,$${o+7}::float8,$${o+8})`; }).join(',');
      const params = chunk.flatMap((b) => [b.ticker, b.date, b.open, b.high, b.low, b.close, b.volume, b.source]);
      const res = await sql.query(
        `INSERT INTO ticker_daily_candles (ticker, date, open, high, low, close, volume, source)
         VALUES ${vals} ON CONFLICT (ticker, date) DO NOTHING RETURNING 1`, params);
      inserted += res.length;
    }
    done++;
  } catch { failed++; }
  if (done % 250 === 0) console.log(`  ${done.toLocaleString()}/${todo.length.toLocaleString()} tickers, ${inserted.toLocaleString()} bars, ${empty} with no data, ${failed} failed`);
  await sleep(110);
}
console.log(`done. ${done.toLocaleString()} tickers, ${inserted.toLocaleString()} bars inserted, ${empty} returned no data, ${failed} failed`);
