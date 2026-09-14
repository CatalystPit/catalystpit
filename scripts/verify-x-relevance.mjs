// X RELEVANCE. Every example in this file is verbatim from the live account or from a measured
// 24-hour sample of what the previous gate would have posted.
// Run: node scripts/verify-x-relevance.mjs

import { classifyCatalyst, refusalReason, catalystKey, groundedFigures, subjectTickers, ONE_PER_EVENT } from '../src/lib/x-relevance.mjs';
import { buildCandidate } from '../src/lib/x-autopost.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const sec = (s) => console.log(`\n=== ${s} ===`);
const ev = (o = {}) => ({ headline: '', summary: '', tickers: [], importance: 2, facts: null, ...o });
const type = (h, o = {}) => classifyCatalyst(ev({ headline: h, ...o }))?.type ?? null;
const why = (h, o = {}) => refusalReason(ev({ headline: h, ...o }));

sec('the complaints that prompted this — all must BLOCK');
for (const [h, o] of [
  ['Fireplace expert discusses how remodeling can upgrade a home', {}],
  ['World Bank\'s Banga wants Senegal to restructure debt faster than prior cases', {}],
  ['Anthropic and OpenAI urge caution on AI development pace', {}],
  ['Trump and Altman disagree on AI safety guardrails', {}],
  ['Trump rejects warnings that AI could threaten humanity or harm communities', {}],
  ['Host Hotels & Resorts to report Q3 2026 results on November 4, 2026', { tickers: ['HST'] }],
  ['BioVie to host call on ADDRESS-LC Phase 2 data and bezisterim', { tickers: ['BIVI'] }],
  ['TriNet declares quarterly dividend', { tickers: ['TNET'] }],
  ['Orchid Island Capital declares $0.10 per share monthly dividend for September 2026', { tickers: ['ORC'] }],
  ['Realty Income to present at Bank of America 2026 Global Real Estate Conference', { tickers: ['O'] }],
  ['EMILY Revolutionary Marketing Group launches AI Strike workshop for businesses', {}],
  ['Category Five Technologies provides drinking water upgrade to Children\'s Discovery Museum', {}],
  ['Robbins Geller announces investor deadline for Regeneron class action', {}],
  ['Fed rate hike expected this week following inflation data', {}],
  ['Consumer Watchdog asks court to halt new tariffs', {}],
  ['Methode Electronics stock price ahead of earnings turnaround', { tickers: ['MEI'] }],
]) ok(`BLOCK: ${h.slice(0, 58)}`, type(h, o) === null, `classified ${type(h, o)}`);

