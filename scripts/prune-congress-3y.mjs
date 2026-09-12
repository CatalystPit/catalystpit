// scripts/prune-congress-3y.mjs
//
// Enforce the 3-year cap on congressional trade history.
//
//   node --env-file=.env.local scripts/prune-congress-3y.mjs --dry-run
//   node --env-file=.env.local scripts/prune-congress-3y.mjs
//
// These rows are late disclosures of old trades: a 2024 filing reporting a 2019 purchase. The
// source filings stay in congress_filings, so if the cap is ever raised the rows are recoverable
// by re-running the sync. Nothing here touches filings or price data.
import { neon } from '@neondatabase/serverless';
import { historyFloor, MAX_HISTORY_DAYS } from '../src/lib/congress-chart.mjs';

const DRY = process.argv.includes('--dry-run');
const sql = neon(process.env.DATABASE_URL);
const floor = historyFloor();

const [before] = await sql.query('SELECT count(*)::int n FROM congress_trades');
const doomed = await sql.query(
  'SELECT extract(year from transaction_date)::int y, count(*)::int n FROM congress_trades WHERE transaction_date < $1 GROUP BY 1 ORDER BY 1', [floor]);
const total = doomed.reduce((a, r) => a + r.n, 0);

console.log(`cap: ${MAX_HISTORY_DAYS} days, floor ${floor}`);
console.log(`rows before: ${before.n}`);
for (const r of doomed) console.log(`  ${r.y}: ${r.n}`);
console.log(`to remove: ${total}`);

if (DRY) { console.log('\n[dry run] nothing written'); process.exit(0); }
await sql.query('DELETE FROM congress_trades WHERE transaction_date < $1', [floor]);
const [after] = await sql.query('SELECT count(*)::int n FROM congress_trades');
const [span] = await sql.query('SELECT min(transaction_date)::text mn, max(transaction_date)::text mx FROM congress_trades');
console.log(`\nrows after: ${after.n} (removed ${before.n - after.n})`);
console.log(`history now spans ${span.mn} .. ${span.mx}`);
