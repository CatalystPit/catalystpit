// Prices a SPECIFIC set of congress_trades ids on the same basis the full Polygon enrichment uses
// (price_at_trade = adjusted close on or before the transaction date, current_price = latest close).
// Exists for repairs: after a ticker correction only a handful of rows need pricing, and rerunning
// the whole 1,100-ticker enrichment to reach four of them is waste.
//
//   node --env-file=.env.local scripts/reprice-trades.mjs 19238 19506 17007 19411
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const K = process.env.POLYGON_API_KEY;
const today = new Date().toISOString().slice(0, 10);
const iso = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));

const ids = process.argv.slice(2).map(Number).filter(Number.isFinite);
if (!ids.length) { console.error('usage: reprice-trades.mjs <id> [id...]'); process.exit(1); }

async function polyBars(ticker) {
  const url = 'https://api.polygon.io/v2/aggs/ticker/' + encodeURIComponent(ticker)
    + '/range/1/day/2022-01-01/' + today + '?adjusted=true&sort=asc&limit=50000&apiKey=' + K;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map((b) => ({ date: new Date(b.t).toISOString().slice(0, 10), c: b.c }));
}
const onOrBefore = (bars, target) => { let hit = null; for (const b of bars) { if (b.date <= target) hit = b; else break; } return hit; };

const rows = await sql`select id, ticker, transaction_date::text as transaction_date from congress_trades where id = any(${ids})`;
const cache = new Map();
for (const t of rows) {
  if (!t.ticker) { console.log(t.id, 'no ticker, skipped'); continue; }
  if (!cache.has(t.ticker)) cache.set(t.ticker, await polyBars(t.ticker));
  const bars = cache.get(t.ticker);
  if (!bars.length) { console.log(t.id, t.ticker, 'no Polygon data'); continue; }
  const p = onOrBefore(bars, iso(t.transaction_date));
  if (!p) { console.log(t.id, t.ticker, 'no bar on or before', t.transaction_date); continue; }
  await sql`update congress_trades set price_at_trade = ${p.c}, price_at_trade_date = ${p.date}::date, enriched_at = now() where id = ${t.id}`;
  const cur = bars[bars.length - 1].c;
  await sql`insert into congress_ticker_prices (ticker, current_price, updated_at) values (${t.ticker}, ${cur}, now())
            on conflict (ticker) do update set current_price = ${cur}, updated_at = now()`;
  console.log(t.id, t.ticker, 'trade', t.transaction_date, '->', p.c, 'on', p.date, '| current', cur);
}
