// Re-key existing OPTION rows to their new |OPT canonical hash (stock rows already carry the
// correct no-suffix hash). This frees the no-suffix hash so a recovered stock sibling can insert.
// Safe: the |OPT hash is unique vs every existing stored hash; a genuine duplicate option row
// (same |OPT) is deleted. Run: node --env-file=.env.local scripts/rekey-congress.mjs
import { neon } from '@neondatabase/serverless';
import { canonicalHash, isOptionTrade } from '../src/lib/congress-ingest.mjs';

const sql = neon(process.env.DATABASE_URL);
const isoDate = (d) => { if (!d) return null; if (typeof d === 'string') return d.slice(0, 10); const dt = new Date(d); return isNaN(dt) ? null : `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; };

const rows = await sql`SELECT id, member_slug, transaction_date, ticker, action, amount_min, amount_max, asset_type, tx_hash FROM congress_trades`;
let rekeyed = 0, deletedDup = 0, skipped = 0;
for (const r of rows) {
  if (!isOptionTrade(r.asset_type)) { skipped++; continue; }   // stock hashes already correct
  const h = canonicalHash({ memberSlug: r.member_slug, transactionDate: isoDate(r.transaction_date), ticker: r.ticker, action: r.action, amountMin: r.amount_min, amountMax: r.amount_max, isOption: true });
  if (h === r.tx_hash) { skipped++; continue; }
  try { await sql`UPDATE congress_trades SET tx_hash=${h} WHERE id=${r.id}`; rekeyed++; }
  catch { await sql`DELETE FROM congress_trades WHERE id=${r.id}`; deletedDup++; }   // dup already holds |OPT
}
console.log(`option rows: ${rekeyed} rekeyed to |OPT, ${deletedDup} dups removed, ${skipped} unchanged (of ${rows.length} total)`);
