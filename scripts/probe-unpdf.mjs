// Test unpdf text extraction against my House PTR parser (serverless-safe, no DOMMatrix).
// Run: node scripts/probe-unpdf.mjs [year] [docId]
import { extractText, getDocumentProxy } from 'unpdf';
import { parsePtrTransactions } from '../src/lib/congress-house.mjs';

const year = process.argv[2] || '2024';
const docId = process.argv[3] || '20025419';   // Gottheimer, multi-txn
const url = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;

const buf = new Uint8Array(await (await fetch(url, { headers: { 'User-Agent': 'CatalystPit research contact@catalystpit.com' } })).arrayBuffer());
const pdf = await getDocumentProxy(buf);
const { text } = await extractText(pdf, { mergePages: true });
console.log('--- unpdf text (first 900 chars) ---');
console.log(text.slice(0, 900));
console.log('\n--- parsed transactions ---');
const { transactions } = parsePtrTransactions(text);
for (const t of transactions.slice(0, 10)) {
  console.log(`  ${(t.type||'').padEnd(14)} ${(t.ticker||'—').padEnd(6)} ${t.transactionDate}  ${(t.amount||'').padEnd(22)} ${(t.owner||'').padEnd(14)} ${(t.assetDescription||'').slice(0,40)}`);
}
console.log(`\n${transactions.length} txns · ${transactions.filter(t=>t.ticker).length} w/ticker`);
