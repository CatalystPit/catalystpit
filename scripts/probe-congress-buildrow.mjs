// Validate the full official-source → buildRow transform (no DB writes).
// Confirms roster matching (party/state/bioguide), action mapping, amount parse, tx_hash.
// Run: node scripts/probe-congress-buildrow.mjs
import roster from '../src/lib/congress-roster.json' with { type: 'json' };
import { buildIndex } from '../src/lib/congress-match.mjs';
import { buildRow } from '../src/lib/congress-ingest.mjs';
import { fetchHouseIndex, fetchHousePtr, isEfiledDocId } from '../src/lib/congress-house.mjs';
import { fetchSenatePtrIndex, fetchSenatePtr, establishSession } from '../src/lib/congress-senate.mjs';

const index = buildIndex(roster);
const show = (r) => `${(r.representative||'').padEnd(22)} ${(r.party||'?').padEnd(3)} ${(r.state||'??').padEnd(3)} ${(r.memberSlug||'unmatched').padEnd(10)} ${(r.action||'').padEnd(9)} ${(r.ticker||'—').padEnd(6)} ${String(r.amountMid??'').padEnd(9)} tx=${r.transactionDate} disc=${r.disclosureDate} ${r.txHash.slice(0,8)}`;

// ── House ──
console.log('=== HOUSE ===');
const hidx = (await fetchHouseIndex(2024)).filter((e) => isEfiledDocId(e.docId));
let hMatched = 0, hTotal = 0;
for (const e of [hidx[0], hidx[50], hidx[120]]) {
  const res = await fetchHousePtr(e);
  for (const rec of res.recs) { const row = buildRow(rec, 'house', index); hTotal++; if (row.memberSlug && row.party) hMatched++; console.log(' ', show(row)); }
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`house matched party/slug: ${hMatched}/${hTotal}`);

// ── Senate ──
console.log('\n=== SENATE ===');
const yr = new Date().getUTCFullYear() - 1;
const { rows } = await fetchSenatePtrIndex({ startDate: `01/01/${yr} 00:00:00`, pageSize: 100, maxPages: 1 });
const cookies = await establishSession();
let sMatched = 0, sTotal = 0;
for (const row of rows.filter((r) => !r.isPaper).slice(0, 3)) {
  const res = await fetchSenatePtr(row, cookies);
  for (const rec of res.recs) { const built = buildRow(rec, 'senate', index); sTotal++; if (built.memberSlug && built.party) sMatched++; console.log(' ', show(built)); }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`senate matched party/slug: ${sMatched}/${sTotal}`);
