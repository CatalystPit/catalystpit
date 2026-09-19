// THE RESEARCH HARNESS: point-in-time correctness, outcome labels, and validation discipline.
//
// ⚠️ Tests research/ only. Nothing here touches production scoring — Pit Consensus still uses the
// shipped confluence formula and this suite does not assert anything about it.
//
// THE ONE THING WORTH TESTING MOST. Every other property here is ordinary arithmetic; the
// point-in-time rule is the one whose violation produces a RESULT RATHER THAN AN ERROR. A model that
// reads the future does not crash — it reports a wonderful hit rate and is worthless. So the guard
// is structural (an observation cannot exist without an information timestamp), and these assertions
// are what stop the structure being weakened later.
//
// Run: node scripts/verify-research.mjs

import {
  FAMILY, FAMILIES, KIND, QUALITY, observation, PIT_RULES, asOfFilter, ageDays, recencyWeight,
  CORRELATION_GROUPS, correlationGroupOf, byFamily, independentSupport,
  SHORT_INTEREST_PUBLICATION_LAG_DAYS,
} from '../research/evidence.mjs';
import {
  HORIZONS, forwardBars, priceOn, horizonOutcome, excessReturn, outcomesFor, assertNoLookAhead,
} from '../research/outcomes.mjs';
import {
  walkForwardSplits, holdoutSplit, inRange, describe, tStatistic, overlapFactorFor,
  bonferroniThreshold, BASELINES, foldResult, stability, median, quantile,
} from '../research/validation.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const threw = (fn) => { try { fn(); return false; } catch { return true; } };
const D = (s) => Date.parse(`${s}T00:00:00Z`);

console.log('\n=== an observation cannot exist without knowing WHEN we knew it ===');
{
  const good = () => observation({
    ticker: 'aapl', family: FAMILY.INSIDERS, type: 'open_market_buy',
    informationAt: D('2026-03-05'), source: 'form4',
  });
  ok('a well-formed observation is built', good().ticker === 'AAPL');
  // THE GUARD. There is deliberately no fallback to an event date.
  ok('no information timestamp is refused', threw(() => observation({
    ticker: 'A', family: FAMILY.INSIDERS, type: 't', source: 'form4' })));
  ok('a non-numeric timestamp is refused', threw(() => observation({
    ticker: 'A', family: FAMILY.INSIDERS, type: 't', source: 'form4', informationAt: '2026-03-05' })));
  ok('an unknown family is refused', threw(() => observation({
    ticker: 'A', family: 'vibes', type: 't', source: 's', informationAt: 1 })));
  ok('no source is refused', threw(() => observation({
    ticker: 'A', family: FAMILY.INSIDERS, type: 't', informationAt: 1 })));
  ok('a nonsense direction is refused', threw(() => observation({
    ticker: 'A', family: FAMILY.INSIDERS, type: 't', source: 's', informationAt: 1, direction: 2 })));

  // MISSING STAYS MISSING. No default, no zero, no neutral fill.
  const sparse = good();
  ok('an unsupplied value is null, never 0', sparse.value === null && sparse.normalized === null);
  ok('an unsupplied magnitude is null', sparse.magnitude === null);
  ok('observations are frozen', threw(() => { 'use strict'; sparse.value = 1; }) || sparse.value === null);
}

console.log('\n=== the point-in-time rules name the right column, per source ===');
{
  // FORM 4: the transaction is when they traded; the FILING is when anyone else could know.
  ok('a Form 4 is dated by its filing, not its transaction',
    PIT_RULES.insiderTrade({ transaction_date: '2026-03-01', filing_date: '2026-03-03' }) === D('2026-03-03'));
  // CONGRESS: median lag 28 days on our own data, p90 116, max 1,932. This is the big one.
  ok('a congressional trade is dated by its DISCLOSURE',
    PIT_RULES.congressTrade({ transaction_date: '2026-01-05', disclosure_date: '2026-03-20' }) === D('2026-03-20'));
  // 13F: a quarter-end snapshot, knowable only when filed ~38 days later.
  ok('a 13F holding is dated by the filing, not the quarter',
    PIT_RULES.fundHolding({ quarter: '2026-06-30', filed_date: '2026-08-07' }) === D('2026-08-07'));
  ok('an 8-K is dated by filed_at', PIT_RULES.eightK({ filed_at: '2026-03-03T14:30:00Z' }) === Date.parse('2026-03-03T14:30:00Z'));

  // PIT WIRE: we cannot act on a story before we receive it, and a backfill can carry a publisher
  // timestamp from long before our ingestion.
  ok('a wire event takes the LATER of publication and first sight',
    PIT_RULES.wireEvent({ published_at: '2026-03-01T10:00:00Z', first_seen_at: '2026-03-04T09:00:00Z' })
      === Date.parse('2026-03-04T09:00:00Z'));
  ok('...and publication alone when that is all we have',
    PIT_RULES.wireEvent({ published_at: '2026-03-01T10:00:00Z' }) === Date.parse('2026-03-01T10:00:00Z'));

  // SHORT INTEREST: the settlement date is NOT the publication date; FINRA publishes ~8 business
  // days later, and we do not store the real one.
  ok('short interest is offset past its settlement date',
    PIT_RULES.shortInterest({ settlement_date: '2026-03-15' })
      === D('2026-03-15') + SHORT_INTEREST_PUBLICATION_LAG_DAYS * 86_400_000);

  // A date we cannot establish yields null, and null means UNUSABLE — never a guessed timestamp.
  ok('a missing filing date is null, not the transaction date',
    PIT_RULES.insiderTrade({ transaction_date: '2026-03-01' }) === null);
  ok('a missing disclosure date is null', PIT_RULES.congressTrade({ transaction_date: '2026-01-05' }) === null);
}

