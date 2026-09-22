// PIT CONSENSUS — FAMILY FACTS AND PRESENTATION.
//
// Qualification, the evidence/market join and research priority moved to
// verify-consensus-v35.mjs when V3.5 made labels an OUTPUT of those layers rather than the gate
// on them. What remains here is the part that did not change: the sentences a card shows come
// from canonical fields, both clocks survive, nothing is fabricated, and the presentation stays
// non-predictive.
//
// V2.1 was defensible arithmetic that made a poor product: it printed the shape of a vote.
// V3 answers "why is this worth investigating right now?" — and the risk of that question is that
// it invites invention. A setup engine can very easily drift into a magic score, a prediction, a
// padded board, or a card that states facts the record never carried.
//
// So these assertions guard the discipline, not the output: no score, no forecast, no forced setup,
// no fabricated fact, no look-ahead, and no second opinion about what evidence means.
//
// Run: node scripts/verify-consensus-setup.mjs [--mutate=<mode>]

import {
  SETUP, SETUP_LABEL, SETUP_VERSION, setupDirection, isActive,
  freshCatalysts, unusualEvidence, nonInstitutional, recentDisclosure,
  orderSetups, SETUP_FILTERS, filterSetups, hasLean, isContested,
} from '../src/lib/consensus/setup.mjs';
import { evidenceFacts, familyFactSheet, shortDate, publicAgo, usd } from '../src/lib/consensus/facts.mjs';
import { levelFacts, marketNarrative, MEANINGFUL_MOVE_PCT } from '../src/lib/consensus/market-facts.js';
import { CONSENSUS_STATE, MARKET } from '../src/lib/consensus/synthesis.mjs';
import { FAMILY } from '../src/lib/evidence/model.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const NOW = Date.parse('2026-09-20T12:00:00Z');
const DAY = 86_400_000;
const ago = (d) => new Date(NOW - d * DAY).toISOString();

// ── FIXTURES, shaped exactly like production records (see the capability census) ─────────────
const catalyst = (daysAgo, material = true, extra = {}) => ({
  evidenceId: `c${daysAgo}`, family: FAMILY.CATALYST, type: 'sec_8k_material_agreement',
  direction: 'unknown', materiality: 0.75, quality: 0.95,
  publicTime: ago(daysAgo), eventTime: ago(daysAgo + 1),
  summary: 'Material agreement', source: 'sec_8k',
  url: 'https://www.sec.gov/Archives/edgar/data/1/x.htm',
  facts: { items: ['1.01', '9.01'], material }, ...extra,
});
const insiderBuy = (daysAgo, extra = {}) => ({
  evidenceId: `i${daysAgo}`, family: FAMILY.INSIDER, type: 'insider_officer_buy',
  direction: 'positive', materiality: 0.8, quality: 0.95, publicTime: ago(daysAgo),
  summary: 'CEO AND PRESIDENT open-market purchase of $1.0M', source: 'sec_form4',
  url: 'https://www.sec.gov/Archives/edgar/data/2/y.htm',
  facts: { buyers: 1, transactions: 1, totalValue: 1001510, totalValueLabel: '$1.0M',
    officer: true, executive: 'MINICUCCI BENITO', title: 'CEO AND PRESIDENT' }, ...extra,
});
const congress = (daysAgo, extra = {}) => ({
  evidenceId: `g${daysAgo}`, family: FAMILY.CONGRESS, type: 'congress_disclosure',
  direction: 'positive', materiality: 0.55, quality: 0.6,
  publicTime: ago(daysAgo), eventTime: ago(daysAgo + 31),
  summary: 'Ro Khanna disclosed a buy', source: 'congress',
  url: 'https://disclosures-clerk.house.gov/x.pdf',
  facts: { members: 1, transactions: 1, representative: 'Ro Khanna', chamber: 'house',
    party: 'Democrat', state: 'CA', amountRange: '$1,001 - $15,000',
    transactionDate: '2026-08-07', disclosureDate: '2026-09-07', disclosureLagDays: 31 }, ...extra,
});
const institution = (daysAgo, extra = {}) => ({
  evidenceId: `n${daysAgo}`, family: FAMILY.INSTITUTION, type: 'institution_breadth_change',
  direction: 'positive', materiality: 0.45, quality: 0.8,
  publicTime: ago(daysAgo), eventTime: '2026-06-30T00:00:00.000Z', referencePeriod: 'Q2 2026',
  summary: 'Institutions holding this stock increased from 433 to 448', source: 'sec_13f', url: null,
  facts: { quarter: 'Q2 2026', quarterEnd: '2026-06-30', breadthFrom: 433, breadthTo: 448,
    delta: 15, unusual: false, basis: 'insufficient_history', disclosedAt: '2026-08-06' }, ...extra,
});

