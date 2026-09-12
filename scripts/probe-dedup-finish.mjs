// Finish the congress dedupe: collapse any remaining dup groups + re-key survivors
// to the canonical hash. Mirrors dedupeCongressCanonical exactly (same canonicalHash,
// date as YYYY-MM-DD via to_char to match drizzle's date mode:string).
// Run: node --env-file=.env.local scripts/probe-dedup-finish.mjs
import { neon } from '@neondatabase/serverless';
import { canonicalHash } from '../src/lib/congress-ingest.mjs';
const sql = neon(process.env.DATABASE_URL);

const rows = await sql`
  SELECT id, member_slug, to_char(transaction_date,'YYYY-MM-DD') AS transaction_date,
         ticker, action, amount_min, amount_max, tx_hash, price_at_trade
  FROM congress_trades`;
console.log('rows:', rows.length);

const groups = new Map();
for (const r of rows) {
  const h = canonicalHash({ memberSlug: r.member_slug, transactionDate: r.transaction_date, ticker: r.ticker, action: r.action, amountMin: r.amount_min, amountMax: r.amount_max });
  if (!groups.has(h)) groups.set(h, []);
  groups.get(h).push(r);
}

const losers = [], rekey = [];
for (const [h, grp] of groups) {
  grp.sort((a, b) => (b.price_at_trade != null) - (a.price_at_trade != null) || a.id - b.id);
  const [keep, ...rest] = grp;
  for (const l of rest) losers.push(l.id);
  if (keep.tx_hash !== h) rekey.push({ id: keep.id, h });
}

for (let i = 0; i < losers.length; i += 500) await sql`DELETE FROM congress_trades WHERE id = ANY(${losers.slice(i, i + 500)}::int[])`;
for (let i = 0; i < rekey.length; i += 500) {
  const batch = rekey.slice(i, i + 500);
  await sql`UPDATE congress_trades AS t SET tx_hash = d.h
            FROM unnest(${batch.map((r) => r.id)}::int[], ${batch.map((r) => r.h)}::text[]) AS d(id, h)
            WHERE t.id = d.id`;
}

const after = (await sql`SELECT count(*)::int n, count(DISTINCT tx_hash)::int u FROM congress_trades`)[0];
console.log({ total: rows.length, groups: groups.size, duplicatesRemoved: losers.length, rekeyed: rekey.length });
console.log('after:', after, after.n === after.u ? '✅ all tx_hash unique' : '❌ still dupes');
