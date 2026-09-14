// A company named in a headline gets its ticker. Nothing else does.
//
// The index is built from a FIXTURE here, not the database, so the matching rules are tested on
// their own and the suite runs anywhere. Every false positive pinned below was produced by a real
// headline during development.
//
// Run: node scripts/verify-company-symbols.mjs

import { buildIndex, resolveCompanies, tokens, pickOne, looksLikeIndustry } from '../src/lib/company-symbols.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// Shaped exactly like the real reference rows, legal suffixes and all.
const idx = buildIndex([
  { ticker: 'AAPL', company: 'Apple Inc.' },
  { ticker: 'APLE', company: 'Apple Hospitality REIT, Inc.' },
  { ticker: 'MSFT', company: 'MICROSOFT CORP' },
  { ticker: 'NVDA', company: 'NVIDIA CORP' },
  { ticker: 'TSLA', company: 'Tesla, Inc.' },
  { ticker: 'COST', company: 'COSTCO WHOLESALE CORP /NEW' },
  { ticker: 'ABT', company: 'ABBOTT LABORATORIES' },
  { ticker: 'KD', company: 'Kyndryl Holdings, Inc.' },
  { ticker: 'NEE', company: 'NEXTERA ENERGY INC' },
  { ticker: 'F', company: 'FORD MOTOR CO' },
  { ticker: 'MU', company: 'MICRON TECHNOLOGY INC' },
  { ticker: 'GOOGL', company: 'Alphabet Inc.' },
  { ticker: 'BRK.A', company: 'BERKSHIRE HATHAWAY INC' },
  { ticker: 'BRK.B', company: 'BERKSHIRE HATHAWAY INC' },
  { ticker: 'OI', company: 'O-I Glass, Inc.' },
  { ticker: 'TTWO', company: 'Take-Two Interactive Software, Inc.' },
  { ticker: 'ITW', company: 'ILLINOIS TOOL WORKS INC' },
  { ticker: 'STT', company: 'STATE STREET CORP' },
  { ticker: 'SWK', company: 'STANLEY BLACK & DECKER, INC.' },
  { ticker: 'MS', company: 'MORGAN STANLEY' },
  { ticker: 'LLY', company: 'ELI LILLY & Co' },
  { ticker: 'XXNOPE', company: 'RETAIL-VARIETY STORES' },        // an SIC description, must be ignored
]);

console.log('\n=== the names that must resolve ===');
const YES = [
  ['Costco raises motor oil prices and limits purchases', 'COST'],
  ['Apple unveils M5 silicon', 'AAPL'],
  ['Microsoft raises dividend 10%', 'MSFT'],
  ['Nvidia beats Q3 estimates', 'NVDA'],
  ['Tesla recalls 12,000 vehicles', 'TSLA'],
  ['Abbott settles with DOJ for $385M over infant formula recall', 'ABT'],
  ['Kyndryl to acquire Healthcare IT Leaders', 'KD'],
  ['NextEra Energy reaffirms 2026 earnings guidance', 'NEE'],
  ['Ford recalls 50,000 trucks', 'F'],
  ['Micron beats on memory demand', 'MU'],
  ["Wall Street Lunch: Tesla's Roadster Could Be Ready To Take Flight", 'TSLA'],
];
for (const [h, t] of YES) ok(`${t} from "${h.slice(0, 40)}"`, resolveCompanies(h, idx)[0] === t, JSON.stringify(resolveCompanies(h, idx)));

console.log('\n=== multiple companies are preserved ===');
const two = resolveCompanies('Microsoft and Nvidia announce AI partnership', idx);
ok('both are attached', two.includes('MSFT') && two.includes('NVDA'), JSON.stringify(two));
ok('order follows the headline', two[0] === 'MSFT');

console.log('\n=== share classes ===');
ok('an unqualified Berkshire resolves to nothing, not the wrong class',
  resolveCompanies('Berkshire Hathaway trims stake', idx).length === 0);
ok('a prefix family collapses to the shortest', pickOne(new Set(['GOOG', 'GOOGL'])) === 'GOOG');
ok('two real classes do not', pickOne(new Set(['BRK.A', 'BRK.B'])) === null);
ok('one ticker is itself', pickOne(new Set(['AAPL'])) === 'AAPL');

console.log('\n=== an exact name beats a longer one that starts the same ===');
ok('Apple is AAPL, not ambiguous with Apple Hospitality', resolveCompanies('Apple unveils M5', idx)[0] === 'AAPL');

console.log('\n=== macro, geopolitics and instruments never get a ticker ===');
for (const h of [
  'Saudi Arabia shuts East-West pipeline after drone damage',
  'Fed cuts rates by 25 basis points',
  'Brent crude reaches $108 after Saudi pipeline shutdown',
  'US CPI rose 0.2% in August',
  'Yemen Houthis seize more islands in southern Red Sea',
  'Trump says Iran wants to make a deal quickly',
  'European Central Bank holds rates',
]) ok(`no ticker: "${h.slice(0, 44)}"`, resolveCompanies(h, idx).length === 0, JSON.stringify(resolveCompanies(h, idx)));