sec('the content the desk asked for — all must POST');
for (const [expect, h, o] of [
  ['earnings', 'Dave & Buster\'s reports non-GAAP EPS of -$0.27, revenue of $544.1M', { tickers: ['PLAY'] }],
  ['guidance', 'Trex lifts full-year outlook citing demand', { tickers: ['TREX'] }],
  ['ma', 'Kyndryl to acquire Healthcare IT Leaders for $1.2 billion', { tickers: ['KD'] }],
  ['offering', 'Sysco announces $1.0 billion common stock offering', { tickers: ['SYY'] }],
  ['offering', 'TORM plc selling shareholder offers 9,000,000 Class A shares', { tickers: ['TRMD'] }],
  ['buyback', 'Ferrari purchases additional shares under Euro 250 million buyback program', { tickers: ['RACE'] }],
  ['dividend', 'Acme raises quarterly dividend 12%', { tickers: ['ACME'] }],
  ['fda', 'FDA clears Beta Bionics Mint patch pump', { tickers: ['BBNX'] }],
  ['clinical', 'Corbus Pharmaceuticals reports Phase 1b topline results for CRB-913', { tickers: ['CRBP'] }],
  ['analyst', 'Hewlett Packard Enterprise stock falls 11% following Evercore ISI downgrade', { tickers: ['HPE'] }],
  ['contract', 'Environmental Tectonics awarded $11.7M in contracts', { tickers: ['ETCC'] }],
  ['exec', 'Crown Castle names Kris Hinson CFO', { tickers: ['CCI'] }],
  ['bankruptcy', 'Acme files for Chapter 11 bankruptcy protection', { tickers: ['ACME'] }],
  ['legal', 'Abbott settles with DOJ for $385M over infant formula recall', { tickers: ['ABT'] }],
  ['credit_rating', 'Fitch upgrades Kite Realty Group to BBB+ with stable outlook', { tickers: ['KRG'] }],
  ['activist', 'Elliott discloses a 5.1% stake in Acme and nominates four directors', { tickers: ['ACME'] }],
  ['operations', 'Acme halts production at its main plant after fire', { tickers: ['ACME'] }],
  ['recall', 'Acme recalls 2 million units over safety defect', { tickers: ['ACME'] }],
  ['monetary', 'Fed cuts rates by 25 basis points', {}],
  ['macro_data', 'US CPI rises 3.2% year-over-year in August', {}],
  ['macro_data', 'Canada inflation holds at 3.0% year-over-year in August', {}],
  ['geopolitical', 'Saudi Arabia shuts East-West pipeline after drone damage', {}],
  ['geopolitical', 'Houthis seize Red Sea islands in offensive', {}],
  ['geopolitical', 'US announces new tariffs on Chinese semiconductors', {}],
  ['market_price', 'Spot gold falls nearly 1% to $4,306.19 per ounce', {}],
  ['congress', 'Senator discloses $1.2M in semiconductor stock trades', {}],
]) ok(`POST ${expect}: ${h.slice(0, 52)}`, type(h, o) === expect, `got ${type(h, o) ?? why(h, o)}`);

sec('a company catalyst needs a company');
ok('an offering with no resolved symbol does not post', type('Primaris REIT announces $200M equity offering') === null);
ok('...and says why', why('Primaris REIT announces $200M equity offering') === 'offering with no listed company');
ok('a market catalyst needs none', type('Fed cuts rates by 25 basis points') === 'monetary');
// A hard reporting print proves a reporting issuer even when the symbol did not resolve. Eleven
// real earnings reports in one day were refused for a missing symbol before this exception.
ok('an EPS print posts without a resolved symbol',
  type('Children\'s Place reports Non-GAAP EPS of -$0.82, revenue of $241.8M') === 'earnings');
ok('...but a vague earnings line still does not',
  type('American Battery Technology posts record FY 2026 earnings') === null);

sec('a figure is required where the number IS the news');
ok('an offering with no figure anywhere does not post', type('Acme announces equity offering', { tickers: ['ACME'] }) === null);
ok('...but the figure may come from the summary',
  type('Acme announces equity offering', { tickers: ['ACME'], summary: 'the offering of $300 million of notes' }) === 'offering');
ok('...or from the extracted facts',
  type('Acme announces equity offering', { tickers: ['ACME'], facts: { value: '$300 million' } }) === 'offering');

sec('international relevance');
ok('a minor economy\'s domestic timetable does not post',
  type('Senegal restructures its debt on a faster schedule') === null);
ok('a major economy\'s print does', type('China CPI rises 0.6% year-over-year') === 'macro_data');

sec('speculation is not an event');
ok('a considered deal does not post', type('Salesforce considers acquiring Listen Labs', { tickers: ['CRM'] }) === null);
ok('a definitive deal does', type('Salesforce agrees to acquire Listen Labs for $1.9 billion', { tickers: ['CRM'] }) === 'ma');

sec('ONE post per underlying event');
// Both canonical, both live-eligible, one earnings report. This is the pair that motivated the key.
const a = ev({ headline: 'High Tide reports non-GAAP EPS of C$0.12 and revenue of C$198.82M', facts: { actor: 'High Tide' } });
const b = ev({ headline: 'High Tide reports third quarter 2026 revenue of $199 million', facts: { actor: 'High Tide' } });
ok('two reports of one earnings print share a key',
  catalystKey(a, classifyCatalyst(a)) === catalystKey(b, classifyCatalyst(b)),
  `${catalystKey(a, classifyCatalyst(a))} vs ${catalystKey(b, classifyCatalyst(b))}`);
