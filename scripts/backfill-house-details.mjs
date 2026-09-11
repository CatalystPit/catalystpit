// Site-wide House recovery + detail backfill.
//
// Two problems this fixes across ALL House members:
//   1. Lost option transactions — a share buy and an option buy of the same ticker/day/amount
//      hashed identically and the option was dropped at ingest (onConflictDoNothing). Now that
//      canonicalHash suffixes options (|OPT), we re-parse each filing and INSERT the missing
//      option rows (distinct hash) without disturbing the stock rows.
//   2. Missing quantities — the filer's "D:" description ("Purchased 10,000 shares" /
//      "Purchased 100 call options, strike $100, exp 6/17/27") was never captured on most rows.
//      We backfill comment (+asset_description) onto the matching row.
//
// Idempotent: matches each parsed transaction to an existing row by (link, date, amount, ticker,
// option-ness, action); updates it, or inserts a clone of a filing sibling when none exists.
// Run: node --env-file=.env.local scripts/backfill-house-details.mjs
import { neon } from '@neondatabase/serverless';
import { extractPdfText, parsePtrTransactions } from '../src/lib/congress-house.mjs';
import { parseAmount, mapAction, filingLagDays, isOptionTrade, canonicalHash } from '../src/lib/congress-ingest.mjs';

const sql = neon(process.env.DATABASE_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanTicker = (s) => { const t = (s || '').trim().toUpperCase(); return t && /^[A-Z][A-Z0-9.\-]*$/.test(t) ? t : null; };
// neon returns `date` columns as JS Date objects → normalize to YYYY-MM-DD (local calendar day).
const isoDate = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const dt = new Date(d); if (isNaN(dt)) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

// All e-filed House PTR PDFs we've ingested (docId starting '2' = selectable text).
const links = await sql`
  SELECT DISTINCT link FROM congress_trades
  WHERE chamber='house' AND link LIKE '%/ptr-pdfs/%' AND link ~ '/[0-9]+\\.pdf$'`;
let efiled = links.filter(({ link }) => /\/2\d+\.pdf$/.test(link));
if (process.env.ONLY_LINK) efiled = efiled.filter(({ link }) => link.includes(process.env.ONLY_LINK));   // single-filing test
console.log(`House e-filed PTR filings to re-parse: ${efiled.length} (of ${links.length} total)`);

let filings = 0, updated = 0, recovered = 0, skipped = 0;
for (const { link } of efiled) {
  try {
    const existing = await sql`SELECT * FROM congress_trades WHERE link=${link}`;
    if (!existing.length) { skipped++; continue; }
    const sib = existing[0];   // member/meta template for recovered rows

    const r = await fetch(link, { headers: { 'User-Agent': 'CatalystPit (contact@catalystpit.com)' } });
    if (!r.ok) { skipped++; continue; }
    const { scanned, transactions } = parsePtrTransactions(await extractPdfText(Buffer.from(await r.arrayBuffer())));
    if (scanned || !transactions.length) { skipped++; continue; }

    const used = new Set();
    for (const t of transactions) {
      const tkr = cleanTicker(t.ticker);
      const date = t.transactionDate || null;
      const { min, max, mid } = parseAmount(t.amount);
      const action = mapAction(t.type);
      const opt = isOptionTrade(t.assetType);           // House code: 'OP' → true
      const desc = (t.description || '').trim();

      // Find an as-yet-unused existing row for this same trade line.
      const match = existing.find((row) =>
        !used.has(row.id) &&
        isoDate(row.transaction_date) === date &&
        (cleanTicker(row.ticker) || null) === tkr &&
        Number(row.amount_min) === Number(min) &&
        isOptionTrade(row.asset_type) === opt &&
        row.action === action);

      if (match) {
        used.add(match.id);
        if (desc) {   // only overwrite with a real description; never null out
          await sql`UPDATE congress_trades SET comment=${desc}, asset_description=${t.assetDescription || match.asset_description}
                    WHERE id=${match.id}`;
          updated++;
        }
      } else {
        // Previously-collapsed (or never-ingested) line → insert a clone of the filing sibling.
        const txHash = canonicalHash({ memberSlug: sib.member_slug, transactionDate: date, ticker: tkr, action, amountMin: min, amountMax: max, isOption: opt });
        const disc = isoDate(sib.disclosure_date);
        const lag = filingLagDays(date, disc);
        const res = await sql`
          INSERT INTO congress_trades
            (tx_hash, chamber, first_name, last_name, representative, member_slug, party, state, district,
             ticker, asset_description, asset_type, owner, action, amount_range, amount_min, amount_max, amount_mid,
             transaction_date, disclosure_date, filing_lag_days, comment, link)
          VALUES
            (${txHash}, ${sib.chamber}, ${sib.first_name}, ${sib.last_name}, ${sib.representative}, ${sib.member_slug},
             ${sib.party}, ${sib.state}, ${sib.district}, ${tkr}, ${t.assetDescription || null}, ${t.assetType || null},
             ${t.owner || null}, ${action}, ${t.amount || null}, ${min}, ${max}, ${mid}, ${date},
             ${disc}, ${lag}, ${desc || null}, ${link})
          ON CONFLICT (tx_hash) DO NOTHING RETURNING id`;
        if (res.length) recovered++;
      }
    }
    filings++;
    if (filings % 25 === 0) console.log(`  ${filings}/${efiled.length} filings · ${updated} updated · ${recovered} recovered`);
  } catch (e) { console.log('  skip', link, e.message); skipped++; }
  await sleep(250);
}
console.log(`DONE: ${filings} filings · ${updated} comments backfilled · ${recovered} option/lost rows recovered · ${skipped} skipped`);
