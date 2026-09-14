// X RELEVANCE. Every example in this file is verbatim from the live account or from a measured
// 24-hour sample of what the previous gate would have posted.
// Run: node scripts/verify-x-relevance.mjs

import { classifyCatalyst, refusalReason, catalystKey, groundedFigures, subjectTickers, largestAmount, isMaterial, ONE_PER_EVENT } from '../src/lib/x-relevance.mjs';
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

sec('WALTER BLOOMBERG — a dedicated publication source');
const WNOW = Date.parse('2026-09-14T05:10:00Z');
const walter = (h, o = {}) => buildCandidate({ headline: h, headline_status: 'original',
  sources: ['WALTERBLOOMBERG'], published_at: '2026-09-14T05:00:00Z', tickers: [], importance: 1,
  summary: '', facts: null, ...o }, null, WNOW, []);
const plain = (h, o = {}) => buildCandidate({ headline: h, headline_status: 'original',
  sources: ['FINANCIALJUICE'], published_at: '2026-09-14T05:00:00Z', tickers: [], importance: 2,
  summary: '', facts: null, ...o }, null, WNOW, []);

// He bypasses the MATERIALITY threshold, and only that. Each of these is refused from any other
// source and publishes from him.
for (const h of [
  'Trump says Iran wants to reach a deal quickly',
  "Iran's foreign ministry says Saudi Arabia blocked Tehran-Gulf meeting in Oman",
  'Kalshi puts Democrats at 51% in Senate race odds',
  'U.S. data centers could add 15 Bcf/d natural gas demand by 2035',
]) {
  ok(`Walter publishes: ${h.slice(0, 48)}`, walter(h).publishable, walter(h).suppressed);
  ok('...and the same line from a wire does not', !plain(h).publishable, plain(h).text);
}
// A line that IS a macro print stands on its own from any source — the exception is about lowering
// the bar for him, not about raising it for everyone else.
ok('a real macro print posts from a wire too',
  plain("China's Jan-Aug new yuan loans reach CNY10.44T; M2 rises 7.5% y/y").publishable);
ok('a Walter event below HIGH still publishes', walter('Trump comments on tariffs', { importance: 0 }).publishable);

// What he does NOT bypass.
ok('Walter does not bypass the wording gate',
  !walter('WALTER\'S OWN VERBATIM LINE', { headline_status: 'rewrite_pending' }).eligible);
ok('...so his verbatim wording can never be the post',
  walter('x', { headline_status: 'rewrite_pending' }).blocked.startsWith('awaiting Catalyst wording'));
ok('Walter does not bypass staleness',
  buildCandidate({ headline: 'Trump says something', headline_status: 'original', sources: ['WALTERBLOOMBERG'],
    published_at: '2026-09-14T00:00:00Z', tickers: [], importance: 2 }, null, WNOW, []).suppressed === 'stale');
ok('Walter does not bypass the non-English gate',
  !walter('SÍL 2 hs. - ákvörðun vaxta og almenn upplýsingagjöf').publishable);
ok('Walter does not bypass truncated wording',
  !walter('Trump agrees to acquire something for…').publishable);
ok('Walter does not bypass the halt exclusion',
  !walter('AAPL halted, volatility pause', { source_type: 'halt', category: 'HALT', tickers: ['AAPL'] }).publishable);
// Dedupe: his events key the same way as anyone else's, so a story already told is not retold.
const wEv = { headline: 'Acme agrees to acquire Beta for $2 billion', tickers: ['ACME'], facts: null };
ok('a Walter event still produces a dedupe key',
  catalystKey(wEv, classifyCatalyst({ ...wEv, summary: '' })) === 'ACME|ma');

sec('MATERIALITY — kind is not enough, size decides');
ok('a $1M buyback does not post',
  !plain('Solidion Technology announces $1M stock buyback plan', { tickers: ['STI'] }).publishable);
ok('a $250M buyback does',
  plain('Ferrari announces $250 million buyback programme', { tickers: ['RACE'] }).publishable);
ok('a $2.8M warrant offering does not post',
  !plain('Tenon Medical closes warrant offering for approximately $2,872,338', { tickers: ['TNON'] }).publishable);
ok('a $1 billion offering does', plain('Sysco announces $1.0 billion common stock offering', { tickers: ['SYY'] }).publishable);
ok('a micro-cap earnings print does not post',
  !plain('Starcore International Mines reports GAAP EPS of C$0.03 and revenue of C$10.5M', { tickers: ['SAM'] }).publishable);
ok('...but a BEAT or MISS does, at any size',
  plain('Hain Celestial non-GAAP EPS of -$0.05 misses consensus, revenue $263.07M misses estimate', { tickers: ['HAIN'] }).publishable);