ok('...and the key names the subject and the type',
  catalystKey(a, classifyCatalyst(a)) === 'high-tide|earnings', catalystKey(a, classifyCatalyst(a)));
ok('the ticker is preferred as the subject when resolved',
  catalystKey(ev({ headline: 'Acme reports EPS of $1.00 and revenue of $5M', tickers: ['ACME'] }),
    { type: 'earnings' }) === 'ACME|earnings');
// Two banks downgrading one stock are two events, so analyst is deliberately not keyed.
ok('two analyst actions on one stock are NOT collapsed', !ONE_PER_EVENT.has('analyst'));
ok('nor are market-wide types', !ONE_PER_EVENT.has('geopolitical') && !ONE_PER_EVENT.has('monetary'));
ok('but an acquisition is', ONE_PER_EVENT.has('ma'));

sec('grounded figures — copied, never computed');
const bur = ev({ headline: 'Burford Capital prices share offering', tickers: ['BUR'],
  summary: 'Burford Capital Limited today announces the pricing of its private offering of $300 million aggregate principal amount of 8.000% senior secured notes due 2033.' });
const figs = groundedFigures(bur, { type: 'offering' });
ok('the offering size is carried', figs.some((f) => /\$300 million/.test(f)), JSON.stringify(figs));
ok('every figure appears verbatim in the source',
  figs.every((f) => bur.summary.toLowerCase().includes(f.toLowerCase())), JSON.stringify(figs));
ok('the post carries it', /\$300 million/.test(buildCandidate(
  { ...bur, headline_status: 'composed', sources: ['PRNEWSWIRE'], published_at: '2026-09-14T05:00:00Z' },
  null, Date.parse('2026-09-14T05:10:00Z'), []).text || ''),
  buildCandidate({ ...bur, headline_status: 'composed', sources: ['PRNEWSWIRE'], published_at: '2026-09-14T05:00:00Z' },
    null, Date.parse('2026-09-14T05:10:00Z'), []).text);
// A number the headline already prints is never repeated.
ok('a figure already in the headline is not appended',
  groundedFigures(ev({ headline: 'Acme announces $2 billion equity offering',
    summary: 'the offering of $2 billion of common stock' }), { type: 'offering' }).length === 0);
ok('nothing is produced when the event holds no figure',
  groundedFigures(ev({ headline: 'Acme announces offering', summary: 'Acme announced an offering.' }), { type: 'offering' }).length === 0);
ok('no figure is produced for a type with no pattern',
  groundedFigures(ev({ headline: 'x', summary: '$5 million' }), { type: 'exec' }).length === 0);

sec('a rating story is about the RATED company, not the rater');
// Both of these went out on the live account with the research firm cashtagged.
ok('the research firm is dropped, the subject kept',
  subjectTickers({ tickers: ['HPE', 'EVR'] }, { type: 'analyst' }).join(',') === 'HPE');
ok('...whichever order they resolved in',
  subjectTickers({ tickers: ['FRHC', 'CPRT'] }, { type: 'analyst' }).join(',') === 'CPRT');
ok('a credit agency is dropped too',
  subjectTickers({ tickers: ['SPGI', 'NEM'] }, { type: 'credit_rating' }).join(',') === 'NEM');
ok('when only the rater resolved the post goes out untagged',
  subjectTickers({ tickers: ['EVR'] }, { type: 'analyst' }).length === 0);
// A bank reporting its OWN earnings is the subject, so the rule must not reach other types.
ok('a bank reporting its own earnings keeps its symbol',
  subjectTickers({ tickers: ['GS'] }, { type: 'earnings' }).join(',') === 'GS');
ok('...and its own M&A', subjectTickers({ tickers: ['MS'] }, { type: 'ma' }).join(',') === 'MS');

