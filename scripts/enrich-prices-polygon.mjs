// Re-price ALL congress trades via Polygon (unlimited for stocks) on ONE consistent split-adjusted
// basis: price_at_trade = adjusted close on/before the trade date; current_price = latest close.
// Fixes the Tiingo-raw vs Finnhub mismatch AND fills the 27-nights-of-Tiingo backlog in minutes.
// Run: node --env-file=.env.local scripts/enrich-prices-polygon.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const K = process.env.POLYGON_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
const today = new Date().toISOString().slice(0, 10);

async function polyBars(ticker) {
  // whole-history daily bars (adjusted); Polygon stocks are unlimited on our plan.
  const r = await fetch(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/2022-01-01/${today}?adjusted=true&sort=asc&limit=50000&apiKey=${K}`);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map((b) => ({ date: new Date(b.t).toISOString().slice(0, 10), c: b.c }));
}
const onOrBefore = (bars, target) => { let hit = null; for (const b of bars) { if (b.date <= target) hit = b; else break; } return hit; };

const tickers = await sql`SELECT DISTINCT ticker FROM congress_trades WHERE ticker IS NOT NULL ORDER BY ticker`;
console.log(`tickers to price: ${tickers.length}`);
let priced = 0, curSet = 0, noData = 0, tk = 0;
for (const { ticker } of tickers) {
  tk++;
  try {
    const trades = await sql`SELECT id, transaction_date FROM congress_trades WHERE ticker=${ticker} AND transaction_date IS NOT NULL`;
    const bars = await polyBars(ticker);
    if (!bars.length) { noData++; continue; }
    const updates = [];
    for (const t of trades) { const p = onOrBefore(bars, iso(t.transaction_date)); if (p) updates.push({ id: t.id, price: p.c, date: p.date }); }
    // neon's tagged-template client has no sql.join → per-trade UPDATE (reliable; volume is modest).
    for (const u of updates) {
      await sql`UPDATE congress_trades SET price_at_trade = ${u.price}, price_at_trade_date = ${u.date}::date, enriched_at = now() WHERE id = ${u.id}`;
      priced++;
    }
    const cur = bars[bars.length - 1].c;
    await sql`INSERT INTO congress_ticker_prices (ticker, current_price, updated_at) VALUES (${ticker}, ${cur}, now())
              ON CONFLICT (ticker) DO UPDATE SET current_price = ${cur}, updated_at = now()`;
    curSet++;
    if (tk % 100 === 0) console.log(`  ${tk}/${tickers.length} · ${priced} trades priced · ${noData} no-data tickers`);
  } catch (e) { console.log(`  ${ticker}: ${e.message}`); }
  await sleep(60);
}
console.log(`DONE: ${priced} trades priced · ${curSet} current prices set · ${noData} tickers with no Polygon data`);
