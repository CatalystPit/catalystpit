// Market Evidence Engine — core regression suite (pure layer).
//
// Covers the model, the integrity gates, the historical-context rules and the ordering. The DB-bound
// resolvers are exercised separately against real rows; everything here is deterministic and runs
// with no network.
//
// Run: node scripts/verify-evidence.mjs

import {
  makeEvidence, collectEvidence, integrityViolation, dedupeKey, freshness, changedSince,
  FAMILY, DIRECTION, METHODOLOGY_VERSION, FUTURE_TOLERANCE_MS,
} from '../src/lib/evidence/model.mjs';
import {
  firstInContext, burstContext, extremeContext, streakContext, breadthChangeContext,
  describeGap, describeCoverage, MIN_NOTABLE_GAP_DAYS, MIN_COVERAGE_DAYS, implausibleBreadth,
} from '../src/lib/evidence/history.mjs';
import { rankEvidence, groupForDisplay, weight } from '../src/lib/evidence/rank.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

const DAY = 24 * 3600e3;
const NOW = Date.parse('2026-09-19T15:00:00Z');
const ago = (d) => new Date(NOW - d * DAY).toISOString();

const base = {
  ticker: 'ACME', family: FAMILY.CATALYST, type: 'sec_8k_material_agreement',
  publicTime: ago(0.1), source: 'sec_8k', sourceId: '0001234567-26-000123',
  materiality: 0.75, quality: 0.95,
};
const ev = (over = {}) => makeEvidence({ ...base, ...over }, { now: NOW });

// ── 1. public_time semantics ─────────────────────────────────────────────────
sec('PUBLIC_TIME SEMANTICS');

check('a valid object is built', ev().ok);
check('methodology is stamped', ev().evidence.methodology === METHODOLOGY_VERSION);
check('publicTime is normalised to ISO', ev().evidence.publicTime === new Date(ago(0.1)).toISOString());
check('eventTime is optional', ev({ eventTime: null }).ok);
check('freshness is computed from publicTime',
  freshness(ev({ publicTime: ago(0.5) }).evidence, { now: NOW }) === 'today');
check('an old publicTime is stale regardless of a recent eventTime',
  freshness(ev({ publicTime: ago(120), eventTime: ago(121) }).evidence, { now: NOW }) === 'stale');

// THE POINT-IN-TIME INVARIANT.
check('event after public is a PIT violation',
  ev({ eventTime: ago(0), publicTime: ago(5) }).reason === 'pit');
check('event before public is correct and accepted',
  ev({ eventTime: ago(40), publicTime: ago(5) }).ok);

// ── 2. congress: disclosure, never transaction ───────────────────────────────
sec('CONGRESS — DISCLOSURE VS TRANSACTION DATE');

// A member trades on day -45 and discloses on day -2. The market knew on day -2.
const congress = ev({
  family: FAMILY.CONGRESS, type: 'congress_disclosure', source: 'congress',
  eventTime: ago(45), publicTime: ago(2), materiality: 0.55, quality: 0.6,
});
check('a congressional disclosure is accepted', congress.ok);
check('freshness uses the DISCLOSURE date, not the trade date',
  freshness(congress.evidence, { now: NOW }) === 'recent',
  freshness(congress.evidence, { now: NOW }));
check('the transaction date is retained separately',
  congress.evidence.eventTime === new Date(ago(45)).toISOString());
// The inverse — disclosure dated before the trade — is impossible and must be caught.
check('a disclosure predating its own trade is rejected',
  ev({ family: FAMILY.CONGRESS, type: 'congress_disclosure', eventTime: ago(2), publicTime: ago(45) }).reason === 'pit');

// ── 3. 13F: disclosure vs quarter end ────────────────────────────────────────
sec('13F — DISCLOSURE VS QUARTER END');

const f13 = ev({
  family: FAMILY.INSTITUTION, type: 'institution_breadth_change', source: 'sec_13f',
  eventTime: '2026-06-30T00:00:00Z', publicTime: '2026-08-14T00:00:00Z',
  referencePeriod: '2026Q2', materiality: 0.5, quality: 0.8,
});
check('a 13F object is accepted', f13.ok);
check('quarter end is retained as the reference period', f13.evidence.referencePeriod === '2026Q2');
check('quarter end is retained as eventTime', f13.evidence.eventTime === '2026-06-30T00:00:00.000Z');
check('13F freshness is measured from the FILING, not the quarter end',
  freshness(f13.evidence, { now: NOW }) === 'active', freshness(f13.evidence, { now: NOW }));

