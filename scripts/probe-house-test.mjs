// Validate the House PTR parser against real filings from the live index.
// Run: node scripts/probe-house-test.mjs [year] [sampleCount]
import { fetchHouseIndex, fetchHousePtr, isEfiledDocId } from '../src/lib/congress-house.mjs';

const year = process.argv[2] || '2024';
const N = parseInt(process.argv[3] || '6', 10);

const idx = await fetchHouseIndex(year);
const efiled = idx.filter((e) => isEfiledDocId(e.docId));
const scanned = idx.filter((e) => !isEfiledDocId(e.docId));
console.log(`${year}: ${idx.length} PTRs — ${efiled.length} e-filed, ${scanned.length} scanned`);

// spread the sample across the list
const picks = [];
const step = Math.max(1, Math.floor(efiled.length / N));
for (let i = 0; i < efiled.length && picks.length < N; i += step) picks.push(efiled[i]);

let totalTxns = 0, withTicker = 0, empties = 0, errors = 0;
for (const e of picks) {
  const res = await fetchHousePtr(e);
  console.log(`\n── ${e.first} ${e.last} (${e.stateDst}) doc ${e.docId} filed ${e.filingDate} → ${res.status} (${res.transactions.length} txns)`);
  if (res.status === 'error') { errors++; console.log('   error:', res.error); }
  if (res.status === 'empty') empties++;
  for (const t of res.transactions.slice(0, 5)) {
    totalTxns++; if (t.ticker) withTicker++;
    console.log(`   ${t.type.padEnd(14)} ${(t.ticker || '—').padEnd(6)} ${t.transactionDate}  ${t.amount.padEnd(22)} ${t.owner.padEnd(15)} ${t.assetType || ''}  ${(t.assetDescription || '').slice(0, 48)}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`\nSUMMARY: sampled ${picks.length} PTRs · ${totalTxns} shown txns · ${withTicker} w/ticker · ${empties} empty · ${errors} error`);
