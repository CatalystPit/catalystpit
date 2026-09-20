// REMOVE insider_trades ROWS WHOSE TICKER IS FILING-FORM FILLER.
//
//   node --env-file=.env.local scripts/cleanup-placeholder-tickers.mjs            # dry run
//   node --env-file=.env.local scripts/cleanup-placeholder-tickers.mjs --apply    # delete
//
// ── WHAT THIS REMOVES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
//
// ONLY the placeholder strings — NONE, N/A, NULL and friends — which a filer types into Form 4's
// issuerTradingSymbol when the issuer has no trading symbol at all. Those rows can never resolve
// to a security, so they are unusable rather than merely ugly, and every public surface already
// refuses to render them.
//
// It does NOT touch the ~1,188 rows whose ticker is malformed rather than absent: "Z AND ZG",
// "NYSE: VTEX", "GEF, GEF-B", "(CALX)". Each of those names a REAL security that a filer wrote
// down badly, and deleting them would throw away recoverable filings to make a count look nicer.
// The ingest gate (isIngestableTicker) now stops new ones arriving; what to do with the existing
// ones is a separate decision, and a bigger one than "a small cleanup".
//
// Dry run by default, writes an audit file of every row before deleting anything, and prints
// before/after counts. Deleting rows is not reversible from here — the audit file is the record.

import fs from 'node:fs';
import { neon } from '@neondatabase/serverless';

const APPLY = process.argv.includes('--apply');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = neon(process.env.DATABASE_URL);
const q = (t) => sql.query(t);

// Mirrors TICKER_PLACEHOLDERS in src/lib/security-identity.mjs. Kept as a literal here because a
// cleanup script must be readable on its own — you should be able to see what it deletes.
const PLACEHOLDERS = ['NONE', 'NULL', 'N/A', 'UNKNOWN', 'UNDEFINED', 'NIL', 'TBD', 'ERROR', 'MISSING', 'PLACEHOLDER'];
const WHERE = `upper(trim(ticker)) in (${PLACEHOLDERS.map((p) => `'${p}'`).join(',')})`;

const before = (await q(`select count(*)::int n from insider_trades where ${WHERE}`))[0].n;
const breakdown = await q(
  `select ticker, count(*)::int n, min(filing_date)::text mn, max(filing_date)::text mx
     from insider_trades where ${WHERE} group by 1 order by n desc`);

console.log(`placeholder rows BEFORE: ${before}`);
for (const r of breakdown) console.log(`  ${String(r.ticker).padEnd(8)} ${String(r.n).padStart(5)}   ${r.mn} → ${r.mx}`);

// For contrast, and so the number in the report is never mistaken for "all the dirt".
const malformed = (await q(
  `select count(*)::int n from insider_trades
    where not (${WHERE})
      and (ticker is null or trim(ticker) = '' or length(trim(ticker)) > 10
           or upper(trim(ticker)) !~ '^[A-Z][A-Z0-9]*([.-][A-Z0-9]+)*$')`))[0].n;
console.log(`\nmalformed-but-recoverable rows left alone: ${malformed}`);

// Guarded rather than early-exited: process.exit() with the neon handle still open trips a libuv
// assertion on Windows, which looks like a crash at the end of a clean dry run.
if (APPLY) {
const doomed = await q(
  `select id, ticker, company, executive, accession, filing_date::text fd, total_value
     from insider_trades where ${WHERE} order by id`);
const audit = `placeholder-rows-removed-${new Date().toISOString().slice(0, 10)}.json`;
fs.writeFileSync(audit, JSON.stringify(doomed, null, 1));
console.log(`\naudit written: ${audit} (${doomed.length} rows)`);

const deleted = await q(`delete from insider_trades where ${WHERE} returning id`);
const after = (await q(`select count(*)::int n from insider_trades where ${WHERE}`))[0].n;
const total = (await q('select count(*)::int n from insider_trades'))[0].n;

console.log(`deleted: ${deleted.length}`);
console.log(`placeholder rows AFTER: ${after}`);
console.log(`insider_trades total now: ${total}`);
} else {
  console.log('\nDRY RUN — nothing deleted. Re-run with --apply to remove the placeholder rows.');
}