sec('a yield is not always a rates event');
ok('one stock\'s dividend yield is not a credit-market move', type('AGNC dividend yield reaches 9.15%') === null);
ok('a treasury yield is', type('10-year yield climbs to 4.62%') === 'rates_credit');

sec('expectations are not decisions');
ok('Fed expectations building is not a monetary event',
  type('August mortgage lock volume falls as Fed rate hike expectations build') === null);
ok('an actual cut is', type('Fed cuts rates by 25 basis points') === 'monetary');

sec('halts stay excluded');
const halt = { headline: 'AAPL halted, volatility pause', headline_status: 'not_required', source_type: 'halt',
  tickers: ['AAPL'], importance: 3, sources: ['NASDAQ'], published_at: '2026-09-14T05:00:00Z' };
ok('a halt still never posts', !buildCandidate(halt, null, Date.parse('2026-09-14T05:10:00Z'), []).publishable);

sec('SEC filings are judged by their 8-K items, not by being SEC');
// POLICY, revised: source_kind 'sec' is no longer a permanent exile. The SOURCE still qualifies
// nothing — the filing has to pass the same catalyst rules as anything else.
const NOWF = Date.parse('2026-09-14T05:10:00Z');
const filing = (h, o = {}) => buildCandidate({ headline: h, headline_status: 'not_required',
  source_type: 'filing', source_kind: 'sec', category: 'FILING', sources: ['SEC'],
  published_at: '2026-09-14T05:00:00Z', importance: 2, tickers: ['CMG'], ...o }, null, NOWF, []);
ok('an SEC filing is no longer blocked outright', filing('CHIPOTLE MEXICAN GRILL INC · 8-K (5.02,9.01)').eligible);
ok('...with its own reason', filing('CHIPOTLE MEXICAN GRILL INC · 8-K (5.02,9.01)').reason === 'sec filing');
for (const [item, want] of [['1.03', 'bankruptcy'], ['2.01', 'ma'], ['2.02', 'earnings'],
  ['2.03', 'offering'], ['3.02', 'offering'], ['5.02', 'exec'], ['1.01', 'contract'],
  ['4.02', 'legal'], ['3.01', 'bankruptcy'], ['5.01', 'ma']]) {
  const c = classifyCatalyst({ headline: `ACME CORP · 8-K (${item},9.01)`, source_type: 'filing', tickers: ['ACME'] });
  ok(`item ${item} is a ${want}`, c?.type === want, `got ${c?.type}`);
}
// Routine items are the bulk of the feed and none of them is an event.
for (const item of ['7.01', '8.01', '9.01', '5.03', '5.07', '5.08', '1.04', '3.03']) {
  ok(`item ${item} alone is not an event`,
    classifyCatalyst({ headline: `ACME CORP · 8-K (${item})`, source_type: 'filing', tickers: ['ACME'] }) === null);
}
ok('the most material item wins over the exhibit index',
  classifyCatalyst({ headline: 'ACME CORP · 8-K (9.01,2.01,7.01)', source_type: 'filing', tickers: ['ACME'] })?.type === 'ma');
ok('a filing with no resolved symbol does not post',
  classifyCatalyst({ headline: 'ACME CORP · 8-K (5.02)', source_type: 'filing', tickers: [] }) === null);
// The post is composed from the SEC's own item definition, never from the index line.
const post = filing('CHIPOTLE MEXICAN GRILL INC · 8-K (5.02,9.01)').text;
ok('the EDGAR index line never reaches the post', !/8-K \(|·/.test(post || ''), post);
ok('the item is named in plain words', /departure or appointment of directors or officers/.test(post || ''), post);
ok('the item number is cited', /8-K item 5\.02/.test(post || ''), post);
ok('the registrant is not shouted', /Chipotle Mexican Grill/.test(post || ''), post);
ok('the cashtag is the registrant\'s own symbol', /^\$CMG: /.test(post || ''), post);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
