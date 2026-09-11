// Fill real Polygon option-contract prices onto disclosed OPTION trades so the leaderboard can use
// the option's leveraged return (not the underlying's move). Run:
//   node --env-file=.env.local scripts/enrich-option-prices.mjs [limit]
import { neon } from '@neondatabase/serverless';
import { priceOption } from '../src/lib/congress-options.mjs';

const sql = neon(process.env.DATABASE_URL);
const K = process.env.POLYGON_API_KEY;
const limit = parseInt(process.argv[2] || '1000', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = await sql`SELECT id, ticker, transaction_date, comment, asset_description
  FROM congress_trades
  WHERE (asset_type ILIKE '%option%' OR asset_type='OP') AND ticker IS NOT NULL AND option_priced_at IS NULL
  ORDER BY transaction_date DESC LIMIT ${limit}`;
console.log(`Option trades to price: ${rows.length}`);

let priced = 0, noStrike = 0, noData = 0;
for (const r of rows) {
  try {
    const { occ, priceAtTrade, currentPrice } = await priceOption(
      { ticker: r.ticker, transactionDate: r.transaction_date, comment: r.comment, assetDescription: r.asset_description }, K);
    await sql`UPDATE congress_trades SET option_occ=${occ || ''}, option_price_at_trade=${priceAtTrade},
      option_current_price=${currentPrice}, option_priced_at=now() WHERE id=${r.id}`;
    if (!occ) noStrike++;
    else if (priceAtTrade == null || currentPrice == null) noData++;
    else {
      priced++;
      const ret = (((currentPrice - priceAtTrade) / priceAtTrade) * 100).toFixed(0);
      console.log(`  ${(r.ticker || '').padEnd(5)} ${occ.padEnd(21)} $${priceAtTrade}→$${currentPrice}  ${ret}%`);
    }
  } catch (e) { console.log(`  id=${r.id}: ${e.message}`); }
  await sleep(12500);   // Polygon options ~5 req/min — one call per trade, stay under the limit
}
console.log(`DONE: ${priced} priced, ${noData} no market data (illiquid), ${noStrike} no strike/expiry disclosed`);