console.log('\n=== selecting evidence for a research date ===');
{
  const at = (ms, type = 't') => observation({ ticker: 'X', family: FAMILY.INSIDERS, type, source: 's', informationAt: ms });
  const obs = [at(D('2026-01-01')), at(D('2026-02-01')), at(D('2026-03-01'))];
  const asOf = D('2026-02-15');
  ok('only evidence from before the decision is selected', asOfFilter(obs, asOf).length === 2);
  // STRICTLY BEFORE. Same-instant evidence is a coin flip on ordering, and in research a coin flip
  // that favours the model is indistinguishable from cheating.
  ok('evidence stamped at the decision instant is excluded',
    asOfFilter([at(D('2026-02-15'))], D('2026-02-15')).length === 0);
  ok('an as-of date is mandatory', threw(() => asOfFilter(obs)));
  ok('age is measured in days', Math.round(ageDays(at(D('2026-02-01')), D('2026-02-15'))) === 14);
}

console.log('\n=== state persists, change decays ===');
{
  const asOf = D('2026-03-01');
  const state = observation({ ticker: 'X', family: FAMILY.FUNDAMENTALS, type: 'margin', kind: KIND.STATE,
    source: 's', informationAt: D('2025-09-01') });
  const change = observation({ ticker: 'X', family: FAMILY.ESTIMATES, type: 'eps_revision', kind: KIND.CHANGE,
    source: 's', informationAt: D('2026-02-15') });
  // A company is not less profitable because the filing is old.
  ok('STATE does not decay with age', recencyWeight(state, asOf) === 1);
  // A six-month-old upgrade is not news.
  const fresh = recencyWeight(change, asOf, { halfLifeDays: 30 });
  const stale = recencyWeight({ ...change, informationAt: D('2025-09-01') }, asOf, { halfLifeDays: 30 });
  ok('CHANGE decays', fresh > stale && fresh <= 1 && stale > 0);
  ok('...at the stated half-life', Math.abs(recencyWeight(
    { kind: KIND.CHANGE, informationAt: asOf - 30 * 86_400_000 }, asOf, { halfLifeDays: 30 }) - 0.5) < 1e-9);
  ok('both kinds exist as a first-class dimension', KIND.STATE !== KIND.CHANGE && FAMILIES.length === 14);
}

console.log('\n=== correlated evidence is declared, so it cannot be triple-counted ===');
{
  ok('the analyst reaction is one group',
    correlationGroupOf('analyst.rating_change') === 'analyst_reaction'
    && correlationGroupOf('estimates.pt_revision') === 'analyst_reaction');
  ok('the price path is one group',
    correlationGroupOf('momentum.return') === 'price_path'
    && correlationGroupOf('relative_strength.vs_spy') === 'price_path');
  ok('an unlisted key stands alone', correlationGroupOf('fundamentals.margin') === null);
  ok('every group states why it is a group', CORRELATION_GROUPS.every((g) => g.why && g.members.length >= 2));

  // THE POINT: three columns describing one analyst note count ONCE.
  const note = [
    observation({ ticker: 'X', family: FAMILY.ANALYST, type: 'rating_change', source: 's', informationAt: 1 }),
    observation({ ticker: 'X', family: FAMILY.ESTIMATES, type: 'pt_revision', source: 's', informationAt: 1 }),
    observation({ ticker: 'X', family: FAMILY.ESTIMATES, type: 'eps_revision', source: 's', informationAt: 1 }),
  ];
  const s = independentSupport(note);
  ok('three views of one note are one independent source', s.distinctSources === 1, JSON.stringify(s));
  ok('...even though they span two families', s.families === 2);

  // Genuinely separate families count separately.
  const varied = [
    note[0],
    observation({ ticker: 'X', family: FAMILY.FUNDAMENTALS, type: 'margin', source: 's', informationAt: 1 }),
    observation({ ticker: 'X', family: FAMILY.SHORT_INTEREST, type: 'change', source: 's', informationAt: 1 }),
  ];
  ok('independent evidence counts independently', independentSupport(varied).distinctSources === 3);
  ok('a family with nothing is ABSENT, not empty', !byFamily(varied).has(FAMILY.OPTIONS));
}