const fam = (family, label) => ({ family, label });
const canon = (state, { market = MARKET.MIXED, drivers = [], opposition = [], confidence = 'Medium', active = 2 } = {}) => ({
  state, confidence, market: { confirmation: market },
  coverage: { active, total: 4 }, drivers, opposition, version: 'consensus_v2_synthesis',
});

L('\n=== FRESHNESS IS MEASURED ON PUBLIC TIME ===');
{
  ok('a filing public today is fresh', freshCatalysts([catalyst(0)], { now: NOW }).length === 1);
  ok('a filing public 6 days ago is fresh', freshCatalysts([catalyst(6)], { now: NOW }).length === 1);
  ok('a filing public 9 days ago is NOT fresh',
    mut('stalefresh') ? false : freshCatalysts([catalyst(9)], { now: NOW }).length === 0);
  ok('a non-material filing is never a fresh catalyst',
    freshCatalysts([catalyst(1, false)], { now: NOW }).length === 0);

  // ⚠️ THE LOOK-AHEAD GUARD. A congressional trade on Aug 7 disclosed Sep 7 must be dated from the
  // DISCLOSURE. Using the transaction date would claim the market knew a month early.
  const c = congress(0);                       // disclosed today, traded 31 days ago
  const facts = evidenceFacts(c, { now: NOW });
  ok('congress freshness comes from disclosure, not the transaction',
    mut('txtime') ? false : facts.publicAgo.includes('m ago') || facts.publicAgo.includes('h ago'),
    facts.publicAgo);
  ok('…and the transaction date is still preserved and shown',
    /Traded Aug 7/.test(facts.dates), facts.dates);
  ok('…with the lag stated explicitly', /31 days later/.test(facts.dates), facts.dates);

  // 13F: quarter end is NOT the public clock.
  const n = evidenceFacts(institution(0), { now: NOW });
  ok('13F quarter end is preserved separately from disclosure',
    /Quarter ended Jun 30/.test(n.dates) && /disclosed Aug 6/.test(n.dates), n.dates);
  ok('…and the quarter end is never used as the public time',
    mut('quarterclock') ? false : !n.publicAgo.includes('82'), n.publicAgo);
}

L('\n=== FAMILY FACTS COME FROM CANONICAL FIELDS ONLY ===');
{
  const i = evidenceFacts(insiderBuy(2), { now: NOW });
  ok('the headline is the engine\'s own sentence',
    i.headline === 'CEO AND PRESIDENT open-market purchase of $1.0M');
  ok('the insider title and name are shown', i.lines.some((l) => /CEO AND PRESIDENT/.test(l)));
  ok('verification uses the stored URL', i.url.startsWith('https://www.sec.gov/'));

  const n = evidenceFacts(institution(45), { now: NOW });
  ok('institutions show the manager delta', n.lines.some((l) => /15 more institutions reported holding it/.test(l)), n.lines.join(' | '));
  ok('…and never fabricate a link when none exists',
    mut('fakeurl') ? false : n.url === null);

  const g = evidenceFacts(congress(2), { now: NOW });
  ok('congress shows party, state and chamber', g.lines.some((l) => /Democrat/.test(l) && /House/.test(l)));
  ok('…and the disclosed amount range', g.lines.includes('$1,001 - $15,000'));

  const c = evidenceFacts(catalyst(1), { now: NOW });
  ok('catalysts cite the 8-K item codes for verification',
    c.lines.some((l) => /8-K item 1\.01/.test(l)), c.lines.join(' | '));
  ok('a catalyst with no context claims none', c.context === null);

  // NOTHING IS EVER RENDERED AS "undefined".
  const sparse = { evidenceId: 'x', family: FAMILY.INSIDER, type: 'insider_buy', direction: 'positive',
    publicTime: ago(1), summary: null, source: 'sec_form4', facts: {} };
  const s = evidenceFacts(sparse, { now: NOW });
  ok('a sparse record produces no undefined text',
    !JSON.stringify(s).includes('undefined') && !JSON.stringify(s).includes('NaN'));
  ok('…and simply omits the lines it cannot fill', s.lines.length === 0);

  // Missing is not neutral: a family with nothing to say is ABSENT from the sheet.
  const sheet = familyFactSheet([insiderBuy(2)], { now: NOW });
  ok('a family with no evidence is absent, not neutral',
    mut('neutralfill') ? false : !(FAMILY.CONGRESS in sheet) && FAMILY.INSIDER in sheet,
    Object.keys(sheet).join(','));
}

