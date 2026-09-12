// Validate the Senate eFD flow + parser against live data.
// Run: node scripts/probe-senate-test.mjs [sampleCount]
import { fetchSenatePtrIndex, fetchSenatePtr, establishSession } from '../src/lib/congress-senate.mjs';

const N = parseInt(process.argv[2] || '5', 10);

// Pull just the most recent page (last ~2 years) to keep the probe quick.
const yr = new Date().getUTCFullYear() - 1;
const { rows, total } = await fetchSenatePtrIndex({ startDate: `01/01/${yr} 00:00:00`, pageSize: 100, maxPages: 1 });
const electronic = rows.filter((r) => !r.isPaper);
const paper = rows.filter((r) => r.isPaper);
console.log(`feed total=${total} · page rows=${rows.length} · electronic=${electronic.length} · paper=${paper.length}`);
console.log('sample rows:', electronic.slice(0, 3).map((r) => `${r.first} ${r.last} [${r.filingDate}] ${r.docId?.slice(0, 8)}`));

const cookies = await establishSession();
let totalTxns = 0, withTicker = 0, empties = 0, errors = 0;
for (const row of electronic.slice(0, N)) {
  const res = await fetchSenatePtr(row, cookies);
  console.log(`\n── ${row.first} ${row.last} filed ${row.filingDate} doc ${row.docId?.slice(0, 8)} → ${res.status} (${res.transactions.length} txns)`);
  if (res.status === 'error') { errors++; console.log('   error:', res.error); }
  if (res.status === 'empty') empties++;
  for (const t of res.transactions.slice(0, 5)) {
    totalTxns++; if (t.ticker) withTicker++;
    console.log(`   ${(t.type || '').padEnd(10)} ${(t.ticker || '—').padEnd(6)} ${t.transactionDate}  ${(t.amount || '').padEnd(24)} ${(t.owner || '').padEnd(8)} ${(t.assetDescription || '').slice(0, 44)}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`\nSUMMARY: sampled ${Math.min(N, electronic.length)} PTRs · ${totalTxns} shown txns · ${withTicker} w/ticker · ${empties} empty · ${errors} error`);
