// Dry-run: OCR one (or a few) scanned House PTR PDFs and print what Claude transcribes.
// No DB writes. Run: node --env-file=.env.local scripts/ocr-test.mjs [docId]
import { neon } from '@neondatabase/serverless';
import { ocrPtrTransactions } from '../src/lib/congress-ocr.mjs';

const sql = neon(process.env.DATABASE_URL);
const want = process.argv[2];
const rows = want
  ? await sql`SELECT doc_id, year, filer_name, url FROM congress_filings WHERE chamber='house' AND doc_id=${want}`
  : await sql`SELECT doc_id, year, filer_name, url FROM congress_filings WHERE chamber='house' AND status='scanned' ORDER BY year DESC LIMIT 3`;

for (const r of rows) {
  console.log(`\n=== ${r.filer_name} · ${r.doc_id} (${r.year}) ===\n${r.url}`);
  const buf = Buffer.from(await (await fetch(r.url, { headers: { 'User-Agent': 'CatalystPit (contact@catalystpit.com)' } })).arrayBuffer());
  const { transactions, error, usage } = await ocrPtrTransactions(buf, process.env.ANTHROPIC_API_KEY);
  if (error) { console.log('  ERROR:', error); continue; }
  console.log(`  ${transactions.length} transactions${usage ? ` · ${usage.input_tokens}in/${usage.output_tokens}out tok` : ''}`);
  for (const t of transactions) {
    const q = [t._shares && `${t._shares} sh`, t._contracts && `${t._contracts} ctr`].filter(Boolean).join(' ');
    console.log(`   ${(t.ticker || '-').padEnd(6)} ${t.type?.padEnd(9)} ${t.transactionDate} ${t.amount.padEnd(22)} ${q.padEnd(10)} | ${(t.description || '').slice(0, 50)}`);
  }
}
