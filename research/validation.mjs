// VALIDATION — designed before anything is fitted, which is the only order that works.
//
// ⚠️ RESEARCH ONLY. Never imported by src/.
//
// FOUR RULES, each of which exists because breaking it produces a result that looks good and is not:
//
//   TIME MOVES FORWARD. No random train/test split. A shuffled split lets the model learn from
//   March to predict February, and on market data that is not a subtle error — cross-sectional
//   returns are correlated enough that a random split can turn noise into a 60% hit rate.
//
//   THE TEST PERIOD IS TOUCHED ONCE. Tuning against it makes it a validation set with a
//   more flattering name. The split function therefore hands back a test range the search functions
//   here structurally cannot see.
//
//   THE OUTCOME WINDOW IS EMBARGOED. A 63-day label computed on the last day of training overlaps
//   the first 63 days of validation. Without a gap the two sets share the same future, which is
//   leakage wearing a walk-forward costume.
//
//   MANY TESTS MEAN MANY FALSE POSITIVES. Try two hundred combinations at p<0.05 and about ten will
//   look significant on noise alone. Every search reports how many hypotheses it tried, and the
//   threshold moves with it.
//
// Pure: arrays in, splits and statistics out.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const DAY = 86_400_000;

/**
 * Walk-forward splits: train, validate, then step forward and do it again.
 *
 * `embargoDays` MUST be at least the longest outcome horizon in the study, and the function refuses
 * to build a split that does not honour it. A 252-day label needs a 252-trading-day gap (~366
 * calendar days), which on a short history means fewer folds — the honest consequence of a long
 * horizon, rather than something to quietly skip.
 */
export function walkForwardSplits({
  startMs, endMs, trainDays = 365, validateDays = 90, stepDays = 90, embargoDays = 0,
} = {}) {
  if (!isNum(startMs) || !isNum(endMs) || endMs <= startMs) return [];
  if (!isNum(embargoDays) || embargoDays < 0) throw new Error('walkForwardSplits: embargoDays must be >= 0');
  const splits = [];
  let trainStart = startMs;
  for (;;) {
    const trainEnd = trainStart + trainDays * DAY;
    // THE EMBARGO. Nothing is sampled between the end of training and the start of validation,
    // because a label opened on the last training day is still resolving inside that gap.
    const valStart = trainEnd + embargoDays * DAY;
    const valEnd = valStart + validateDays * DAY;
    if (valEnd > endMs) break;
    splits.push({
      index: splits.length,
      train: { from: trainStart, to: trainEnd },
      embargo: { from: trainEnd, to: valStart, days: embargoDays },
      validate: { from: valStart, to: valEnd },
    });
    trainStart += stepDays * DAY;
  }
  return splits;
}

/**
 * Carve a final, untouched out-of-sample period off the end before any search begins.
 *
 * Returned as a separate object so a search function can be handed `searchable` and be structurally
 * incapable of reading `holdout`. A convention would not survive contact with a promising result.
 */
export function holdoutSplit({ startMs, endMs, holdoutDays = 180, embargoDays = 0 } = {}) {
  if (!isNum(startMs) || !isNum(endMs) || endMs <= startMs) return null;
  const holdoutStart = endMs - holdoutDays * DAY;
  const searchEnd = holdoutStart - embargoDays * DAY;
  if (searchEnd <= startMs) return null;
  return {
    searchable: { from: startMs, to: searchEnd },
    embargo: { from: searchEnd, to: holdoutStart, days: embargoDays },
    holdout: { from: holdoutStart, to: endMs },
  };
}

/** Rows whose observation date falls inside a range, half-open so no row lands in two folds. */
export const inRange = (rows, { from, to }, key = 'asOfMs') =>
  (rows || []).filter((r) => isNum(r?.[key]) && r[key] >= from && r[key] < to);

// ── statistics ────────────────────────────────────────────────────────────────

export function mean(xs) {
  const v = (xs || []).filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
export function median(xs) {
  const v = (xs || []).filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
export function stdev(xs) {
  const v = (xs || []).filter(isNum);
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
}
export function quantile(xs, p) {
  const v = (xs || []).filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))));
  return v[i];
}

/**
 * The distribution of an outcome, reported as a distribution.
 *
 * A mean alone hides the thing that matters: whether a positive average is a broad tendency or one
 * enormous winner among losers. `hitRate` and the quartiles are not decoration — they are how a
 * reader tells those apart.
 */
export function describe(xs) {
  const v = (xs || []).filter(isNum);
  if (!v.length) return { n: 0, mean: null, median: null, stdev: null, p10: null, p25: null, p75: null, p90: null, hitRate: null };
  return {
    n: v.length,
    mean: mean(v), median: median(v), stdev: stdev(v),
    p10: quantile(v, 0.10), p25: quantile(v, 0.25), p75: quantile(v, 0.75), p90: quantile(v, 0.90),
    hitRate: v.filter((x) => x > 0).length / v.length,
  };
}