// ── 4. integrity: fail closed ────────────────────────────────────────────────
sec('INTEGRITY — FAIL CLOSED');

check('a future publicTime is rejected',
  ev({ publicTime: new Date(NOW + 2 * DAY).toISOString() }).reason === 'future');
check('clock skew inside tolerance is tolerated',
  ev({ publicTime: new Date(NOW + FUTURE_TOLERANCE_MS / 2).toISOString() }).ok);
check('the NONE ticker is rejected', ev({ ticker: 'NONE' }).reason === 'ticker');
check('an empty ticker is rejected', ev({ ticker: '' }).reason === 'ticker');
check('a placeholder ticker is rejected', ev({ ticker: 'N/A' }).reason === 'ticker');
check('a company name in the ticker field is rejected',
  ev({ ticker: 'LIBERTY MUTUAL HOLDING CO INC' }).reason === 'ticker');
check('an unparseable publicTime is rejected', ev({ publicTime: 'not-a-date' }).reason === 'public_time');
check('a missing publicTime is rejected', ev({ publicTime: null }).reason === 'public_time');
check('an unknown family is rejected', ev({ family: 'vibes' }).reason === 'family');
check('a missing type is rejected', ev({ type: null }).reason === 'type');
check('evidence with no provenance is rejected', ev({ source: null }).reason === 'provenance');
check('an out-of-range materiality is rejected', ev({ materiality: 1.4 }).reason === 'materiality');
check('an out-of-range quality is rejected', ev({ quality: -0.2 }).reason === 'quality');
check('an invalid direction is rejected', ev({ direction: 'up-ish' }).reason === 'direction');
check('a valid direction is accepted', ev({ direction: DIRECTION.POSITIVE }).ok);
check('integrityViolation on a non-object is malformed',
  integrityViolation(null)?.reason === 'malformed');

// ── 5. dedupe and cross-ticker contamination ─────────────────────────────────
sec('DEDUPE AND CONTAMINATION');

const sameFiling = [
  { ...base, summary: 'Acme signs supply agreement' },
  { ...base, summary: 'Acme signs supply agreement', url: 'https://sec.gov/x' },   // richer duplicate
];
const collected = collectEvidence(sameFiling, { now: NOW });
check('one filing arriving twice collapses to one row', collected.evidence.length === 1,
  String(collected.evidence.length));
check('the richer duplicate wins', collected.evidence[0].url === 'https://sec.gov/x');

// THE SAME accession under two tickers is two different facts, not a duplicate.
const twoTickers = collectEvidence([base, { ...base, ticker: 'BETA' }], { now: NOW });
check('the same source id under two tickers does not collapse', twoTickers.evidence.length === 2);
check('dedupe keys are ticker-scoped',
  dedupeKey({ ...base, ticker: 'ACME' }) !== dedupeKey({ ...base, ticker: 'BETA' }));
check('dedupe keys are family-scoped',
  dedupeKey({ ...base, family: 'insider' }) !== dedupeKey({ ...base, family: 'catalyst' }));
check('a canonical id collapses rows from different feeds',
  dedupeKey({ ...base, source: 'wire', sourceId: 'w1', canonicalId: 'C1' })
  === dedupeKey({ ...base, source: 'sec_8k', sourceId: 's1', canonicalId: 'C1' }));

const mixed = collectEvidence([base, { ...base, ticker: 'NONE' }, { ...base, publicTime: 'zzz' }], { now: NOW });
check('bad rows are quarantined, not silently dropped', mixed.quarantined.length === 2,
  JSON.stringify(mixed.quarantined.map((q) => q.reason)));
check('quarantine records the reason',
  mixed.quarantined.some((q) => q.reason === 'ticker') && mixed.quarantined.some((q) => q.reason === 'public_time'));
check('good rows survive alongside quarantined ones', mixed.evidence.length === 1);
check('collectEvidence on garbage returns empty, not a throw',
  collectEvidence(null, { now: NOW }).evidence.length === 0);

// ── 6. historical context ────────────────────────────────────────────────────
sec('HISTORICAL CONTEXT — ONLY WHAT WE CAN PROVE');

