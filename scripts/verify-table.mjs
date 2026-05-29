import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const cols = await sql`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_name = 'ticker_daily_candles'
  ORDER BY ordinal_position`;
console.log('columns:'); console.table(cols);
const pk = await sql`
  SELECT a.attname AS col
  FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
  WHERE i.indrelid = 'ticker_daily_candles'::regclass AND i.indisprimary
  ORDER BY a.attname`;
console.log('PK columns:', pk.map(r => r.col).join(', '));
const [{ count }] = await sql`SELECT count(*)::int AS count FROM ticker_daily_candles`;
console.log('row count:', count);
