// Cashtags on X posts. The symbols come from the canonical event's own resolved tickers — the same
// field Pit Wire renders — and this layer never maps a company name to a symbol itself.
// Run: node scripts/verify-x-tickers.mjs

import { cashtags, formatPost, buildCandidate, MAX_CASHTAGS } from '../src/lib/x-autopost.mjs';
import { resolveCompanies, buildIndex } from '../src/lib/company-symbols.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const AT = '2026-09-14T05:00:00Z';
const NOW = Date.parse('2026-09-14T05:10:00Z');
const base = (o = {}) => ({ headline_status: 'composed', sources: ['FINANCIALJUICE'], published_at: AT,
  tickers: [], importance: 3, ...o });
const text = (o) => buildCandidate(base(o), null, NOW, []).text || '';

console.log('\n=== a resolved company is tagged ===');
ok('a HIGH company event carries its cashtag',
  /\$NVDA/.test(text({ headline: 'Nvidia raises full-year revenue outlook to $62 billion', tickers: ['NVDA'], importance: 2 })),
  text({ headline: 'Nvidia raises full-year revenue outlook to $62 billion', tickers: ['NVDA'], importance: 2 }));
// BREAKING is the publication gate's call, not the impact score's — a buyback announcement is real
// news but not breaking news. A definitive deal is, and the cashtag follows the label.
ok('a BREAKING company event carries the cashtag after the label',
  /^BREAKING: \$KD /.test(text({ headline: 'Kyndryl to acquire Healthcare IT Leaders', tickers: ['KD'], importance: 3 })),
  text({ headline: 'Kyndryl to acquire Healthcare IT Leaders', tickers: ['KD'], importance: 3 }));
ok('a non-breaking company event leads with the cashtag',
  /^\$COST: /.test(text({ headline: 'Costco reports Q4 EPS of $5.87 and revenue of $79.7 billion',
    tickers: ['COST'], importance: 2, sources: ['SEEKINGALPHA'] })));

console.log('\n=== multiple companies ===');
const deal = text({ headline: 'Kyndryl to acquire Healthcare IT Leaders for $1.2 billion', tickers: ['KD', 'IBM'], importance: 3 });
ok('both sides of a two-company event are tagged', /\$KD/.test(deal) && /\$IBM/.test(deal), deal);
ok('...space separated, in resolution order', /\$KD \$IBM/.test(deal), deal);
ok('the tag count is capped', cashtags({ tickers: ['A', 'B', 'C', 'D', 'E'] }).length === MAX_CASHTAGS);
ok('one symbol contributed twice is tagged once',
  cashtags({ tickers: ['NVDA', 'nvda', 'NVDA'] }).join(',') === 'NVDA');

console.log('\n=== no ticker is better than a wrong ticker ===');
ok('a macro print posts with no cashtag',
  !/\$/.test(text({ headline: 'US 6-Month Bill High Yield: 4.06% vs 3.97% previous', tickers: [], importance: 2 }).replace(/\$\d/g, '')),
  text({ headline: 'US 6-Month Bill High Yield: 4.06% vs 3.97% previous', tickers: [], importance: 2 }));
ok('a geopolitical event posts with no cashtag',
  !/\$[A-Z]/.test(text({ headline: 'Saudi Arabia shuts East-West pipeline after drone damage', tickers: [], importance: 3 })));
for (const label of ['MACRO', 'FED', 'HALT', 'MARKETS', 'PHARMA', 'ENERGY', 'FDA']) {
  ok(`the ${label} desk label is never a cashtag`, cashtags({ tickers: [label] }).length === 0);
}
ok('a phrase is never a cashtag', cashtags({ tickers: ['Glass Imaging', 'the company'] }).length === 0);
ok('a too-long symbol is refused', cashtags({ tickers: ['ABCDEFGH'] }).length === 0);
ok('a label mixed with a real symbol keeps only the symbol',
  cashtags({ tickers: ['MACRO', 'AAPL'] }).join(',') === 'AAPL');

console.log('\n=== share classes survive exactly ===');
ok('a dotted class is kept', cashtags({ tickers: ['BRK.B'] }).join(',') === 'BRK.B');
ok('a hyphenated class is kept', cashtags({ tickers: ['BF-B'] }).join(',') === 'BF-B');
ok('a dotted class is not widened or trimmed',
  /\$BRK\.B:/.test(text({ headline: 'Berkshire Hathaway Class B discloses a 5.2% stake', tickers: ['BRK.B'], importance: 2 })),
  text({ headline: 'Berkshire Hathaway Class B discloses a 5.2% stake', tickers: ['BRK.B'], importance: 2 }));
