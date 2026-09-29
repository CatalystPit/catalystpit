// Index ticker_daily_candles(date). Idempotent.
//
// ⚠️ WHY THE COMPOSITE PRIMARY KEY DID NOT COVER THIS. The only index was (ticker, date), and a
// btree with ticker LEADING cannot answer "the newest date across all tickers" — Postgres has to
// scan. Measured on production: max(date) took 388-676ms against 3.2M rows, and the movers query
// asked for it twice plus a second lookup for the previous session. Every anonymous request to
// /api/movers paid that, as does the market-breadth aggregate and anything else that starts from
// "which session are we on".
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

const before = Date.now();
await sql`create index concurrently if not exists ticker_daily_candles_date_idx on ticker_daily_candles (date desc)`;
console.log(`index created/confirmed in ${Date.now() - before}ms`);

for (let i = 0; i < 3; i++) {
  const t = Date.now();
  const [{ d }] = await sql`select max(date)::text d from ticker_daily_candles`;
  console.log(`  max(date) = ${d} in ${Date.now() - t}ms`);
}
const idx = await sql`select indexname from pg_indexes where tablename = 'ticker_daily_candles'`;
console.log('indexes: ' + idx.map((r) => r.indexname).join(', '));
