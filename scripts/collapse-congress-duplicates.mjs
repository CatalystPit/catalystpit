// Collapse cross-source duplicate Congress rows, using the product's OWN canonical key.
//
//   node --env-file=.env.local scripts/collapse-congress-duplicates.mjs           # dry run
//   node --env-file=.env.local scripts/collapse-congress-duplicates.mjs --apply
//
// ⚠️ IT IMPORTS canonicalHash RATHER THAN RESTATING IT. This is the same grouping
// dedupeCongressCanonical performs at the start of every hourly sync — the hourly run would collapse
// these on its own now that the key no longer depends on assetType. This exists so the repair can be
// verified in production immediately instead of on the next cron, and it is idempotent: after one pass
// every group is size 1 and it removes nothing.
//
// Survivor rule is the sync's: prefer the enriched row (one carrying priceAtTrade), then the lowest id.
// Nothing about a survivor is rewritten except tx_hash, so no displayed field and no timestamp moves.
import { neon } from '@neondatabase/serverless';
import { canonicalHash } from '../src/lib/congress-ingest.mjs';

const APPLY = process.argv.includes('--apply');
const sql = neon(process.env.DATABASE_URL);

const rows = await sql`
  SELECT id, member_slug, transaction_date::text AS transaction_date, ticker, action,
         amount_min, amount_max, tx_hash, price_at_trade, asset_type, asset_description
    FROM congress_trades`;
console.log(`rows: ${rows.length}`);

const groups = new Map();
for (const r of rows) {
  const h = canonicalHash({
    memberSlug: r.member_slug, transactionDate: r.transaction_date, ticker: r.ticker,
    action: r.action, amountMin: r.amount_min, amountMax: r.amount_max,
    assetDescription: r.asset_description,
  });
  if (!groups.has(h)) groups.set(h, []);
  groups.get(h).push(r);
}

const losers = [];
const rekey = [];
for (const [h, grp] of groups) {
  grp.sort((a, b) => (b.price_at_trade != null) - (a.price_at_trade != null) || a.id - b.id);
  const [keep, ...rest] = grp;
  for (const l of rest) losers.push(l);
  if (keep.tx_hash !== h) rekey.push({ id: keep.id, h });
}

console.log(`canonical groups: ${groups.size}`);
console.log(`duplicates to remove: ${losers.length}`);
console.log(`survivors needing a rekey: ${rekey.length}`);
for (const l of losers.slice(0, 20)) {
  console.log(`  drop id ${l.id}  ${l.member_slug} ${l.transaction_date} ${l.ticker || '(no ticker)'} `
    + `${l.action} ${l.amount_min}-${l.amount_max} assetType=${JSON.stringify(l.asset_type)}`);
}

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

for (let i = 0; i < losers.length; i += 500) {
  const ids = losers.slice(i, i + 500).map((l) => l.id);
  await sql`DELETE FROM congress_trades WHERE id = ANY(${ids}::int[])`;
}
for (const r of rekey) await sql`UPDATE congress_trades SET tx_hash = ${r.h} WHERE id = ${r.id}`;
console.log(`\nremoved ${losers.length}, rekeyed ${rekey.length}`);