const cov3y = NOW - 3 * 365 * DAY;

check('a long gap produces a measured claim',
  firstInContext({ priorTimes: [NOW - 842 * DAY], coverageStart: cov3y, now: NOW, noun: 'CEO open-market purchase' })
    ?.text === 'First CEO open-market purchase in 842 days');
check('a measured claim is not coverage-bounded',
  firstInContext({ priorTimes: [NOW - 842 * DAY], coverageStart: cov3y, now: NOW })?.boundedByCoverage === false);

check('no prior occurrence names the COVERAGE boundary, never "ever"',
  firstInContext({ priorTimes: [], coverageStart: cov3y, now: NOW, noun: 'CEO open-market purchase' })
    ?.text === 'First CEO open-market purchase in our 3-year history');
check('a coverage-bounded claim never says "ever"',
  !/ever/i.test(firstInContext({ priorTimes: [], coverageStart: cov3y, now: NOW })?.text || ''));

check('an ordinary gap produces NO claim',
  firstInContext({ priorTimes: [NOW - 30 * DAY], coverageStart: cov3y, now: NOW }) === null);
check('a gap just below the floor produces no claim',
  firstInContext({ priorTimes: [NOW - (MIN_NOTABLE_GAP_DAYS - 1) * DAY], coverageStart: cov3y, now: NOW }) === null);
check('thin coverage produces NO rarity claim',
  firstInContext({ priorTimes: [], coverageStart: NOW - 100 * DAY, now: NOW }) === null);
// The coverage floor must hold INDEPENDENTLY of describeCoverage. With a prior occurrence present,
// the gap is measurable and the claim would otherwise be made against a boundary too close to it
// to mean anything: "first in 200 days" out of 250 days of data is not a finding.
check('thin coverage blocks the claim even when a gap IS measurable',
  firstInContext({ priorTimes: [NOW - 200 * DAY], coverageStart: NOW - 250 * DAY, now: NOW }) === null);
check('an unknown coverage boundary produces NO claim',
  firstInContext({ priorTimes: [], coverageStart: null, now: NOW }) === null);
check('future prior occurrences are ignored',
  firstInContext({ priorTimes: [NOW + 10 * DAY, NOW - 900 * DAY], coverageStart: cov3y, now: NOW })?.gapDays === 900);

check('describeCoverage refuses spans under the floor',
  describeCoverage((MIN_COVERAGE_DAYS - 1) * DAY) === null);
check('describeGap keeps the precise day count', describeGap(842 * DAY) === '842 days');
check('describeGap switches to years past the limit', describeGap(1500 * DAY) === '4 years');
check('describeGap thousands are readable', describeGap(1000 * DAY) === '1,000 days');

// Family-aware staleness: a 13F is not superseded until next quarter's filings land.
check('a 36-day-old 13F is still active, not stale',
  freshness({ family: FAMILY.INSTITUTION, publicTime: ago(36) }, { now: NOW }) === 'active');
check('a 36-day-old 8-K IS stale',
  freshness({ family: FAMILY.CATALYST, publicTime: ago(36) }, { now: NOW }) === 'stale');
check('a 120-day-old 13F is finally stale',
  freshness({ family: FAMILY.INSTITUTION, publicTime: ago(120) }, { now: NOW }) === 'stale');
check('a 40-day-old congressional disclosure is still active',
  freshness({ family: FAMILY.CONGRESS, publicTime: ago(40) }, { now: NOW }) === 'active');
check('a 3-day-old price reaction is stale',
  freshness({ family: FAMILY.MARKET, publicTime: ago(3) }, { now: NOW }) === 'stale');

check('a burst is reported',
  burstContext({ times: [NOW - 1 * DAY, NOW - 7 * DAY, NOW - 13 * DAY], windowDays: 30, now: NOW, noun: 'open-market purchases' })
    ?.text === '3 open-market purchases in 13 days');
check('two events are not a burst',
  burstContext({ times: [NOW - 1 * DAY, NOW - 7 * DAY], windowDays: 30, now: NOW }) === null);
check('events outside the window do not count',
  burstContext({ times: [NOW - 1 * DAY, NOW - 7 * DAY, NOW - 60 * DAY], windowDays: 30, now: NOW }) === null);

