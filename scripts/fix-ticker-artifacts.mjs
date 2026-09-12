// Repairs congress_trades rows whose `ticker` is not a symbol at all, but a fragment the
// parsers mistook for one. Three distinct bugs produced them, all fixed at the source:
//
//   1. House PTR: the ticker was the LAST parenthetical in the segment, so a filer who wrote the
//      venue or a qualifier after the symbol handed us that instead.
//        "200? FIG (NYSE)"            -> NYSE
//        "U.S Treasury Bills (partial)" -> PARTIAL
//        "200? BTC (Bitcoin)"         -> BITCOIN
//   2. Senate eFD: the ticker cell had every non-symbol character stripped, which FUSED the two
//      legs of a corporate action into a symbol that does not exist.
//        "CEQP ET" -> CEQPET     "ETRN EQT" -> ETRNEQT     "LSXMK SIRI" -> LSXMKSIRI
//   3. cleanTicker accepted anything shaped like a symbol, so none of the above was caught.
//
// Every fix below is read off the filing's own description, never inferred. Where the filing does
// not name a single security (an exchange has two legs, a Treasury bill has no symbol, a coin is
// not an equity) the ticker becomes NULL rather than a guess.
//
// tx_hash is the canonical dedupe key and CONTAINS the ticker, so it is recomputed for every row
// touched. The script refuses to write a row whose stored hash it cannot first reproduce from the
// row's own columns, which proves the recomputation is using the same inputs the ingest used.
//
//   node --env-file=.env.local scripts/fix-ticker-artifacts.mjs          # dry run
//   node --env-file=.env.local scripts/fix-ticker-artifacts.mjs --apply

import { neon } from '@neondatabase/serverless';
import { canonicalHash, isOptionTrade } from '../src/lib/congress-ingest.mjs';

const sql = neon(process.env.DATABASE_URL);
const APPLY = process.argv.includes('--apply');

const FIXES = [
  // House: venue and qualifier captured as the symbol.
  { id: 19238, from: 'NYSE', to: 'FIG', why: 'venue captured; description names FIG, NYSE is the exchange' },
  { id: 22020, from: 'PARTIAL', to: null, why: 'qualifier captured; US Treasury bills carry no symbol' },
  // House: coin name captured as the symbol. We hold no crypto prices and these are not equities.
  { id: 20856, from: 'BITCOIN', to: null, why: 'coin name captured; BTC is not an equity symbol here' },
  { id: 20859, from: 'BITCOIN', to: null, why: 'coin name captured; BTC is not an equity symbol here' },
  { id: 20858, from: 'RIPPLE', to: null, why: 'coin name captured; XRP is not an equity symbol' },
  { id: 20860, from: 'RIPPLE', to: null, why: 'coin name captured; XRP is not an equity symbol' },
  { id: 20857, from: 'SOLANA', to: null, why: 'coin name captured; SOL is not an equity symbol' },
  { id: 20861, from: 'SOLANA', to: null, why: 'coin name captured; SOL is not an equity symbol' },
  // Senate: two legs fused. The description labels which leg was received, so the position the
  // member now holds is named in the filing rather than inferred.
  { id: 19506, from: 'CEQPET', to: 'ET', why: 'CEQP + ET fused; description: Energy Transfer LP (Received)' },
  { id: 17007, from: 'ETRNEQT', to: 'EQT', why: 'ETRN + EQT fused; description: Eqt Corp (Received)' },
  { id: 19411, from: 'LSXMKSIRI', to: 'SIRI', why: 'LSXMK + SIRI fused; description: Sirius XM Holdings Inc. (Received)' },
];

// The DB returns numerics as strings; ingest passed them as numbers. Try both so a formatting
// difference cannot be mistaken for a mismatch of the real key.
const coercions = [(v) => v, (v) => (v == null ? null : Number(v))];

const rows = await sql`
  select id, tx_hash, ticker, member_slug, transaction_date::text as transaction_date,
         action, amount_min, amount_max, asset_type, asset_description
    from congress_trades
   where id = any(${FIXES.map((f) => f.id)})`;
const byId = new Map(rows.map((r) => [r.id, r]));

const planned = [];
for (const fix of FIXES) {
  const r = byId.get(fix.id);
  if (!r) { console.log(`SKIP ${fix.id}: row not found`); continue; }
  if (r.ticker !== fix.from) { console.log(`SKIP ${fix.id}: ticker is ${r.ticker}, expected ${fix.from}`); continue; }

  const base = {
    memberSlug: r.member_slug,
    transactionDate: r.transaction_date,
    action: r.action,
    isOption: isOptionTrade(r.asset_type),
    assetDescription: r.asset_description,
  };

  // Reproduce the STORED hash first. Whichever coercion matches is the one the ingest used.
  const coerce = coercions.find((c) => canonicalHash({
    ...base, ticker: r.ticker, amountMin: c(r.amount_min), amountMax: c(r.amount_max),
  }) === r.tx_hash);
  if (!coerce) { console.log(`SKIP ${fix.id}: cannot reproduce stored tx_hash, refusing to rewrite it`); continue; }

  const next = canonicalHash({
    ...base, ticker: fix.to, amountMin: coerce(r.amount_min), amountMax: coerce(r.amount_max),
  });
  planned.push({ ...fix, row: r, nextHash: next });
}

// A corrected row that lands on an existing hash means the fix revealed a genuine duplicate.
// The unique index would reject it; surface it rather than let the update fail mid-run.
const hashes = planned.map((p) => p.nextHash);
const clashes = hashes.length
  ? await sql`select id, tx_hash from congress_trades where tx_hash = any(${hashes}) and id <> all(${planned.map((p) => p.id)})`
  : [];

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'}  ${planned.length} of ${FIXES.length} rows\n`);
for (const p of planned) {
  console.log(`  ${String(p.id).padEnd(6)} ${String(p.from).padEnd(10)} -> ${String(p.to ?? 'NULL').padEnd(6)} ${p.why}`);
  console.log(`         ${(p.row.asset_description || '').replace(/\s+/g, ' ').slice(0, 96)}`);
}
if (clashes.length) {
  console.log('\nHASH CLASH, nothing written:');
  for (const c of clashes) console.log('  existing row', c.id, 'already holds', c.tx_hash.slice(0, 16));
  process.exit(1);
}

if (!APPLY) { console.log('\nNo changes written. Re-run with --apply.'); process.exit(0); }

let n = 0;
for (const p of planned) {
  await sql`update congress_trades set ticker = ${p.to}, tx_hash = ${p.nextHash} where id = ${p.id}`;
  n++;
}
console.log(`\nUpdated ${n} rows.`);
