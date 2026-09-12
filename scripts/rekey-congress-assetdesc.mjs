// scripts/rekey-congress-assetdesc.mjs
//
// Re-key every congress_trades row to the canonical hash now that assetDescription is part
// of it. Must run BEFORE re-ingesting, otherwise recovery would re-insert rows we already
// hold under their old hash.
//
//   node --env-file=.env.local scripts/rekey-congress-assetdesc.mjs --dry-run
//   node --env-file=.env.local scripts/rekey-congress-assetdesc.mjs
//
// The new key is strictly MORE specific than the old one, so groups can only shrink or stay
// the same. Any deletion here is a genuine duplicate that was already indistinguishable under
// the old key; nothing that is currently distinct can be merged by this change.

import { neon } from '@neondatabase/serverless';
import { canonicalHash, isOptionTrade } from '../src/lib/congress-ingest.mjs';

const DRY = process.argv.includes('--dry-run');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = neon(process.env.DATABASE_URL);

const iso = (d) => (d == null ? null : (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10)));

const rows = await sql.query(`
  SELECT id, member_slug, transaction_date, ticker, action, amount_min, amount_max,
         asset_type, asset_description, tx_hash, price_at_trade
  FROM congress_trades`);
console.log(`read ${rows.length} rows`);

const groups = new Map();
for (const r of rows) {
  const h = canonicalHash({
    memberSlug: r.member_slug,
    transactionDate: iso(r.transaction_date),
    ticker: r.ticker,
    action: r.action,
    amountMin: r.amount_min,
    amountMax: r.amount_max,
    isOption: isOptionTrade(r.asset_type),
    assetDescription: r.asset_description,
  });
  if (!groups.has(h)) groups.set(h, []);
  groups.get(h).push(r);
}

const losers = [];
const rekey = [];
for (const [h, grp] of groups) {
  // keep the enriched row (priced first), then the oldest id, matching dedupeCongressCanonical
  grp.sort((a, b) => (b.price_at_trade != null) - (a.price_at_trade != null) || a.id - b.id);
  const [keep, ...rest] = grp;
  for (const l of rest) losers.push(l.id);
  if (keep.tx_hash !== h) rekey.push([keep.id, h]);
}

console.log(`distinct canonical keys : ${groups.size}`);
console.log(`rows to re-key          : ${rekey.length}`);
console.log(`duplicate rows to drop  : ${losers.length}`);

if (DRY) { console.log('\n[dry run] nothing written'); process.exit(0); }

for (let i = 0; i < losers.length; i += 500) {
  await sql.query(`DELETE FROM congress_trades WHERE id = ANY($1::int[])`, [losers.slice(i, i + 500)]);
}
// Two-phase rewrite: park every hash under a temporary unique value first, so a survivor whose
// NEW hash equals some other survivor's OLD hash cannot trip the unique index mid-migration.
for (let i = 0; i < rekey.length; i += 500) {
  const chunk = rekey.slice(i, i + 500);
  await sql.query(
    `UPDATE congress_trades AS t SET tx_hash = 'tmp:' || t.id::text
       FROM (SELECT unnest($1::int[]) AS id) v WHERE t.id = v.id`,
    [chunk.map((c) => c[0])],
  );
}
for (let i = 0; i < rekey.length; i += 500) {
  const chunk = rekey.slice(i, i + 500);
  await sql.query(
    `UPDATE congress_trades AS t SET tx_hash = v.h
       FROM (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS h) v WHERE t.id = v.id`,
    [chunk.map((c) => c[0]), chunk.map((c) => c[1])],
  );
}
const [{ n }] = await sql.query(`SELECT count(*)::int n FROM congress_trades`);
const [{ d }] = await sql.query(`SELECT count(DISTINCT tx_hash)::int d FROM congress_trades`);
console.log(`\ndone. rows now ${n}, distinct hashes ${d}${n === d ? ' (clean)' : ' (MISMATCH)'}`);
