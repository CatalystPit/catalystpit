// Re-fetch the 703-transaction Senate PTR and measure exactly where the rows go.
import { establishSession, fetchSenatePtr } from '../src/lib/congress-senate.mjs';
import { canonicalHash } from '../src/lib/congress-ingest.mjs';
import { createHash } from 'node:crypto';

const row = {
  first: 'Alan', last: 'Armstrong', filingDate: '2026-07-21',
  href: 'https://efdsearch.senate.gov/search/view/ptr/fda235b3-bad7-4637-8fa1-053f354d929c/',
};
const cookies = await establishSession();
const res = await fetchSenatePtr(row, cookies);
console.log('parser found:', res.transactions.length, 'transactions   status:', res.status);

const AMT = (a) => {
  const n = String(a || '').match(/[\d,]+/g)?.map((x) => +x.replace(/,/g, '')) || [];
  return { min: n[0] ?? null, max: n[1] ?? null };
};
const act = (t) => /purchase/i.test(t || '') ? 'BUY' : /sale|sold/i.test(t || '') ? 'SELL' : 'OTHER';

const cur = new Set(), withOwner = new Set(), withAsset = new Set(), full = new Set();
let nullTicker = 0;
for (const t of res.transactions) {
  const { min, max } = AMT(t.amount);
  const opt = /option|call|put|strike/i.test([t.assetDescription,t.assetType,t.type].join(" "));
  const base = { memberSlug: 'A000383', transactionDate: t.transactionDate, ticker: t.ticker, action: act(t.type), amountMin: min, amountMax: max, isOption: opt };
  if (!t.ticker) nullTicker++;
  cur.add(canonicalHash(base));
  const k = (extra) => createHash('sha256').update(canonicalHash(base) + '|' + extra).digest('hex');
  withOwner.add(k(t.owner || ''));
  withAsset.add(k((t.assetDescription || '').trim().toLowerCase()));
  full.add(k((t.owner || '') + '|' + (t.assetDescription || '').trim().toLowerCase()));
}
console.log('null-ticker transactions :', nullTicker, `(${(nullTicker / res.transactions.length * 100).toFixed(0)}%)`);
console.log('');
console.log('distinct rows that SURVIVE each dedup key:');
console.log('  current  (slug|date|ticker|action|amounts)      ', cur.size, '  <- what we stored');
console.log('  + owner                                        ', withOwner.size);
console.log('  + assetDescription                             ', withAsset.size);
console.log('  + owner + assetDescription                     ', full.size, '  of', res.transactions.length);