ok('GOOG is not widened to GOOGL', cashtags({ tickers: ['GOOG'] }).join(',') === 'GOOG');
// The dot in a class is a regex metacharacter. Unescaped, the prefix-strip would match "BRKXB " and
// eat a real character off the front of the sentence.
ok('the prefix strip does not eat a character on a dotted class',
  /Berkshire/.test(text({ headline: 'BRK.B: Berkshire Hathaway discloses a 5.2% stake', tickers: ['BRK.B'], importance: 2 })),
  text({ headline: 'BRK.B: Berkshire Hathaway discloses a 5.2% stake', tickers: ['BRK.B'], importance: 2 }));

console.log('\n=== the symbol is never printed twice ===');
ok('a symbol-prefixed canonical headline is de-duplicated',
  (text({ headline: 'NVDA: Nvidia raises outlook to $62 billion', tickers: ['NVDA'], importance: 2 }).match(/NVDA/g) || []).length === 1);
ok('...for every tag, not just the first',
  (text({ headline: 'KD: Kyndryl to acquire Healthcare IT Leaders for $1.2 billion', tickers: ['KD', 'IBM'], importance: 3 }).match(/KD/g) || []).length === 1);

console.log('\n=== halts are still excluded, tagged or not ===');
ok('a halt never posts even with a clean symbol',
  !buildCandidate(base({ headline: 'AAPL halted, volatility pause', headline_status: 'not_required',
    source_type: 'halt', tickers: ['AAPL'], importance: 3 }), null, NOW, []).publishable);

console.log('\n=== the resolver, not a hardcoded map, supplies the symbol ===');
// Proof that the same call Pit Wire makes produces what the post carries.
const idx = buildIndex([
  { ticker: 'COST', company: 'Costco Wholesale Corp' },
  { ticker: 'NVDA', company: 'NVIDIA Corporation' },
  { ticker: 'KD', company: 'Kyndryl Holdings Inc' },
]);
ok('Costco resolves through the shared resolver',
  resolveCompanies('Costco reports Q4 EPS of $5.87 and revenue of $79.7 billion', idx).join(',') === 'COST');
const resolved = resolveCompanies('Costco reports Q4 EPS of $5.87 and revenue of $79.7 billion', idx);
ok('...and that is exactly what the post tags',
  /^\$COST: /.test(text({ headline: 'Costco reports Q4 EPS of $5.87 and revenue of $79.7 billion',
    tickers: resolved, importance: 2 })));
ok('an unresolvable name yields no cashtag at all',
  resolveCompanies('Saudi Arabia shuts East-West pipeline', idx).length === 0);

console.log('\n=== a one-word ordinary name is not a company (both went out live) ===');
// PR wires publish in Title Case, where capitalisation proves nothing. Each of these was a real
// wrong cashtag on the public account.
const prIdx = buildIndex([
  { ticker: 'BYON', company: 'BEYOND, INC.' },            // reduces to BEYOND
  { ticker: 'NWGL', company: 'CL Workshop Group Ltd' },   // reduces to WORKSHOP
  { ticker: 'GLW', company: 'Corning Incorporated' },
  { ticker: 'COST', company: 'Costco Wholesale Corp' },
]);
ok('"Expanding Beyond SEO" is not $BYON',
  resolveCompanies('The SEO Answer Rebrands as Rank & Revenue, Expanding Beyond SEO with a Connected Growth Strategy', prIdx).length === 0,
  JSON.stringify(resolveCompanies('The SEO Answer Rebrands as Rank & Revenue, Expanding Beyond SEO', prIdx)));
ok('"AI Strike Workshop" is not $NWGL',
  resolveCompanies('EMILY Launches AI Strike Workshop to Help Businesses Use AI Strategically', prIdx).length === 0,
  JSON.stringify(resolveCompanies('EMILY Launches AI Strike Workshop to Help Businesses', prIdx)));
// The guard must not cost a real name that merely appears in a Title Case headline.
ok('...but Corning still resolves in Title Case',
  resolveCompanies('Corning Launches $2B At-The-Market Equity Offering', prIdx).join(',') === 'GLW');
ok('...and Costco still resolves in Title Case',
  resolveCompanies('Costco Raises Motor Oil Prices and Limits Purchases', prIdx).join(',') === 'COST');

console.log('\n=== the cashtag never eats the sentence subject ===');
// "Trex lifts outlook citing demand" went out as "$TREX: lifts outlook citing demand" — a sentence
// with nothing doing the lifting. The engine's own prefix always carries a separator; a bare
// repetition of the name is the source's own subject.
const trex = text({ headline: 'Trex lifts outlook citing demand and growth plan', tickers: ['TREX'], importance: 2 });
ok('a company name that equals its symbol is kept', /Trex lifts outlook/.test(trex), trex);
ok('...and the engine prefix, which carries a separator, is still removed',
  text({ headline: 'TREX: Trex Company lifts full-year outlook', tickers: ['TREX'], importance: 2 })
    === '$TREX: Trex Company lifts full-year outlook',
  text({ headline: 'TREX: Trex Company lifts full-year outlook', tickers: ['TREX'], importance: 2 }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