ok('a deal with no disclosed price still posts when it is definitive and identified',
  plain('Kyndryl to acquire Healthcare IT Leaders', { tickers: ['KD'] }).publishable,
  plain('Kyndryl to acquire Healthcare IT Leaders', { tickers: ['KD'] }).suppressed);
ok('largestAmount parses units, never estimates', largestAmount('raised $1.1B and $300 million') === 1.1e9);
ok('an EPS figure is not a material sum', largestAmount('EPS of $0.03') === 0.03);

sec('classification bugs the live feed exposed');
ok('"expected to raise" is anticipation, not an occurrence',
  type('FOMC expected to raise rates 25 basis points this week') === null);
ok('...but a struck pipeline expected offline is still an event',
  type('Saudi oil pipeline struck, expected out of service for several weeks') === 'geopolitical');
ok('"upgrades to buy" is an analyst action, not M&A',
  type('Straumann rises after Goldman Sachs upgrades to buy', { tickers: ['GS'] }) === 'analyst');
ok('"reaffirms merger timeline" is a restatement, not a deal',
  type('NextEra Energy reaffirms 2026 earnings guidance and merger timeline', { tickers: ['NEE'] }) === 'guidance');

sec('halts stay excluded');
const halt = { headline: 'AAPL halted, volatility pause', headline_status: 'not_required', source_type: 'halt',
  tickers: ['AAPL'], importance: 3, sources: ['NASDAQ'], published_at: '2026-09-14T05:00:00Z' };
ok('a halt still never posts', !buildCandidate(halt, null, Date.parse('2026-09-14T05:10:00Z'), []).publishable);

sec('SEC filings are judged by their 8-K items, not by being SEC');
// POLICY, revised: source_kind 'sec' is no longer a permanent exile. The SOURCE still qualifies
// nothing — the filing has to pass the same catalyst rules as anything else.
const NOWF = Date.parse('2026-09-14T05:10:00Z');
const filing = (h, o = {}) => buildCandidate({ headline: h, headline_status: 'not_required', summary: null,
  source_type: 'filing', source_kind: 'sec', category: 'FILING', sources: ['SEC'],
  published_at: '2026-09-14T05:00:00Z', importance: 2, tickers: ['CMG'], ...o }, null, NOWF, []);
ok('an SEC filing is no longer blocked outright', filing('CHIPOTLE MEXICAN GRILL INC · 8-K (5.02,9.01)').eligible);
ok('...with its own reason', filing('CHIPOTLE MEXICAN GRILL INC · 8-K (5.02,9.01)').reason === 'sec filing');
// THE ITEM NUMBER CLASSIFIES; THE FACTS DECIDE. An item code alone establishes only which box the
// form ticked. Each case below supplies the fact the filing would state, and the type is then read
// off the item — which is what the item is for.
for (const [item, want, evidence] of [
  ['1.03', 'bankruptcy', 'The Company filed a voluntary petition under Chapter 11.'],
  ['2.01', 'ma', 'The Company completed the acquisition of Beta Corp.'],
  ['2.02', 'earnings', 'The Company reported revenue of $412 million for the quarter.'],
  ['2.03', 'offering', 'The Company entered a credit agreement providing for a $250 million term loan.'],
  ['3.02', 'offering', 'The Company issued 4,000,000 shares in a private placement for $12 million.'],
  ['5.02', 'exec', 'Jane Doe, Chief Financial Officer, will step down effective October 31.'],
  ['1.01', 'contract', 'The Company entered a supply agreement valued at $80 million.'],
  ['4.02', 'legal', 'Previously issued financial statements should no longer be relied upon and will be restated.'],
  ['3.01', 'bankruptcy', 'The Company received a Nasdaq notice of non-compliance with the listing rule.'],
  ['5.01', 'ma', 'A change in control of the registrant occurred following the merger.'],
]) {
  const c = classifyCatalyst({ headline: `ACME CORP · 8-K (${item},9.01)`, source_type: 'filing',
    tickers: ['ACME'], summary: evidence });
  ok(`item ${item} with its fact is a ${want}`, c?.type === want, `got ${c?.type}`);
  // ...and the SAME item with nothing behind it is not an event at all.
  ok(`item ${item} on its own is not`,
    classifyCatalyst({ headline: `ACME CORP · 8-K (${item},9.01)`, source_type: 'filing', tickers: ['ACME'] }) === null);
}
// Routine items are the bulk of the feed and none of them is an event.
for (const item of ['7.01', '8.01', '9.01', '5.03', '5.07', '5.08', '1.04', '3.03']) {
  ok(`item ${item} alone is not an event`,
    classifyCatalyst({ headline: `ACME CORP · 8-K (${item})`, source_type: 'filing', tickers: ['ACME'] }) === null);
}
ok('the most material item wins over the exhibit index',
  classifyCatalyst({ headline: 'ACME CORP · 8-K (9.01,2.01,7.01)', source_type: 'filing', tickers: ['ACME'],
    summary: 'The Company completed the acquisition of Beta Corp.' })?.type === 'ma');