check('a genuine extreme is reported',
  extremeContext({ value: 487000, priorValues: [10000, 25000, 40000], coverageStart: cov3y, now: NOW })
    ?.text === 'Largest purchase in our 3-year history');
check('a non-extreme value produces nothing',
  extremeContext({ value: 5000, priorValues: [10000, 25000], coverageStart: cov3y, now: NOW }) === null);
check('too few priors makes "largest" vacuous and silent',
  extremeContext({ value: 999999, priorValues: [1], coverageStart: cov3y, now: NOW }) === null);

check('a rising streak is reported',
  streakContext({ series: [10, 20, 30, 40] })?.text === 'Institutional breadth increased for 3 consecutive quarters');
check('a falling streak is reported', streakContext({ series: [40, 30, 20, 10] })?.direction === 'down');
check('a two-quarter run is not a streak', streakContext({ series: [10, 5, 20, 30] }) === null);
check('too short a series produces nothing', streakContext({ series: [10, 20] }) === null);

// Section 6: "116 funds added" must not be automatically unusual.
check('a breadth change with thin history is stated, not characterised',
  breadthChangeContext({ from: 42, to: 57, priorChanges: [3] })?.unusual === false);
check('a breadth change with thin history reports why',
  breadthChangeContext({ from: 42, to: 57, priorChanges: [3] })?.reason === 'insufficient_history');
check('a breadth change with thin history states the fact',
  breadthChangeContext({ from: 42, to: 57, priorChanges: [3] })?.text === 'Manager breadth increased from 42 to 57');
check('a normal-sized change is not called unusual',
  breadthChangeContext({ from: 42, to: 45, priorChanges: [3, 4, 2, 5, 3] })?.unusual === false);
check('a genuinely outsized change is called unusual',
  breadthChangeContext({ from: 42, to: 116, priorChanges: [3, 4, 2, 5, 3] })?.unusual === true);
// The unusualness NOTE is a separate field from the factual text. Merged into one string, the
// ticker page printed the identical sentence twice — once as the summary, once as its own context.
check('an unusual change keeps its text plain',
  breadthChangeContext({ from: 42, to: 116, priorChanges: [3, 4, 2, 5, 3] })?.text
    === 'Manager breadth increased from 42 to 116');
check('the unusualness note is its own field',
  breadthChangeContext({ from: 42, to: 116, priorChanges: [3, 4, 2, 5, 3] })?.note
    === 'Largest quarterly change in our history for this ticker');
check('a normal change carries no note',
  breadthChangeContext({ from: 42, to: 45, priorChanges: [3, 4, 2, 5, 3] })?.note === null);
// A perfectly flat history has standard deviation zero, which makes "mean + 2σ" equal to the mean
// — so ANY change above it reads as infinitely unusual. That is an artefact of the arithmetic, not
// a finding, and the sd > 0 guard is the only thing preventing it. The delta here deliberately
// EXCEEDS the flat mean, which is the case that distinguishes the guard from its absence.
check('a flat history cannot manufacture unusualness',
  breadthChangeContext({ from: 42, to: 50, priorChanges: [3, 3, 3, 3] })?.unusual === false,
  JSON.stringify(breadthChangeContext({ from: 42, to: 50, priorChanges: [3, 3, 3, 3] })));
check('a flat history still reports the factual change',
  breadthChangeContext({ from: 42, to: 50, priorChanges: [3, 3, 3, 3] })?.text === 'Manager breadth increased from 42 to 50');
check('a zero change produces nothing', breadthChangeContext({ from: 42, to: 42, priorChanges: [1, 2, 3, 4] }) === null);

// Implausible breadth — every case below is LIVE DATA, not hypothetical.
check('CTRA 912 -> 6 is suppressed as an artifact', implausibleBreadth(912, 6) === true);
check('HON 613 -> 1958 is suppressed as an artifact', implausibleBreadth(613, 1958) === true);
check('a large base tripling is implausible', implausibleBreadth(400, 1300) === true);
check('MSFT 5996 -> 6017 is plausible', implausibleBreadth(5996, 6017) === false);
check('ALK 434 -> 478 is plausible', implausibleBreadth(434, 478) === false);
check('AGPU 14 -> 26 is plausible (small base moves freely)', implausibleBreadth(14, 26) === false);
check('ABAT 163 -> 174 is plausible', implausibleBreadth(163, 174) === false);
check('a real base collapsing to zero is an artifact', implausibleBreadth(500, 0) === true);
check('a tiny base is never called implausible', implausibleBreadth(2, 19) === false);
check('non-numeric breadth is treated as implausible', implausibleBreadth(null, 50) === true);

