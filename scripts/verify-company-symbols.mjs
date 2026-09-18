// A company named in a headline gets its ticker. Nothing else does.
//
// The index is built from a FIXTURE here, not the database, so the matching rules are tested on
// their own and the suite runs anywhere. Every false positive pinned below was produced by a real
// headline during development.
//
// Run: node scripts/verify-company-symbols.mjs

import { buildIndex, resolveCompanies, tokens, pickOne, looksLikeIndustry, maskUnitsAfterNumbers, isRelationalContext, tickersSupportedBy } from '../src/lib/company-symbols.mjs';

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

console.log('\n=== basis points are not BP p.l.c. ===');
// "STANDARD CHARTERED EXPECTS US FED TO DELIVER A 25 BP RATE HIKE" went out on X as $BP. BP p.l.c.'s
// registered name reduces to the single token BP, so the unit after a figure read as the company.
const bp = buildIndex([
  { ticker: 'BP', company: 'BP PLC' },
  { ticker: 'SHEL', company: 'Shell plc' },
  { ticker: 'STAN', company: 'Standard Chartered PLC' },
]);
for (const h of [
  'Fed raises rates 25 BP',
  'Fed raises rates 25 BPS',
  'Fed raises rates 25 basis points',
  'STANDARD CHARTERED EXPECTS US FED TO DELIVER A 25 BP RATE HIKE IN DECEMBER 2026 VS PRIOR FORECAST OF NO POLICY CHANGE THIS YEAR',
  'ECB to cut by 50 Bps in October',
  'BoE hikes 25-BP to 5.5%',
  'Yields jump 12.5 BP after payrolls',
  'Spreads widen 1,000 BPS in stress scenario',
]) {
  const got = resolveCompanies(h, bp);
  ok(`no $BP from basis points: "${h.slice(0, 60)}"`, !got.includes('BP'), JSON.stringify(got));
}
for (const [h, want] of [
  ['BP shares fall after refinery outage', 'BP'],
  ['BP to sell stake in Castrol', 'BP'],
  ['Shell and BP report earnings', 'SHEL,BP'],
  ['BP raises dividend by 10%', 'BP'],
  ['BP cuts 25 jobs', 'BP'],
]) {
  const got = resolveCompanies(h, bp).join(',');
  ok(`BP p.l.c. still resolves: "${h}"`, got === want, got);
}
ok('the mask only touches a unit that directly follows a figure',
  maskUnitsAfterNumbers('BP up 25 BP; BPS 3 bps') === 'BP up 25 bp; BPS 3 bps', maskUnitsAfterNumbers('BP up 25 BP; BPS 3 bps'));

// ── SUBJECT vs CONTEXT ────────────────────────────────────────────────────────
// A company named as somebody else's franchisee, partner or supplier is context. The live account
// posted "BREAKING: $WEN Meritage Hospitality Group files for bankruptcy" — which reads as Wendy's
// filing for bankruptcy — because the source said "Giant Wendy's franchisee Meritage Hospitality
// Group files for bankruptcy" and the resolver had no idea who the sentence was about.
console.log('\n=== a company named as another company\'s relation is not the subject ===');
const rel = buildIndex([
  { ticker: 'WEN', company: "WENDY'S CO" },
  { ticker: 'MHGU', company: 'MERITAGE HOSPITALITY GROUP INC' },
  { ticker: 'COST', company: 'COSTCO WHOLESALE CORP /NEW' },
  { ticker: 'PLTR', company: 'PALANTIR TECHNOLOGIES INC' },
  { ticker: 'AAPL', company: 'Apple Inc.' },
  { ticker: 'NVDA', company: 'NVIDIA CORP' },
  { ticker: 'INTC', company: 'INTEL CORP' },
  { ticker: 'MSFT', company: 'MICROSOFT CORP' },
  { ticker: 'GOOGL', company: 'Alphabet Inc.' },
  // A company whose own registered name ENDS in a relationship word. Masking this would be the
  // overbroad rule the fix must not become.
  { ticker: 'AD', company: 'ALARIS EQUITY PARTNERS INCOME TRUST' },
  { ticker: 'EPD', company: 'ENTERPRISE PRODUCTS PARTNERS L P' },
]);

// THE THREE REAL FAILURES, as they were actually published.
for (const [h, banned, note] of [
  ["Giant Wendy's franchisee Meritage Hospitality Group files for bankruptcy", 'WEN', 'the franchisor is not bankrupt'],
  ["How a Costco partner's bankruptcy could benefit its biggest rival", 'COST', 'the partner went bankrupt, not Costco'],
  ['Nebius: Why The Palantir Partnership Is A Game Changer (Rating Upgrade)', 'PLTR', 'the story is about Nebius'],
]) {
  const got = resolveCompanies(h, rel);
  ok(`no $${banned} — ${note}`, !got.includes(banned), JSON.stringify(got));
}
// The franchisee IS the subject, and keeps its symbol.
ok('the actual subject still resolves',
  resolveCompanies("Giant Wendy's franchisee Meritage Hospitality Group files for bankruptcy", rel).includes('MHGU'));