console.log('\n=== forward outcomes: the path, not just the endpoint ===');
{
  // A clean +10% over 5 sessions.
  const up = [];
  for (let i = 0; i < 40; i++) {
    const p = 100 + i;
    up.push({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, open: p, high: p + 0.5, low: p - 0.5, close: p });
  }
  const asOfDay = '2026-03-10';
  ok('the entry is the last bar AT OR BEFORE the decision', priceOn(up, asOfDay) === 109);
  // The observation date's own bar belongs to neither features nor outcomes.
  ok('forward bars start strictly after the decision', forwardBars(up, asOfDay)[0].date === '2026-03-11');

  const o = horizonOutcome(up, asOfDay, 5);
  ok('a 5-day outcome is computed', o && o.bars === 5);
  ok('...with the right return', Math.abs(o.returnPct - ((114 - 109) / 109) * 100) < 1e-9);
  ok('...and reports the favourable excursion', o.maxFavorablePct >= o.returnPct);
  ok('...and the adverse one', o.maxAdversePct <= 0);

  // AN INCOMPLETE WINDOW IS NULL. A 252-day label from 180 days is a survivorship-flavoured guess.
  ok('an incomplete horizon is null, not a short one', horizonOutcome(up, asOfDay, 252) === null);
  ok('a decision after all data is null', horizonOutcome(up, '2026-12-01', 5) === null);

  // THE PATH MATTERS. A gain that first drew down 30% is not the same event as a smooth one.
  // The second bar touches +15% AND −32% within one session: intraday order is unknowable from a
  // daily bar, so it must NOT be resolved into whichever barrier flatters the study.
  const whipsaw = [
    { date: '2026-03-01', high: 100, low: 100, close: 100 },
    { date: '2026-03-02', high: 115, low: 68, close: 70 },
    { date: '2026-03-03', high: 116, low: 70, close: 112 },
  ];
  const w = horizonOutcome(whipsaw, '2026-03-01', 2, { upPct: 10, downPct: 10 });
  ok('a violent path is visible in the excursions', w.maxAdversePct < -25 && w.maxFavorablePct > 10);
  ok('...and in the drawdown', w.maxDrawdownPct < -25);
  // A bar that touches BOTH barriers cannot be resolved in our favour.
  ok('a bar touching both barriers is ambiguous, not a win', w.firstTouch === 'ambiguous');

  // Relative, not just absolute: +10% when the market did +12% is underperformance.
  ok('excess return subtracts the benchmark', excessReturn(10, 12) === -2);
  ok('a missing benchmark is null excess, not zero', excessReturn(10, null) === null);

  const full = outcomesFor(up, asOfDay, { benchmarkBars: up, horizons: [5] });
  ok('an identical benchmark yields zero excess', Math.abs(full[5].excessVsBenchmarkPct) < 1e-9);
  ok('an absent sector benchmark stays null', full[5].excessVsSectorPct === null);
  ok('the horizon set is the documented one', HORIZONS.join() === '5,20,63,126,252');
}

console.log('\n=== the leak check fails loudly ===');
{
  const asOf = D('2026-03-01');
  const clean = [observation({ ticker: 'X', family: FAMILY.INSIDERS, type: 't', source: 's', informationAt: D('2026-02-20') })];
  const dirty = [...clean, observation({ ticker: 'X', family: FAMILY.INSIDERS, type: 't', source: 's', informationAt: D('2026-03-02') })];
  ok('clean features pass', assertNoLookAhead(clean, asOf) === true);
  // Leakage does not announce itself — it announces a great result. So it throws.
  ok('a future-dated feature THROWS', threw(() => assertNoLookAhead(dirty, asOf)));
  ok('...and same-instant evidence throws too',
    threw(() => assertNoLookAhead([observation({ ticker: 'X', family: FAMILY.INSIDERS, type: 't', source: 's', informationAt: asOf })], asOf)));
}