L('\n=== FORMATTERS ARE SAFE ON BAD INPUT ===');
{
  ok('a null date formats to null', shortDate(null) === null);
  ok('a junk date formats to null', shortDate('not-a-date') === null);
  ok('a bare date formats from its parts', shortDate('2026-06-30') === 'Jun 30');
  ok('publicAgo on junk returns null', publicAgo('nope') === null);
  ok('usd rejects non-finite values', usd(NaN) === null && usd(0) === null);
  ok('usd formats millions', usd(2638405) === '$2.6M');
}

L('\n=== MARKET FACTS: MEASURED, NEVER FABRICATED ===');
{
  const bars = Array.from({ length: 260 }, (_, i) => ({
    date: `2026-01-01`, close: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1,
  }));
  const lv = levelFacts(bars);
  ok('levels are computed from daily bars', Number.isFinite(lv.close) && Number.isFinite(lv.prevClose));
  ok('the session count is reported as the denominator', lv.sessions === 260);
  ok('too little history yields no levels', levelFacts([{ date: 'x', close: 1 }]) === null);
  ok('20-day levels need 20 sessions',
    levelFacts(bars.slice(-10))?.high20 == null);

  const nar = marketNarrative({
    reaction: { abs: -3.1, rel: -2.4, five: -6.0, meaningful: true, floorPct: 2 },
    levels: lv, verdict: 'DIVERGING', join: { state: 'PRICE_DIVERGING' }, driverLabel: 'the filing',
  });
  ok('the move since the filing is stated with a number',
    nar.lines.some((l) => /-3\.1% in the session after it became public/.test(l)), nar.lines.join(' | '));
  ok('…and the benchmark-relative move too', nar.lines.some((l) => /vs SPY/.test(l)));
  ok('"diverging" now explains itself',
    nar.explain === 'Price is moving against the filing', nar.explain);
  // ⚠️ AND A MOVE INSIDE THE DEAD ZONE SAYS SO, rather than being narrated as a verdict.
  const quiet = marketNarrative({
    reaction: { abs: 0.8, rel: 1.2, five: null, meaningful: false, floorPct: 2 },
    levels: lv, join: { state: 'EVIDENCE_BUILDING' },
  });
  ok('a sub-threshold move is reported but not called a reaction',
    quiet.lines.some((l) => /Below the 2.0% threshold/.test(l)), quiet.lines.join(' | '));
  ok('…and the explanation says there was no meaningful response',
    /No meaningful price response/.test(quiet.explain), quiet.explain);

  // ⚠️ INCOMPLETE WINDOWS ARE ABSENT, never reported under a longer label.
  const partial = marketNarrative({ reaction: { abs: null, rel: null, five: null, meaningful: false, reason: 'not-measured' }, levels: null, verdict: 'MIXED' });
  ok('a null horizon produces no line',
    mut('partialwindow') ? false : partial.lines.length === 0, partial.lines.join(' | '));

  // NOTHING WE CANNOT MEASURE.
  // Only the emitted LINES matter. The basis sentence deliberately names VWAP in order to say it is
  // unavailable, so scanning the whole function body would flag the disclaimer itself.
  const emitted = [...nar.lines, nar.explain].join(' ');
  for (const banned of ['vwap', 'rvol', 'relative volume', 'premarket', 'opening range']) {
    ok(`no rendered line claims ${banned}`,
      mut('fakestructure') ? false : !new RegExp(banned, 'i').test(emitted));
  }
  ok('the computation never derives a volume ratio',
    !/volume/i.test(levelFacts.toString()));
  ok('the basis line states these are end-of-day facts',
    /End-of-day/.test(nar.basis) && /omitted rather than estimated/.test(nar.basis));
  ok('a meaningful-move floor exists so noise is not narrated',
    MEANINGFUL_MOVE_PCT > 0);
}

