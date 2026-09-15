// MACRO is a label, not a security.
//
// The breaking wires tag each flash with the desk it belongs to, in cashtag form:
//   "US 3-MONTH BILL HIGH YIELD ACTUAL 4.06% (FORECAST -, PREVIOUS 3.97%) $MACRO"
// The ticker resolver read $MACRO as a stated ticker, so the event got tickers:['MACRO'] and
// entity 'MACRO', canonicalHeadline prefixed the sentence with "MACRO: ", Pit Wire painted its own
// green MACRO category chip beside it, and clicking the row sent MACRO to TradingView, which
// answers "This symbol doesn't exist".
//
// The two halves of the fix are tested here: the resolver distinguishes taxonomy from securities,
// and the release shape is restated as a sentence without altering a single figure.
//
// Run: node scripts/verify-macro-labels.mjs

import { statedTickersIn, cleanHeadline, canonicalHeadline, formatEconomicRelease,
  isTaxonomyLabel, TAXONOMY_LABELS } from '../src/lib/news-normalize.mjs';
import { CATEGORIES, EVENT_TYPES, SOURCE_GROUPS } from '../src/lib/wire-taxonomy.mjs';
// decorate() moved server-side with the vendor roster; wire-taxonomy.mjs now ships only display
// vocabulary to the browser. Imported from the unguarded impl because server-only blocks plain Node.
import { decorate } from '../src/lib/wire-sources.mjs';
import { formatPost } from '../src/lib/x-autopost.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } };

console.log('\n=== the exclusion list covers the product\'s OWN vocabulary ===');
// This is what makes the fix structural rather than a patch for one word: adding a category to
// wire-taxonomy.mjs fails this test until the resolver knows it is a label.
const missingCat = CATEGORIES.map((c) => c.key.toUpperCase()).filter((k) => !TAXONOMY_LABELS.has(k));
ok('every Pit Wire CATEGORY is a known label', missingCat.length === 0, missingCat.join(', '));
const missingType = EVENT_TYPES.map((t) => t.key.toUpperCase()).filter((k) => !TAXONOMY_LABELS.has(k));
ok('every EVENT TYPE is a known label', missingType.length === 0, missingType.join(', '));
const missingGroup = SOURCE_GROUPS.map((g) => g.key.toUpperCase())
  .filter((k) => k !== 'SEC' && !TAXONOMY_LABELS.has(k));   // SEC is already in NOT_TICKERS
ok('every SOURCE GROUP is a known label', missingGroup.length === 0, missingGroup.join(', '));
for (const l of ['MACRO', 'MARKETS', 'PHARMA', 'ENERGY', 'HALT', 'CRYPTO', 'FX', 'BREAKING'])
  ok(`${l} is a label`, isTaxonomyLabel(l));

console.log('\n=== a desk tag never becomes a ticker ===');
const flashes = [
  'US 3-MONTH AWARDED HIGH ACTUAL 13.860% (FORECAST -, PREVIOUS 20.330%) $MACRO|FJ',
  'US 6-MONTH BILL HIGH YIELD ACTUAL 4.06% (FORECAST -, PREVIOUS 3.97%) $MACRO',
  'US 3-MONTH BILL BID-TO-COVER ACTUAL 2.74 (FORECAST 2.60, PREVIOUS 2.81) $MACRO (@BreakingMarketNews)',
];
for (const f of flashes) ok('no ticker from a macro flash', statedTickersIn(f).length === 0, JSON.stringify(statedTickersIn(f)));
ok('$MARKETS is not a ticker', statedTickersIn('EUROPEAN STOCKS OPEN HIGHER $MARKETS').length === 0);
ok('$ENERGY is not a ticker', statedTickersIn('CRUDE INVENTORIES DRAW 2.1M BARRELS $ENERGY').length === 0);
ok('$HALT is not a ticker', statedTickersIn('TRADING RESUMES $HALT').length === 0);