// ── 7. ordering ──────────────────────────────────────────────────────────────
sec('ORDERING');

const fresh8k = ev({ publicTime: ago(0.2), materiality: 0.75, quality: 0.95 }).evidence;
const old13f = ev({
  family: FAMILY.INSTITUTION, type: 'institution_breadth_change', source: 'sec_13f',
  sourceId: '13f-1', publicTime: ago(20), materiality: 0.5, quality: 0.8,
}).evidence;
const routine = ev({
  family: FAMILY.INSIDER, type: 'insider_routine_sell', source: 'sec_form4',
  sourceId: 'f4-1', publicTime: ago(0.3), materiality: 0.2, quality: 0.9,
}).evidence;
const ceoBuy = ev({
  family: FAMILY.INSIDER, type: 'insider_officer_buy', source: 'sec_form4',
  sourceId: 'f4-2', publicTime: ago(0.4), materiality: 0.8, quality: 0.95,
  context: { text: 'First CEO open-market purchase in 842 days', gapDays: 842 },
}).evidence;

const ordered = rankEvidence([old13f, routine, fresh8k, ceoBuy], { now: NOW });
check('a fresh material 8-K outranks an older 13F observation',
  ordered.indexOf(fresh8k) < ordered.indexOf(old13f));
check('an unusual CEO purchase outranks a routine 10b5-1 sale',
  ordered.indexOf(ceoBuy) < ordered.indexOf(routine));
check('the older 13F sorts last', ordered[ordered.length - 1] === old13f);
check('unusualness boosts weight', weight(ceoBuy) > weight({ ...ceoBuy, context: null }));
check('ordering is deterministic',
  JSON.stringify(rankEvidence([routine, ceoBuy, fresh8k, old13f], { now: NOW }).map((e) => e.evidenceId))
  === JSON.stringify(ordered.map((e) => e.evidenceId)));

const grouped = groupForDisplay([old13f, routine, fresh8k, ceoBuy], { now: NOW });
check('today and older are split', grouped.today.length === 3 && grouped.older.length === 1);
check('stale is returned rather than dropped', Array.isArray(grouped.stale));

// A context that merely restates the summary is dropped at construction.
check('a context echoing the summary is dropped',
  ev({ summary: 'Manager breadth increased from 14 to 26',
       context: { text: 'Manager breadth increased from 14 to 26' } }).evidence.context === null);
check('a context saying something new is kept',
  ev({ summary: 'Manager breadth increased from 14 to 26',
       context: { text: 'Largest quarterly change in our history for this ticker' } })
    .evidence.context?.text === 'Largest quarterly change in our history for this ticker');

// ── 8. changes since a watermark ─────────────────────────────────────────────
sec('CHANGES AFTER TIMESTAMP');

const all = [fresh8k, routine, ceoBuy, old13f];
check('only items published after the watermark are returned',
  changedSince(all, new Date(NOW - 1 * DAY).toISOString(), { now: NOW }).length === 3);
check('a watermark in the far past returns everything',
  changedSince(all, new Date(NOW - 400 * DAY).toISOString(), { now: NOW }).length === 4);
check('a watermark in the future returns nothing',
  changedSince(all, new Date(NOW + DAY).toISOString(), { now: NOW }).length === 0);
check('an unparseable watermark returns nothing rather than everything',
  changedSince(all, 'nonsense', { now: NOW }).length === 0);
check('a null watermark returns nothing', changedSince(all, null, { now: NOW }).length === 0);

// ── 9. missing data behaves safely ───────────────────────────────────────────
sec('MISSING DATA');

check('absent materiality does not throw', typeof weight({}) === 'number');
check('absent context does not throw', typeof weight({ materiality: 0.5, quality: 0.5 }) === 'number');
check('freshness of a malformed object is stale', freshness({}, { now: NOW }) === 'stale');
check('rankEvidence on null returns empty', rankEvidence(null, { now: NOW }).length === 0);
check('optional fields default to null rather than undefined',
  ev().evidence.subtype === null && ev().evidence.context === null && ev().evidence.url === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