L('\n=== V2.1 IS PRESERVED, NOT REPLACED ===');
{
  ok('all eight V2.1 states still exist', Object.keys(CONSENSUS_STATE).length === 8);
  ok('direction is derived FROM the V2.1 state',
    setupDirection(canon(CONSENSUS_STATE.POSITIVE_ALIGNMENT)) === 'POSITIVE'
    && setupDirection(canon(CONSENSUS_STATE.NEGATIVE_LEAN_WITH_CONFLICT)) === 'NEGATIVE'
    && setupDirection(canon(CONSENSUS_STATE.BALANCED_CONFLICT)) === 'MIXED');
  ok('lean detection reuses the V2.1 vocabulary',
    hasLean(CONSENSUS_STATE.POSITIVE_ALIGNMENT) && !hasLean(CONSENSUS_STATE.MIXED));
  ok('contested detection reuses it too',
    isContested(CONSENSUS_STATE.BALANCED_CONFLICT) && !isContested(CONSENSUS_STATE.POSITIVE_ALIGNMENT));
  ok('the facts layer never recomputes family states',
    !/familyLean|evidenceContributions|consensusState/.test(evidenceFacts.toString()));
}

L('\n=== ORDERING IS DETERMINISTIC AND NOT PREDICTIVE ===');
{
  const row = (ticker, setup, ageMs, confidence = 'Medium') =>
    ({ ticker, setup: { setup, whyNowAgeMs: ageMs, unusualCount: 0 }, canonical: { confidence, coverage: { active: 2 } } });
  const list = [
    row('CCC', SETUP.EVIDENCE_BUILDING, 5 * DAY),
    row('AAA', SETUP.FRESH_CATALYST_CONTESTED, 1 * DAY),
    row('BBB', SETUP.PRICE_DIVERGENCE, 2 * DAY),
    row('DDD', SETUP.FRESH_CATALYST_CONTESTED, 1 * DAY),
  ];
  const out = orderSetups(list).map((r) => r.ticker);
  ok('the most specific fresh archetype sorts first', out[0] === 'AAA', out.join(','));
  ok('a tie falls back to the ticker, so ordering is stable', out.slice(0, 2).join(',') === 'AAA,DDD');
  ok('ordering is pure', orderSetups(list).map((r) => r.ticker).join(',') === out.join(','));
  ok('ordering reads no price or return field',
    !/\.(changePct|price|close|return|perf)/.test(orderSetups.toString() + JSON.stringify(list[0])));
  ok('ordering exposes no visible score', !/score/i.test(orderSetups.toString()));
}

L('\n=== FILTERS MAP TO REAL ARCHETYPES ===');
{
  const rows = [
    { ticker: 'A', setup: { setup: SETUP.PRICE_DIVERGENCE, direction: 'POSITIVE' } },
    { ticker: 'B', setup: { setup: SETUP.CROSS_SOURCE_CONFLICT, direction: 'MIXED' } },
    { ticker: 'C', setup: { setup: SETUP.UNUSUAL_INSIDER_ACTIVITY, direction: 'NEGATIVE' } },
  ];
  ok('all returns everything', filterSetups(rows, 'all').length === 3);
  ok('a setup filter selects its archetype', filterSetups(rows, 'divergence')[0].ticker === 'A');
  // Direction filters were replaced by EVIDENCE filters: the board is organised by what the public
  // records say, not by a lean. Market reaction survives as a SECONDARY filter.
  ok('a secondary market filter selects on the market state',
    filterSetups([{ ticker: 'M', setup: { setup: SETUP.EVIDENCE_BUILDING, marketState: 'DIVERGING' } }],
      'diverging').length === 1);
  ok('no primary filter is named after price',
    !SETUP_FILTERS.filter((f) => f.setups).some((f) => /price/i.test(f.label)));
  ok('every filter names archetypes that exist',
    SETUP_FILTERS.every((f) => !f.setups || f.setups.every((s) => s in SETUP)));
  // ⚠️ NOT A RECOMMENDATION SURFACE.
  ok('no filter is phrased as a pick or a rating',
    !/best|top|pick|buy|sell|strongest|winner/i.test(SETUP_FILTERS.map((f) => f.label).join(' ')));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
