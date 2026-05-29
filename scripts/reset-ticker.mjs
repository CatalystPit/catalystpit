import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const t = process.argv[2];
const r = await sql`DELETE FROM ticker_daily_candles WHERE ticker = ${t}`;
console.log(`deleted rows for ${t}`);
