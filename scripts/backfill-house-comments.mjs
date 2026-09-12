// Backfill the D: description (option call/put, strike, expiry, contracts) onto existing House option
// trades — re-parse the PTR PDFs of House filings that contain options and set congress_trades.comment.
// Run: node --env-file=.env.local scripts/backfill-house-comments.mjs
import { neon } from '@neondatabase/serverless';
import { extractPdfText, parsePtrTransactions } from '../src/lib/congress-house.mjs';
const sql = neon(process.env.DATABASE_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const links = await sql`
  SELECT DISTINCT link FROM congress_trades
  WHERE chamber='house' AND link IS NOT NULL
    AND (asset_type='OP' OR asset_type ILIKE '%option%' OR asset_description ILIKE '%option%')`;
console.log('House filings with options to re-parse:', links.length);

let updated = 0, filings = 0;
for (const { link } of links) {
  try {
    const r = await fetch(link, { headers: { 'User-Agent': 'CatalystPit contact@catalystpit.com' } });
    if (!r.ok) continue;
    const { transactions } = parsePtrTransactions(await extractPdfText(Buffer.from(await r.arrayBuffer())));
    for (const t of transactions) {
      if (!t.description) continue;
      const res = await sql`
        UPDATE congress_trades SET comment=${t.description}
        WHERE link=${link} AND transaction_date=${t.transactionDate} AND amount_range=${t.amount}
          AND (ticker=${t.ticker} OR (${t.ticker}::text IS NULL AND ticker IS NULL))
          AND (comment IS NULL OR comment='')`;
      updated += res.rowCount || 0;
    }
    filings++;
    if (filings % 10 === 0) console.log(`  ${filings}/${links.length} filings · ${updated} trades updated`);
  } catch (e) { console.log('  skip', link, e.message); }
  await sleep(300);
}
console.log(`DONE: ${filings} filings re-parsed, ${updated} trades got descriptions`);
