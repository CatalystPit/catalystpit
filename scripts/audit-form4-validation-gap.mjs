// How many rows in production would the CANONICAL validator have refused?
//
//   node --env-file=.env.local scripts/audit-form4-validation-gap.mjs
//
// ⚠️ WHY. There are two Form 4 parsers. lib/form4.mjs validates every row through validateRow() and
// quarantines what fails. The per-minute cron in api/refresh/route.js has its own local parseForm4
// that performs NO validation at all — it reads shares and price with `parseFloat(...) || 0`, so a
// missing, footnoted or malformed number becomes 0 and is written. The route's own comments record
// three earlier drift incidents between the two parsers (document type, ticker gate, CIK extraction);
// the whole validation layer is the fourth.
//
// This measures the exact affected population rather than asserting one exists. ZERO_PRICE_OPEN_MARKET
// is NOT evaluated: it needs `priceDisclosed`, which distinguishes a filer-stated 0 from a footnoted
// price, and that flag is deleted before the insert — so for historical rows the distinction is
// already gone. Every other check is reproducible from stored columns.
import { neon } from '@neondatabase/serverless';
import { validateRow, QUARANTINE_REASONS } from '../src/lib/form4.mjs';

const sql = neon(process.env.DATABASE_URL);
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

const counts = new Map();
const samples = new Map();
let scanned = 0;

const PAGE = 20000;
for (let offset = 0; ; offset += PAGE) {
  const rows = await sql`
    select id, ticker, accession, executive, transaction_code, shares, price_per_share, total_value,
           shares_owned_after, transaction_date, filing_date, is_derivative, inserted_at
    from insider_trades order by id limit ${PAGE} offset ${offset}`;
  if (!rows.length) break;
  for (const r of rows) {
    scanned++;
    const bad = validateRow({
      shares: r.shares,
      pricePerShare: r.price_per_share,
      totalValue: r.total_value,
      sharesOwnedAfter: r.shares_owned_after,
      transactionDate: iso(r.transaction_date),
      filingDate: iso(r.filing_date),
      transactionCode: r.transaction_code,
      isDerivative: r.is_derivative,
      // deliberately absent — see the header
      priceDisclosed: false,
    });
    if (!bad) continue;
    counts.set(bad.reason, (counts.get(bad.reason) || 0) + 1);
    if (!samples.has(bad.reason)) samples.set(bad.reason, []);
    const s = samples.get(bad.reason);
    if (s.length < 4) s.push({ id: r.id, ticker: r.ticker, code: r.transaction_code, acc: r.accession,
      shares: r.shares, price: r.price_per_share, td: iso(r.transaction_date), fd: iso(r.filing_date),
      ins: String(r.inserted_at).slice(0, 10), detail: bad.detail });
  }
  if (rows.length < PAGE) break;
}

console.log(`scanned ${scanned} rows\n`);
const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`rows the canonical validator would have REFUSED: ${total} (${(100 * total / scanned).toFixed(3)}%)\n`);
for (const [reason, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(24)} ${String(n).padStart(6)}`);
  for (const s of samples.get(reason)) {
    console.log(`      id=${s.id} ${String(s.ticker).padEnd(6)} ${s.code} ${s.shares}sh @${s.price}`
      + ` txn=${s.td} filed=${s.fd} ingested=${s.ins}  ${s.detail}`);
  }
}
if (!total) console.log('  (none — the stored corpus is clean against every reproducible check)');

// How recent is the damage? Anything ingested after the live path became the only writer is arriving
// now, not historical residue.
const recent = await sql`select count(*)::int n from insider_trades where inserted_at > now() - interval '30 days'`;
console.log(`\nrows ingested in the last 30 days: ${recent[0].n}`);
