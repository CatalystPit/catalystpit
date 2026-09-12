// Prove the canonical tx_hash collapses the SAME real trade across sources.
// Run: node scripts/probe-canonical-dedup.mjs
import roster from '../src/lib/congress-roster.json' with { type: 'json' };
import { buildIndex } from '../src/lib/congress-match.mjs';
import { buildRow } from '../src/lib/congress-ingest.mjs';

const index = buildIndex(roster);

// Same underlying trade — Josh Gottheimer sells ADBE ~$1,001-$15,000 on 2024-06-13 —
// as it would arrive from each source (different raw type/amount/name formatting, different disclosure date).
const fmp    = { firstName: 'Josh', lastName: 'Gottheimer', district: 'NJ05', symbol: 'ADBE', type: 'Sale',          amount: '$1,001 - $15,000', transactionDate: '2024-06-13', disclosureDate: '2024-07-09', assetDescription: 'Adobe Inc' };
const house  = { firstName: 'Josh', lastName: 'Gottheimer', district: 'NJ05', symbol: 'ADBE', type: 'Sale',          amount: '$1,001 - $15,000', transactionDate: '2024-06-13', disclosureDate: '2024-07-09', assetDescription: 'Adobe Inc. - Common Stock (ADBE)' };
const senate = { firstName: 'Josh', lastName: 'Gottheimer', district: null,   symbol: 'ADBE', type: 'Sale (Full)',   amount: '$1,001 - $15,000', transactionDate: '2024-06-13', disclosureDate: '2024-07-11', assetDescription: 'Adobe Inc. - Common Stock' };

const h1 = buildRow(fmp, 'house', index).txHash;
const h2 = buildRow(house, 'house', index).txHash;
const h3 = buildRow(senate, 'senate', index).txHash;   // note: different chamber + no disclosure-date/type-format influence
console.log('fmp   ', h1);
console.log('house ', h2);
console.log('senate', h3);
console.log(h1 === h2 && h2 === h3 ? '✅ all identical — dedups to ONE row' : '❌ MISMATCH — would duplicate');

// Different trades must NOT collide.
const other = buildRow({ ...fmp, amount: '$15,001 - $50,000' }, 'house', index).txHash;   // different amount bucket
console.log('\ndifferent amount bucket →', other !== h1 ? '✅ distinct hash (kept separate)' : '❌ wrongly merged');
const otherDay = buildRow({ ...fmp, transactionDate: '2024-06-14' }, 'house', index).txHash;
console.log('different trade date  →', otherDay !== h1 ? '✅ distinct hash (kept separate)' : '❌ wrongly merged');
