// Partial index for the insider "top by value" read path.
//
//   node --env-file=.env.local scripts/migrate-insider-value-index.mjs
//
// ⚠️ WHY. /api/insiders?view=top orders 269,886 rows by total_value with no index on it, so the plan
// was a parallel sequential scan plus a sort: 506-626ms, p50 587ms, measured over seven runs. It is
// the view users land on. The index covers exactly the predicate the route now uses — unsuperseded,
// priced, open-market — so the sort disappears and the plan becomes an ordered index scan.
//
// Measured: p50 579ms -> 50ms, an index scan with 0.16ms actual time, for 3.9 MB.
//
// Partial rather than a plain (total_value desc) index because the unpriced and superseded rows are a
// fifth of the table and are never wanted here; excluding them is what keeps it small.
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const NAME = 'idx_insider_open_market_value';

const before = await sql`select count(*)::int n from pg_indexes where indexname = ${NAME}`;
console.log(`${NAME} present before: ${before[0].n === 1}`);

await sql.query(`create index if not exists ${NAME} on insider_trades (total_value desc)
  where superseded_by is null and total_value > 0 and action in ('BUY','SELL')`);
await sql.query('analyze insider_trades');

const after = await sql`select indexdef from pg_indexes where indexname = ${NAME}`;
console.log(`created/confirmed: ${after.length === 1}`);
if (after.length) console.log(`  ${after[0].indexdef}`);
const size = await sql.query(`select pg_size_pretty(pg_relation_size('${NAME}')) s`);
console.log(`  size: ${size[0].s}`);

// Prove it is actually chosen, rather than trusting that creating it was enough.
const plan = await sql.query(`explain (analyze) select * from insider_trades
  where upper(trim(ticker)) ~ '^[A-Z][A-Z0-9]*([.-][A-Z0-9]+)*$'
    and superseded_by is null and action in ('BUY','SELL') and total_value > 0
  order by total_value desc limit 50`);
const text = plan.map((r) => Object.values(r)[0]).join('\n');
const used = text.includes(NAME);
const sorted = /\bSort\b/.test(text);
console.log(`  plan uses the index: ${used}`);
console.log(`  plan still sorts   : ${sorted}${sorted ? '  (unexpected — the index should supply the order)' : ''}`);
process.exit(used && !sorted ? 0 : 1);