console.log('\n=== false positives, each one a real headline from development ===');
for (const [h, why] of [
  ['ETF industry reaches high despite August rout', 'August is not a company'],
  ['States and cities sue to block Trump immigration rule', 'States is not State Street'],
  ['Northeastern Illinois University retention reaches 65%', 'Illinois is a state, not Illinois Tool Works'],
  ['Payment Nerds secures $2 million credit facility', 'Payment is a generic word'],
  ['Citizens Commission on Human Rights International', 'none of these words is a company'],
  ['Why Pacing The Frontier AI Will Not Work', 'Work and Frontier are ordinary words'],
  ['OpenAI buys Glass Imaging startup for above $300 million', 'both companies are private'],
  ['Occidental: Keep An Eye On The Carbon Capture Space', 'Space is not a company'],
]) ok(`refused: ${why}`, resolveCompanies(h, idx).length === 0, JSON.stringify(resolveCompanies(h, idx)));

console.log('\n=== a conference host is a venue, not the subject ===');
const lly = resolveCompanies('Eli Lilly expands obesity push at Morgan Stanley healthcare conference', idx);
ok('the subject is attached', lly.includes('LLY'), JSON.stringify(lly));
ok('the host bank is not', !lly.includes('MS') && !lly.includes('SWK'), JSON.stringify(lly));
ok('...but a bank doing something itself still resolves',
  resolveCompanies('Morgan Stanley raises its dividend', idx).includes('MS'));

console.log('\n=== reference-data hygiene ===');
ok('an SIC description is not indexed as a name', resolveCompanies('Retail Variety Stores gains', idx).length === 0);
ok('looksLikeIndustry spots one', looksLikeIndustry('SERVICES-COMPUTER PROGRAMMING, DATA PROCESSING, ETC.'));
ok('...and does not reject a real name', !looksLikeIndustry('Apple Inc.'));
ok('single letters survive normalisation', tokens('O-I Glass, Inc.').join('') === 'OIGLASS');
ok('a possessive is stripped', tokens("Tesla's").join('') === 'TESLA');
ok('an ampersand becomes a word boundary', tokens('AT&T').join('|') === 'AT|T');
ok('legal scaffolding is dropped', tokens('Kyndryl Holdings, Inc.').join('') === 'KYNDRYL');

console.log('\n=== a single word only counts when it IS the whole name ===');
ok('Take does not reach Take-Two', resolveCompanies('Ready To Take Flight', idx).length === 0);
ok('Stanley does not reach Stanley Black & Decker', resolveCompanies('Stanley said the plan works', idx).length === 0);

console.log('\n=== coverage: names the resolver used to miss ===');
// Every one of these was a real event blocked for having no ticker, measured over 24 hours.
const cov = buildIndex([
  { ticker: 'BAC', company: 'BANK OF AMERICA CORP /DE/' },
  { ticker: 'VKI', company: 'BANK OF AMERICA' },          // stale reference row, collides with BAC
  { ticker: 'RFIL', company: 'R F INDUSTRIES LTD' },
  { ticker: 'CGEM', company: 'Cullinan Therapeutics, Inc.' },
  { ticker: 'TLX', company: 'Telix Pharmaceuticals Ltd' },
  { ticker: 'HUBG', company: 'Hub Group, Inc.' },
  { ticker: 'EQBK', company: 'Equity Bancshares, Inc.' },
  { ticker: 'PDM', company: 'Piedmont Realty Trust, Inc.' },
]);
// A connector word is scaffolding on BOTH sides. The headline span never contains "of" — it is
// lowercase and spans are built from capitalised words — so the registrant could not keep it.
ok('"Bank of America" resolves', resolveCompanies('Bank of America lowers trading guidance', cov).join(',') === 'BAC');
ok('...and a curated alias outranks a colliding reference row',
  resolveCompanies('Bank of America reports Q3 results', cov).join(',') === 'BAC');
// Initials: "R F INDUSTRIES" as filed vs "RF Industries" as written.
ok('a run of initials is one token', tokens('R F INDUSTRIES LTD').join('|') === 'RF|INDUSTRIES');
ok('"RF Industries" resolves', resolveCompanies('RF Industries earnings miss by $0.01', cov).join(',') === 'RFIL');
ok('an ampersand name is NOT collapsed', tokens('AT&T').join('|') === 'AT|T');
// Renamed / trading-name differences: the head survives, the industry word changes.
ok('"Cullinan Oncology" reaches Cullinan Therapeutics',
  resolveCompanies('BTIG raises Cullinan Oncology price target', cov).join(',') === 'CGEM');
ok('"Telix Pharma" reaches Telix Pharmaceuticals',
  resolveCompanies('Telix Pharma wins FDA approval', cov).join(',') === 'TLX');

console.log('\n=== the rename rule must not invent a ticker ===');
// A generic head shared with another issuer is not evidence. Both of these produced a WRONG cashtag
// before the uniqueness and two-token guards.
ok('"Alaris Equity Partners" does not reach Equity Bancshares',
  resolveCompanies('Alaris Equity Partners announces $100 million offering', cov).length === 0,
  JSON.stringify(resolveCompanies('Alaris Equity Partners announces $100 million offering', cov)));
// Unique in OUR universe is not unique in the market: Piedmont Lithium is simply absent from it.
ok('a bare single-word head never resolves by rename',
  resolveCompanies('Piedmont plans $200M exchangeable notes offering', cov).length === 0,
  JSON.stringify(resolveCompanies('Piedmont plans $200M exchangeable notes offering', cov)));
ok('the old single-word false positives stay refused',
  resolveCompanies('Ready To Take Flight', idx).length === 0
  && resolveCompanies('Stanley said the plan works', idx).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