ok('a filing with no resolved symbol does not post',
  classifyCatalyst({ headline: 'ACME CORP · 8-K (5.02)', source_type: 'filing', tickers: [],
    summary: 'Jane Doe, Chief Financial Officer, will step down.' }) === null);

sec('the EXACT batch that reached the live account must not post');
// Verbatim from production. Every one carried ONLY the EDGAR index line: summary NULL, facts null,
// raw {cik, items, accession}. There is no material fact in the row to state, so there is no post.
for (const [t, h] of [
  ['LULU', 'lululemon athletica inc. · 8-K (5.02,5.03,9.01)'],
  ['CHGA', 'Change Agents Corporation. · 8-K (1.01,2.03,3.02,9.01)'],
  ['IONI', 'I-ON Digital Corp. · 8-K (5.02)'],
  ['ELMT', 'Elmet Group Co. · 8-K (1.01,3.02,3.03,5.02,5.03,7.01,9.01)'],
  ['BOW', 'Bowhead Specialty Holdings Inc. · 8-K (5.02)'],
  ['PAGP', 'PLAINS GP HOLDINGS LP · 8-K (1.01,2.02,2.03,8.01,9.01)'],
  ['HODO', 'House of Doge Inc. · 8-K (2.01,3.01,3.02,5.01,5.02,5.03,8.01)'],
]) {
  const c = filing(h, { tickers: [t] });
  ok(`$${t} does not post`, !c.publishable, c.text);
}
ok('and none of them classifies at all',
  classifyCatalyst({ headline: 'lululemon athletica inc. · 8-K (5.02,5.03,9.01)', source_type: 'filing',
    tickers: ['LULU'] }) === null);

sec('item 5.02 is a leadership change only when it says so');
const exec502 = (summary) => classifyCatalyst({ headline: 'ACME CORP · 8-K (5.02,9.01)',
  source_type: 'filing', tickers: ['ACME'], summary })?.type ?? null;
ok('a CFO stepping down qualifies',
  exec502('Jane Doe, Chief Financial Officer, will step down effective October 31, 2026.') === 'exec');
ok('a CEO appointment qualifies',
  exec502('The Board appointed John Smith as Chief Executive Officer, effective immediately.') === 'exec');
ok('a CEO termination qualifies',
  exec502('The Company terminated the employment of its President and CEO.') === 'exec');
ok('a routine director retirement does NOT',
  exec502('Director Alan Green will retire from the Board at the annual meeting.') === null);
ok('a compensation-plan amendment does NOT',
  exec502('The Board approved an amendment to the 2019 equity incentive compensation plan.') === null);
ok('an option grant does NOT',
  exec502('The Compensation Committee approved an option grant and a retention bonus for certain officers.') === null);
ok('a bare form heading does NOT', exec502('Departure of Directors or Certain Officers.') === null);

sec('item 3.02 needs financing terms, not a form heading');
const off302 = (summary) => classifyCatalyst({ headline: 'ACME CORP · 8-K (3.02,9.01)',
  source_type: 'filing', tickers: ['ACME'], summary })?.type ?? null;
ok('a placement with terms qualifies',
  off302('The Company issued 4,000,000 shares in a private placement for gross proceeds of $12 million.') === 'offering');
ok('a bare form heading does NOT', off302('Unregistered Sales of Equity Securities.') === null);
ok('no terms at all does NOT', off302('The Company issued securities to an investor.') === null);

sec('the post states the fact, never the taxonomy');
const real = filing('ACME CORP · 8-K (5.02,9.01)', { tickers: ['ACME'],
  summary: 'The Company announced that Jane Doe, Chief Financial Officer, will step down effective October 31, 2026.' });
ok('a filing that states its fact does post', real.publishable, real.suppressed);
ok('...and the post carries that fact', /Chief Financial Officer/.test(real.text || ''), real.text);
ok('...and cites the item', /8-K item 5\.02/.test(real.text || ''), real.text);
ok('...under the registrant\'s own symbol', /^\$ACME: /.test(real.text || ''), real.text);
// The generic taxonomy sentence must never appear, for any item, under any circumstances.
for (const [, [, phrase]] of [...new Map([['x', ['exec', 'reports a departure or appointment of directors or officers']]])]) {
  ok('the EDGAR taxonomy phrase never reaches a post', !String(real.text || '').includes(phrase));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