console.log('\n=== walk-forward, with an embargo ===');
{
  const start = D('2024-01-01'), end = D('2026-09-01');
  const splits = walkForwardSplits({ startMs: start, endMs: end, trainDays: 365, validateDays: 90, stepDays: 90, embargoDays: 90 });
  ok('folds are produced', splits.length >= 2, String(splits.length));
  ok('time only moves forward', splits.every((s) => s.train.to <= s.validate.from));
  // THE EMBARGO: a 63-day label opened on the last training day is still resolving into validation.
  ok('training never abuts validation', splits.every((s) => s.validate.from - s.train.to === 90 * 86_400_000));
  ok('folds step forward', splits.length < 2 || splits[1].train.from > splits[0].train.from);
  ok('no fold runs past the data', splits.every((s) => s.validate.to <= end));
  ok('a negative embargo is refused', threw(() => walkForwardSplits({ startMs: start, endMs: end, embargoDays: -1 })));

  // THE FINAL HOLDOUT IS STRUCTURALLY SEPARATE, not separated by convention.
  const h = holdoutSplit({ startMs: start, endMs: end, holdoutDays: 180, embargoDays: 90 });
  ok('a holdout is carved off the end', h && h.holdout.to === end);
  ok('...and the searchable range cannot reach it', h.searchable.to < h.holdout.from);
  ok('...with an embargo between them', h.embargo.days === 90 && h.embargo.to === h.holdout.from);

  const rows = [{ asOfMs: D('2024-06-01') }, { asOfMs: D('2025-06-01') }, { asOfMs: D('2026-06-01') }];
  ok('rows are selected half-open', inRange(rows, { from: D('2024-01-01'), to: D('2025-01-01') }).length === 1);
}

console.log('\n=== statistics that refuse to overclaim ===');
{
  const d = describe([1, 2, 3, 4, 100]);
  ok('a distribution is described, not just averaged', d.n === 5 && d.median === 3 && d.mean === 22);
  // The whole point: one enormous winner among mediocrity has a great mean and a revealing median.
  ok('the median exposes what the mean hides', d.mean > d.median * 5);
  ok('the hit rate is reported', d.hitRate === 1);
  ok('an empty sample is n=0 with nulls, not zeros', describe([]).n === 0 && describe([]).mean === null);
  ok('nulls are excluded rather than counted as zero', describe([1, null, 3, undefined]).n === 2);

  // OVERLAPPING LABELS ARE NOT INDEPENDENT, and the t-stat says so.
  const of = overlapFactorFor(63, 5);
  ok('a 63-day label sampled every 5 days overlaps ~12.6x', Math.abs(of - 12.6) < 0.01);
  const plain = tStatistic([1, 2, 3, 2, 1, 2, 3, 2]);
  const deflated = tStatistic([1, 2, 3, 2, 1, 2, 3, 2], { overlapFactor: of });
  ok('overlap deflates the effective sample', deflated.effectiveN < plain.effectiveN);
  ok('...and therefore the t-statistic', Math.abs(deflated.t) < Math.abs(plain.t));
  ok('the overlap factor is reported, not hidden', deflated.overlapFactor === of);
  ok('too small a sample yields no t at all', tStatistic([1, 2]) === null);

  // MANY TESTS, MANY FALSE POSITIVES.
  const b = bonferroniThreshold(200, 0.05);
  ok('the threshold tightens with the number of hypotheses', b.adjustedAlpha === 0.05 / 200);
  ok('...and the count is carried with it', b.hypothesesTried === 200);
  ok('a single test is unadjusted', bonferroniThreshold(1).adjustedAlpha === 0.05);
}

console.log('\n=== folds, baselines and stability ===');
{
  const split = { index: 0, validate: { from: 1, to: 2 } };
  const f = foldResult({ split, outcomes: [1, 2, 3], baselineOutcomes: [0.5, 0.5, 0.5], horizon: 20 });
  ok('a fold reports its edge over the baseline', Math.abs(f.edgeVsBaseline - 1.5) < 1e-9);
  // A ten-observation "edge" is reported as underpowered rather than as a finding.
  ok('a small sample is flagged underpowered', f.underpowered === true);
  ok('a fold without a baseline has null edge',
    foldResult({ split, outcomes: [1, 2, 3], horizon: 20 }).edgeVsBaseline === null);

  // THE ABSENT FIELD MATTERS: there is no expected return anywhere in the result.
  ok('no fold result promises a future return',
    !Object.keys(f).some((k) => /expected|forecast|predict/i.test(k)));

  // One great fold among four poor ones is a regime, not an edge.
  ok('inconsistent folds are marked inconsistent',
    stability([{ observed: { mean: 5 } }, { observed: { mean: -1 } }, { observed: { mean: -2 } }]).consistent === false);
  ok('consistent folds are marked consistent',
    stability([{ observed: { mean: 1 } }, { observed: { mean: 2 } }]).consistent === true);
  ok('...and the positive count is reported',
    stability([{ observed: { mean: 1 } }, { observed: { mean: -2 } }]).positiveFolds === 1);

  // A model must beat what we already ship, not merely beat nothing.
  ok('the shipped score is itself a baseline', BASELINES.some((b) => b.id === 'current_confluence'));
  ok('momentum is a baseline, since it is the thing most likely rediscovered',
    BASELINES.some((b) => b.id === 'momentum_12_1'));
  ok('every baseline says why it is there', BASELINES.every((b) => b.why && b.label));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
