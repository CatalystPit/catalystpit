// Move insider rows off a ticker that provably belongs to a different company.
//
//   node --env-file=.env.local scripts/repair-insider-ticker-authority.mjs           # dry run
//   node --env-file=.env.local scripts/repair-insider-ticker-authority.mjs --apply
//
// ⚠️ IT USES THE SAME RULE THE INGEST USES. authoritativeTicker is imported, not restated, so a row
// repaired here and a row arriving tomorrow are decided identically.
//
// Only `ticker` is written. filing_date, transaction_date and inserted_at are never touched, so no
// Evidence Alert can fire from this — insider alerts key on inserted_at and evidence publicTime is
// filing_date.
import { neon } from '@neondatabase/serverless';
import { buildTickerAuthority, authoritativeTicker } from '../src/lib/insider-ticker-authority.mjs';

const APPLY = process.argv.includes('--apply');
const sql = neon(process.env.DATABASE_URL);

const counts = await sql`
  SELECT ticker, issuer_cik AS "issuerCik", count(*)::int n
    FROM insider_trades WHERE issuer_cik IS NOT NULL GROUP BY 1,2`;
const authority = buildTickerAuthority(counts);
console.log(`tickers with an established holder: ${authority.dominantCikOf.size}`);
console.log(`issuer CIKs with a ticker of their own: ${authority.dominantTickerOf.size}`);

const rows = await sql`
  SELECT id, ticker, issuer_cik AS "issuerCik", company, executive, filing_date::text fd, accession
    FROM insider_trades WHERE issuer_cik IS NOT NULL`;

const moves = [];
for (const r of rows) {
  const to = authoritativeTicker(r, authority);
  if (to && to !== r.ticker) moves.push({ ...r, to });
}
console.log(`\nrows to relocate: ${moves.length}`);
const byPair = new Map();
for (const m of moves) {
  const k = `${m.ticker} -> ${m.to}`;
  if (!byPair.has(k)) byPair.set(k, { n: 0, company: m.company });
  byPair.get(k).n++;
}
for (const [k, v] of [...byPair].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${k.padEnd(20)} ${String(v.n).padStart(4)} row(s)   ${v.company}`);
}

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

let done = 0;
for (const m of moves) {
  const r = await sql`UPDATE insider_trades SET ticker = ${m.to}
                       WHERE id = ${m.id} AND ticker IS DISTINCT FROM ${m.to} RETURNING 1`;
  done += r.length;
}
console.log(`\nrelocated ${done} row(s)`);
