import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

const cols = await sql`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_name = 'watchlist'
  ORDER BY ordinal_position`;
console.log('columns:'); console.table(cols);

const idx = await sql`
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE tablename = 'watchlist'
  ORDER BY indexname`;
console.log('indexes:'); console.table(idx);

const [{ count }] = await sql`SELECT count(*)::int AS count FROM watchlist`;
console.log('row count:', count);
