// READ ONLY probe. Re-parses shortfall filings and reports, hash by hash, which transactions the
// database already holds and which are genuinely absent. Inserts nothing, updates nothing.
import { neon } from '@neondatabase/serverless';
import { fetchSenatePtr, establishSession } from '../src/lib/congress-senate.mjs';
import { buildRow, canonicalHash, isOptionTrade } from '../src/lib/congress-ingest.mjs';
import { buildIndex } from '../src/lib/congress-match.mjs';
import roster from '../src/lib/congress-roster.json' with { type: 'json' };

const sql = neon(process.env.DATABASE_URL);
const index = buildIndex(roster);
const docs = process.argv.slice(2);

const cookies = await establishSession();
for (const doc of docs) {
  const [f] = await sql`select chamber, doc_id, filer_name, filing_date::text fd, url, txn_count from congress_filings where doc_id = ${doc}`;
  if (!f) { console.log(doc, 'not found'); continue; }
  // The filer name drives member_slug via matchMember, and member_slug is part of the canonical
  // hash. Passing blanks here yields null-member hashes that match nothing, which looks exactly
  // like catastrophic data loss and is purely an artefact of the probe.
  const nm = String(f.filer_name || '').replace(/,+$/, '').trim().split(/s+/);
  const first = nm[0] || '', last = nm.length > 1 ? nm[nm.length - 1] : '';
  const res = await fetchSenatePtr({ href: f.url, isPaper: false, first, last }, cookies);
  const recs = res.recs || [];
  const rows = recs.map((r) => buildRow(r, 'senate', index));
  // member_slug is part of the canonical hash, and matchMember resolves a bioguide only when the
  // name form matches the roster. Re-deriving it from a filer_name string yields "jerry-moran"
  // where the stored rows carry "M000934", and every hash then misses. Anchor to the slug the
  // stored rows actually use so this compares transactions rather than name parsing.
  const [anchor] = await sql`select member_slug from congress_trades where link = ${f.url} limit 1`;
  if (anchor?.member_slug) {
    for (const r of rows) {
      r.memberSlug = anchor.member_slug;
      r.txHash = canonicalHash({
        memberSlug: r.memberSlug, transactionDate: r.transactionDate, ticker: r.ticker, action: r.action,
        amountMin: r.amountMin, amountMax: r.amountMax, isOption: isOptionTrade(r.assetType),
        assetDescription: r.assetDescription,
      });
    }
  }
  const uniq = [...new Map(rows.filter(r => r.txHash).map(r => [r.txHash, r])).values()];
  const hashes = uniq.map(r => r.txHash);
  const present = hashes.length ? await sql`select tx_hash from congress_trades where tx_hash = any(${hashes})` : [];
  const have = new Set(present.map(p => p.tx_hash));
  const missing = uniq.filter(r => !have.has(r.txHash));
  if (uniq.length) {
    const a = uniq[0];
    const [b] = await sql`select member_slug, transaction_date::text td, ticker, action, amount_min, amount_max, asset_type, tx_hash from congress_trades where link = ${f.url} order by id limit 1`;
    console.log('  PARSED first row :', JSON.stringify({ slug: a.memberSlug, td: a.transactionDate, tk: a.ticker, ac: a.action, min: a.amountMin, max: a.amountMax, at: a.assetType }));
    if (b) console.log('  STORED first row :', JSON.stringify({ slug: b.member_slug, td: b.td, tk: b.ticker, ac: b.action, min: b.amount_min, max: b.amount_max, at: b.asset_type }));
  }
  const [stored] = await sql`select count(*)::int n from congress_trades where link = ${f.url}`;
  console.log(`\n${f.filer_name}  ${f.fd}  ${doc.slice(0,8)}`);
  console.log(`  watermark txn_count ${f.txn_count} | re-parsed now ${recs.length} | unique hashes ${uniq.length}`);
  console.log(`  stored under this link ${stored.n} | hashes already in DB ${have.size} | GENUINELY ABSENT ${missing.length}`);
  for (const m of missing.slice(0, 6)) console.log(`    absent: ${m.transactionDate} ${String(m.ticker ?? '-').padEnd(6)} ${String(m.action).padEnd(5)} ${m.amountRange}`);
  if (missing.length > 6) console.log(`    ... ${missing.length - 6} more`);
  await new Promise(r => setTimeout(r, 2500));
}
