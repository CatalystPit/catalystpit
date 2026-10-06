// HOW MANY STORED FORM 4 ROWS WOULD THE CANONICAL VALIDATOR REJECT?
//
//   node --env-file=.env.local scripts/scan-form4-price-corruption.mjs
//
// ⚠️ READ ONLY. This changes nothing; it answers "is SLBT alone, or is there a population?".
//
// Deliberately narrow: only the PRICE AND VALUE failure class, which is the one the SLBT filing
// belongs to. The date, code and ownership rules in validateRow are not applied here, because a row
// quarantined for a future transaction date is a different defect with a different fix and sweeping it
// in would turn a targeted repair into an insider-system audit.
//
// priceDisclosed is deliberately NOT reconstructed. It cannot be recovered from a stored row — the
// distinction between "filer wrote 0" and "filer footnoted the price" lives only in the source XML — so
// the zero-price rule is left dormant rather than guessed at. That keeps this scan to the failure class
// it is named for.

import { neon } from '@neondatabase/serverless';
import { validateRow, LIMITS, QUARANTINE_REASONS } from '../src/lib/form4.mjs';

const sql = neon(process.env.DATABASE_URL);

// The subset of reasons that describe a corrupted price or a value derived from one.
const PRICE_CLASS = new Set([
  QUARANTINE_REASONS.ABSURD_PRICE,
  QUARANTINE_REASONS.ABSURD_VALUE,
  QUARANTINE_REASONS.MALFORMED_PRICE,
  QUARANTINE_REASONS.VALUE_INCONSISTENT,
  QUARANTINE_REASONS.ABSURD_SHARES,
  QUARANTINE_REASONS.MALFORMED_SHARES,
]);

const total = (await sql`select count(*)::int n from insider_trades`)[0].n;
console.log(`stored Form 4 transactions: ${total.toLocaleString()}`);
console.log(`bounds in force: MAX_PRICE $${LIMITS.MAX_PRICE.toLocaleString()} · `
  + `MAX_VALUE $${LIMITS.MAX_VALUE.toExponential(1)} · MAX_SHARES ${LIMITS.MAX_SHARES.toExponential(1)}\n`);

// Scanned in pages so a large table cannot be pulled into memory at once.
const PAGE = 20_000;
let offset = 0, scanned = 0;
const hits = [];
for (;;) {
  const rows = await sql`
    select id, ticker, executive, transaction_code, action, shares, price_per_share, total_value,
           shares_owned_after, transaction_date, filing_date, accession, filing_url
      from insider_trades
     order by id
     limit ${PAGE} offset ${offset}`;
  if (!rows.length) break;
  for (const r of rows) {
    scanned += 1;
    const row = {
      shares: Number(r.shares),
      pricePerShare: Number(r.price_per_share),
      totalValue: Number(r.total_value),
      sharesOwnedAfter: r.shares_owned_after == null ? null : Number(r.shares_owned_after),
      transactionDate: r.transaction_date,
      filingDate: r.filing_date,
      transactionCode: r.transaction_code,
      rawShares: String(r.shares), rawPrice: String(r.price_per_share),
      // priceDisclosed intentionally omitted — see the header.
    };
    const bad = validateRow(row, { today: new Date('2100-01-01') });  // date rules neutralised
    if (bad && PRICE_CLASS.has(bad.reason)) hits.push({ ...r, reason: bad.reason, detail: bad.detail });
  }
  offset += PAGE;
  process.stdout.write(`\r  scanned ${scanned.toLocaleString()}…`);
}
console.log(`\r  scanned ${scanned.toLocaleString()} rows\n`);

if (!hits.length) {
  console.log('no stored row fails the price/value bounds.');
} else {
  console.log(`${hits.length} row(s) fail the price/value bounds:\n`);
  for (const h of hits) {
    console.log(`  id=${h.id} ${h.ticker} ${h.action} ${h.transaction_code} ${String(h.transaction_date).slice(0, 10)}`);
    console.log(`    ${Number(h.shares).toLocaleString()} shares @ $${Number(h.price_per_share).toLocaleString()}`
      + ` = $${Number(h.total_value).toLocaleString()}`);
    console.log(`    ${h.reason}: ${h.detail}`);
    console.log(`    ${h.accession}  ${h.executive}`);
    // ⚠️ THE SIGNATURE OF THIS FAILURE CLASS, printed so a reader can judge each case rather than
    // trust the label: when a filer puts the AGGREGATE consideration in the per-share field,
    // price / shares lands back on a plausible per-share price. A genuinely expensive security does
    // not have that property.
    const implied = Number(h.price_per_share) / Number(h.shares);
    if (Number.isFinite(implied) && implied > 0.0001 && implied < 10_000) {
      console.log(`    ⚠️ price/shares = $${implied.toFixed(4)} — consistent with an AGGREGATE`
        + ' consideration having been filed in the per-share field');
    }
    console.log('');
  }
}

// The downstream surfaces the brief names, so the blast radius is stated rather than assumed.
if (hits.length) {
  const ids = hits.map((h) => h.id);
  const inRankings = (await sql`select count(*)::int n from insider_trades
    where id = any(${'{' + ids.join(',') + '}'}::int[]) and total_value > 0`)[0].n;
  const withConviction = (await sql`select count(*)::int n from insider_trades
    where id = any(${'{' + ids.join(',') + '}'}::int[]) and conviction is not null`)[0].n;
  console.log(`of those: ${inRankings} carry a positive total_value (so reach value-ordered rankings)`);
  console.log(`          ${withConviction} carry a computed conviction score`);
}