/**
 * A t-statistic for "is this mean different from zero", with the caveats stated.
 *
 * ⚠️ IT ASSUMES INDEPENDENCE, AND OVERLAPPING-HORIZON OBSERVATIONS ARE NOT INDEPENDENT. Two hundred
 * tickers sampled on the same day share one market, and a 63-day label sampled weekly overlaps
 * itself twelve times over. Both inflate |t| substantially. Treat it as a filter for "obviously
 * nothing", never as evidence of significance — which is why `effectiveN` is reported beside it.
 */
export function tStatistic(xs, { overlapFactor = 1 } = {}) {
  const v = (xs || []).filter(isNum);
  if (v.length < 3) return null;
  const m = mean(v), s = stdev(v);
  if (s == null || s === 0) return null;
  const effectiveN = Math.max(2, v.length / Math.max(1, overlapFactor));
  return { t: m / (s / Math.sqrt(effectiveN)), n: v.length, effectiveN, mean: m, stdev: s, overlapFactor };
}

/**
 * How overlapping a sampling scheme is: a 63-day label sampled every 5 days overlaps ~12.6×.
 *
 * Used to deflate the effective sample size rather than to correct it properly — a Newey-West
 * adjustment would be better and is a later refinement, but pretending the overlap does not exist is
 * the error that matters.
 */
export const overlapFactorFor = (horizonDays, samplingIntervalDays) =>
  (isNum(horizonDays) && isNum(samplingIntervalDays) && samplingIntervalDays > 0
    ? Math.max(1, horizonDays / samplingIntervalDays) : 1);

/**
 * MULTIPLE-TESTING CONTROL. Try enough hypotheses and some will look significant on noise.
 *
 * Bonferroni is deliberately the blunt choice: it is conservative, it needs no assumptions about the
 * dependence between tests, and a research programme whose findings survive it is not going to be
 * embarrassed later. `hypothesesTried` must be the number ACTUALLY tried, including the ones
 * abandoned quietly — that count is the whole point.
 */
export function bonferroniThreshold(hypothesesTried, alpha = 0.05) {
  const k = Math.max(1, Math.floor(hypothesesTried) || 1);
  return { alpha, hypothesesTried: k, adjustedAlpha: alpha / k };
}

/**
 * BASELINES a model must beat to be worth anything.
 *
 * A complicated model that merely rediscovered momentum is not a discovery; it is momentum with
 * extra steps and more ways to break. Every baseline here is something we can already compute, so
 * "we beat it" is checkable rather than asserted.
 */
export const BASELINES = Object.freeze([
  { id: 'spy', label: 'SPY buy-and-hold', why: 'If a stock picker cannot beat the index, it is not a stock picker.' },
  { id: 'sector_etf', label: 'Sector ETF', why: 'Separates stock selection from a sector bet.' },
  { id: 'equal_weight_universe', label: 'Equal-weight eligible universe', why: 'Controls for the universe itself drifting up.' },
  { id: 'momentum_12_1', label: '12-1 month momentum', why: 'The best-documented cross-sectional anomaly; the most likely thing to be rediscovered by accident.' },
  { id: 'insider_buy_only', label: 'Open-market insider buying alone', why: 'One family, no model — does the combination add anything?' },
  { id: 'institution_accumulation_only', label: '13F accumulation alone', why: 'Same question, different family.' },
  { id: 'current_confluence', label: 'The shipped confluence score', why: 'A new model must beat what Pit Consensus already does.' },
]);

/**
 * A single fold's verdict, framed so it cannot be read as a promise.
 *
 * NOTE THE ABSENT FIELD: there is no "expected return". The framework reports what a sample DID,
 * with its dispersion and its sample size, and the language everywhere downstream has to match that.
 */
export function foldResult({ split, outcomes, baselineOutcomes = null, horizon, overlapFactor = 1 }) {
  const d = describe(outcomes);
  const b = baselineOutcomes ? describe(baselineOutcomes) : null;
  return {
    fold: split?.index ?? null,
    horizon,
    window: split?.validate ?? null,
    observed: d,
    baseline: b,
    edgeVsBaseline: (d.mean != null && b?.mean != null) ? d.mean - b.mean : null,
    t: tStatistic(outcomes, { overlapFactor }),
    // Small samples are reported as small rather than rounded up into a conclusion.
    underpowered: d.n < 30,
  };
}

/** Consistency across folds — one great fold and four poor ones is a regime, not an edge. */
export function stability(foldResults) {
  const means = (foldResults || []).map((f) => f?.observed?.mean).filter(isNum);
  if (means.length < 2) return { folds: means.length, consistent: null, positiveFolds: null, mean: mean(means) };
  return {
    folds: means.length,
    mean: mean(means),
    stdev: stdev(means),
    positiveFolds: means.filter((m) => m > 0).length,
    // Every fold pointing the same way matters more than any single fold's magnitude.
    consistent: means.every((m) => m > 0) || means.every((m) => m < 0),
  };
}
