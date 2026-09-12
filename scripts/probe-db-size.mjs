// Report DB size + biggest tables/indexes + key row counts.
// Run: node --env-file=.env.local scripts/probe-db-size.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

const dbsize = (await sql`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`)[0].s;
console.log('TOTAL DB SIZE:', dbsize, '(free-tier cap 512 MB)\n');

const tables = await sql`
  SELECT c.relname AS tbl,
         pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
         pg_size_pretty(pg_relation_size(c.oid)) AS heap,
         pg_size_pretty(pg_indexes_size(c.oid)) AS idx
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname = 'public'
  ORDER BY pg_total_relation_size(c.oid) DESC
  LIMIT 15`;
console.log('TOP TABLES (total = heap + indexes):');
for (const t of tables) console.log(`  ${String(t.tbl).padEnd(28)} ${String(t.total).padStart(9)}  heap ${String(t.heap).padStart(8)}  idx ${String(t.idx).padStart(8)}`);

const fh = (await sql`SELECT count(*)::int n FROM fund_holdings`)[0].n;
const ff = (await sql`SELECT count(*)::int n FROM fund_filings`)[0].n;
const inst = (await sql`SELECT count(*)::int n FROM institutions`)[0].n;
console.log(`\nfund_holdings=${fh.toLocaleString()}  fund_filings=${ff.toLocaleString()}  institutions=${inst.toLocaleString()}`);