// The mirror form.
for (const h of ['Meritage Hospitality Group, a franchisee of Wendy\'s, files for bankruptcy',
  'Foxconn, a supplier to Apple, raises guidance']) {
  const got = resolveCompanies(h, rel);
  ok(`the relation reversed is still context: "${h.slice(0, 44)}…"`, !got.includes('WEN') && !got.includes('AAPL'), JSON.stringify(got));
}

// ── and now everything the rule must NOT break ──
console.log('\n=== legitimate subjects keep their ticker ===');
for (const [h, want] of [
  ['Apple beats Q3 estimates on iPhone strength', 'AAPL'],
  ["Wendy's closes 140 underperforming restaurants", 'WEN'],
  ["Wendy's names new chief executive", 'WEN'],
  ['Costco raises membership fees', 'COST'],
  ['Palantir wins $480 million Army contract', 'PLTR'],
  // The company IS acting — the giveaway is `with`/`and`, not the noun.
  ['Apple partners with Google on search deal', 'AAPL'],
  ['Nvidia partnership with Intel boosts AI roadmap', 'NVDA'],
  ['Microsoft and Palantir partner on defense cloud', 'MSFT'],
  // A relationship word that belongs to the company's own registered name.
  ['Alaris Equity Partners announces $100 million bought deal', 'AD'],
  ['Enterprise Products Partners raises quarterly distribution', 'EPD'],
]) {
  const got = resolveCompanies(h, rel);
  ok(`"${h.slice(0, 48)}…" still resolves $${want}`, got.includes(want), JSON.stringify(got));
}
// A genuine two-company partnership loses NEITHER ticker, in both word orders.
{
  const a = resolveCompanies('Nvidia partnership with Intel boosts AI roadmap', rel);
  ok('a joint partnership keeps both subjects', a.includes('NVDA') && a.includes('INTC'), JSON.stringify(a));
  // The compound subject: "and X partner" is X doing the partnering, not X being somebody's partner.
  const b = resolveCompanies('Microsoft and Palantir partner on defense cloud', rel);
  ok('a compound subject keeps both too', b.includes('MSFT') && b.includes('PLTR'), JSON.stringify(b));
}
ok('the predicate is directly testable',
  isRelationalContext("Wendy's franchisee Meritage files", "Wendy's", rel) === true
  && isRelationalContext('Apple partners with Google', 'Apple', rel) === false);
// A relationship word that is part of the company's OWN name must never make it context. Asserted on
// the predicate, because the span that would be harmed is normally shadowed by the longer one.
ok('a name ending in a relationship word is not context',
  isRelationalContext('Alaris Equity Partners announces $100 million bought deal', 'Alaris Equity', rel) === false);
// SMART QUOTES. Wires publish "Wendy’s" far more often than "Wendy's", and the tokenizer stops at
// the curly apostrophe — so the possessive arrives detached and the check has to survive it.
{
  const curly = 'Giant Wendy’s franchisee Meritage Hospitality Group files for bankruptcy';
  ok('a curly apostrophe is still a possessive', !resolveCompanies(curly, rel).includes('WEN'),
    JSON.stringify(resolveCompanies(curly, rel)));
  ok('…and the subject still resolves', resolveCompanies(curly, rel).includes('MHGU'));
}

// ── THE STRUCTURAL GUARD ──────────────────────────────────────────────────────
// Resolution reads the source headline; Catalyst Pit publishes its own sentence. A symbol whose
// company our wording never names does not survive onto the published event.
console.log('\n=== a ticker must be supported by the wording we publish ===');
ok('the exact failure: our sentence never says Wendy\'s, so $WEN is dropped',
  tickersSupportedBy('Meritage Hospitality Group files for bankruptcy', ['WEN'], rel).length === 0);
ok('…while the company we DID name survives',
  tickersSupportedBy('Meritage Hospitality Group files for bankruptcy', ['MHGU', 'WEN'], rel).join() === 'MHGU');
ok('a named company is supported', tickersSupportedBy('Apple beats Q3 estimates', ['AAPL'], rel).includes('AAPL'));
ok('a printed symbol is supported even without the name',
  tickersSupportedBy('$AAPL: iPhone sales rise 12%', ['AAPL'], rel).includes('AAPL'));
ok('two named companies both survive',
  tickersSupportedBy('Microsoft and Palantir sign defense deal', ['MSFT', 'PLTR'], rel).length === 2);
ok('nothing to check is nothing to drop', tickersSupportedBy('anything', [], rel).length === 0);
ok('no index means no dropping — the guard fails open, never silently empty',
  tickersSupportedBy('Meritage files', ['WEN'], null).join() === 'WEN');
ok('duplicates collapse', tickersSupportedBy('Apple rises', ['AAPL', 'AAPL'], rel).length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