console.log('\n=== a real symbol is still a real symbol ===');
ok('a normal cashtag survives', statedTickersIn('APPLE Q3 EPS $1.40 BEATS EST $AAPL').includes('AAPL'));
ok('two cashtags survive', statedTickersIn('$MSFT to buy $ATVI').join() === 'MSFT,ATVI');
// The exception that keeps a real company out of the blast radius: GOLD is Barrick Gold on the NYSE
// and ENERGY-shaped words are real tickers too, so an EXCHANGE-QUALIFIED statement is still believed.
ok('an exchange-qualified label-shaped symbol is kept',
  statedTickersIn('Barrick Gold (NYSE: GOLD) reports record output').includes('GOLD'));
// Commodity words are deliberately NOT in the label set. GOLD is Barrick Gold's real NYSE ticker,
// and the instruction is explicit: never remove a legitimate ticker when a real security may be
// involved. The label set holds the product's own desk vocabulary, which no issuer trades under.
ok('a commodity word that is also a real ticker is left alone',
  statedTickersIn('SPOT GOLD RISES 1.2% $GOLD').includes('GOLD'));
ok('a macro story that names a listed company keeps the company',
  statedTickersIn('Fed decision lifts (NASDAQ: TLT) holders $MACRO').includes('TLT'));

console.log('\n=== presentation: no duplicated label, no stray desk tag ===');
const shown = (raw) => canonicalHeadline(cleanHeadline(raw), statedTickersIn(raw));
ok('the MACRO prefix is gone', !/^MACRO:/i.test(shown(flashes[1])));
ok('the trailing desk tag is gone', !/\$macro/i.test(shown(flashes[1])));
ok('reads as a sentence', shown(flashes[1]) === 'US 6-Month Bill High Yield: 4.06% vs. 3.97% previous',
  shown(flashes[1]));
ok('actual and previous are preserved exactly',
  shown(flashes[0]) === 'US 3-Month Awarded High: 13.860% vs. 20.330% previous', shown(flashes[0]));
ok('forecast is preserved when the source gives one',
  shown(flashes[2]) === 'US 3-Month Bill Bid-to-Cover: 2.74 vs. 2.60 forecast, 2.81 previous', shown(flashes[2]));
ok('a missing forecast is dropped, never filled in',
  !/forecast/i.test(shown(flashes[1])) && !/-/.test(shown(flashes[1]).split(':')[1]));
ok('no figure is invented', formatEconomicRelease('US CPI YOY ACTUAL 2.4%') === 'US CPI YOY: 2.4%');
ok('a headline that is not a release is untouched',
  formatEconomicRelease('Tesla recalls 12,000 vehicles over airbag defect')
    === 'Tesla recalls 12,000 vehicles over airbag defect');
ok('a real ticker still prefixes its headline', shown('APPLE Q3 EPS $1.40 BEATS EST $AAPL').startsWith('AAPL:'));

console.log('\n=== the chart never receives a label ===');
const row = decorate({ seq: 1, headline: 'US 6-Month Bill High Yield: 4.06%', tickers: ['MACRO'],
  category: 'MACRO', source: 'FINANCIALJUICE', importance: 1 });
ok('a stored label ticker is stripped on the way out', row.tickers.length === 0, JSON.stringify(row.tickers));
ok('...and the green MACRO label is kept', row.wireCategory === 'MACRO', row.wireCategory);
const mixed = decorate({ seq: 2, headline: 'Fed decision lifts long bonds', tickers: ['MACRO', 'TLT'],
  category: 'MACRO', source: 'FINANCIALJUICE' });
ok('a genuine ticker alongside a label is kept', mixed.tickers.join() === 'TLT', mixed.tickers.join());

console.log('\n=== X never posts $MACRO ===');
const ev = { headline: 'US 6-Month Bill High Yield: 4.06% vs. 3.97% previous', tickers: ['MACRO'],
  importance: 3, published_at: '2026-09-14T15:30:00Z' };
const post = formatPost(ev, null, Date.parse('2026-09-14T15:35:00Z'), false);
ok('no $MACRO in the post text', !/\$MACRO/i.test(post.text), post.text);
ok('...and it is not shaped as a ticker post', post.shape === 'plain', post.shape);
const real = formatPost({ ...ev, tickers: ['AAPL'] }, null, Date.parse('2026-09-14T15:35:00Z'), false);
ok('a real ticker still leads the post', real.text.startsWith('$AAPL'), real.text);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
