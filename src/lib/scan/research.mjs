// THE RESEARCH HARNESS.
//
// The purpose of this file is to make it possible to DELETE signals.
//
// Any scanner can invent a condition that sounds plausible. The question that matters — and the one
// almost no scanner answers — is whether a signal marks a moment that behaved differently from an
// arbitrary moment. Without a way to measure that, thresholds get tuned by taste, bad signals
// survive because they fire often, and the product slowly fills with noise that nobody can argue
// against.
//
// So every event the engine emits can be replayed against what happened next.
//
// WHAT THIS IS NOT: a promise that a signal predicts prices, and not something a customer ever sees.
// It is an internal instrument for removing triggers that do nothing.
//
// THE SAMPLE DISCIPLINE IS THE POINT. Measuring a signal on the same data used to choose its
// thresholds tells you what you already assumed. `splitSample` exists so that never happens by
// accident, and every summary carries the sample it was computed on.

/** The horizons an intraday signal is judged over. Minutes, because that is the decision horizon. */
export const HORIZONS = [1, 2, 5, 10, 15, 30, 60];

const n = (v) => (Number.isFinite(v) ? v : null);

/**
 * What happened after one event.
 *
 * `bars` must extend past the event, oldest → newest. Everything is measured from the price AT the
 * event, so a signal cannot be flattered by entering at a better price than it fired at.
 */
export function outcomeFor(event, bars, { horizons = HORIZONS, direction = null } = {}) {
  if (!event || !Array.isArray(bars) || !bars.length) return null;
  const at = event.at;
  const entryIdx = bars.findIndex((b) => b.t >= at);
  if (entryIdx < 0) return null;
  const entry = n(bars[entryIdx].c);
  if (entry == null || entry <= 0) return null;

  // Direction matters: a short signal that falls 2% has done well, and scoring it as −2% would make
  // every bearish signal look broken.
  const side = direction || event.direction || 'up';
  const sign = side === 'down' ? -1 : 1;

  const forward = {};
  for (const h of horizons) {
    const target = at + h * 60_000;
    let exit = null;
    for (let i = entryIdx; i < bars.length; i += 1) {
      if (bars[i].t <= target) exit = bars[i];
      else break;
    }
    // A horizon the data does not reach is NULL, never zero. Treating a missing hour as a flat hour
    // is the quiet way a sample gets biased toward "no effect".
    const reached = exit && exit.t >= target - 60_000;
    forward[`m${h}`] = reached ? sign * ((exit.c - entry) / entry) * 100 : null;
  }

  // MFE and MAE over the longest horizon we actually reached — how much it went your way before it
  // went against you, which is what decides whether a signal is tradeable rather than merely correct.
  const horizonEnd = at + Math.max(...horizons) * 60_000;
  let best = entry;
  let worst = entry;
  for (let i = entryIdx; i < bars.length && bars[i].t <= horizonEnd; i += 1) {
    const hi = n(bars[i].h);
    const lo = n(bars[i].l);
    if (hi != null) { if (sign > 0 ? hi > best : hi > worst) { if (sign > 0) best = hi; else worst = hi; } }
    if (lo != null) { if (sign > 0 ? lo < worst : lo < best) { if (sign > 0) worst = lo; else best = lo; } }
  }
  const mfe = sign * ((best - entry) / entry) * 100;
  const mae = sign * ((worst - entry) / entry) * 100;

  return {
    eventId: event.id,
    symbol: event.symbol,
    signalId: event.signalId,
    at,
    entry,
    direction: side,
    forward,
    mfe: Math.abs(mfe),
    mae: -Math.abs(mae),
    // The plainest verdicts, so a summary can count them without re-deriving the rule each time.
    continued: forward.m15 != null ? forward.m15 > 0 : null,
    failed: forward.m15 != null ? forward.m15 < 0 : null,
  };
}

/** The median, because one halted symbol should not decide whether a signal works. */
export function median(values) {
  const xs = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Summarise a set of outcomes for one signal.
 *
 * Reports the MEDIAN forward return rather than the mean, and the hit rate beside it, because a mean
 * on a handful of outliers is exactly how a useless signal gets defended.
 */
export function summarize(outcomes, { horizons = HORIZONS, minSample = 30 } = {}) {
  const list = (outcomes || []).filter(Boolean);
  const byHorizon = {};
  for (const h of horizons) {
    const key = `m${h}`;
    const vals = list.map((o) => o.forward[key]).filter(Number.isFinite);
    byHorizon[key] = {
      n: vals.length,
      median: median(vals),
      hitRate: vals.length ? vals.filter((v) => v > 0).length / vals.length : null,
    };
  }
  return {
    n: list.length,
    // BELOW THIS, NOTHING IS CONCLUDED. A signal with eleven observations has no measured behaviour,
    // and reporting a number for it invites exactly the false confidence this file exists to prevent.
    sufficient: list.length >= minSample,
    minSample,
    byHorizon,
    medianMfe: median(list.map((o) => o.mfe)),
    medianMae: median(list.map((o) => o.mae)),
    continuationRate: rate(list, (o) => o.continued),
    failureRate: rate(list, (o) => o.failed),
  };
}

function rate(list, pick) {
  const vals = list.map(pick).filter((v) => v === true || v === false);
  return vals.length ? vals.filter(Boolean).length / vals.length : null;
}

/**
 * Split a sample in two BY TIME, not at random.
 *
 * Random splits leak: the same session appears on both sides, and market regime is shared, so a
 * threshold tuned on one half is already fitted to the other. A chronological split is the weakest
 * honest form of out-of-sample testing, and walk-forward below is the stronger one.
 */
export function splitSample(outcomes, { trainFraction = 0.6 } = {}) {
  const sorted = (outcomes || []).filter(Boolean).slice().sort((a, b) => a.at - b.at);
  const cut = Math.floor(sorted.length * trainFraction);
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

/**
 * Walk-forward folds: tune on each window, measure on the one after it, never the other way round.
 *
 * Returned as index ranges rather than data so a caller can apply it to whatever it is evaluating.
 */
export function walkForward(outcomes, { folds = 4 } = {}) {
  const sorted = (outcomes || []).filter(Boolean).slice().sort((a, b) => a.at - b.at);
  if (sorted.length < folds * 2) return [];
  const size = Math.floor(sorted.length / (folds + 1));
  const out = [];
  for (let i = 0; i < folds; i += 1) {
    out.push({
      fold: i,
      train: sorted.slice(0, size * (i + 1)),
      test: sorted.slice(size * (i + 1), size * (i + 2)),
    });
  }
  return out;
}

/**
 * Segment outcomes so a signal that only works in one regime is not reported as working generally.
 *
 * A breakout signal that is strong pre-market and worthless at 15:00 is two different findings, and
 * averaging them hides both.
 */
export function segment(outcomes, keyFn) {
  const out = new Map();
  for (const o of outcomes || []) {
    if (!o) continue;
    const k = keyFn(o);
    if (k == null) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(o);
  }
  return out;
}

/** The standard segmentations, so studies are comparable to each other. */
export const SEGMENTS = {
  session: (o, phaseOf) => phaseOf(o.at),
  capBand: (o) => {
    const c = o.marketCap;
    if (!Number.isFinite(c)) return null;
    if (c < 3e8) return 'micro';
    if (c < 2e9) return 'small';
    if (c < 1e10) return 'mid';
    return 'large';
  },
  priceBand: (o) => {
    const p = o.entry;
    if (!Number.isFinite(p)) return null;
    if (p < 2) return 'sub-2';
    if (p < 10) return '2-10';
    if (p < 50) return '10-50';
    return '50+';
  },
  withCatalyst: (o) => (o.hadCatalyst ? 'catalyst' : 'no-catalyst'),
};

/**
 * Compare a signal's outcomes against a baseline drawn from the same sessions.
 *
 * THE ONLY QUESTION WORTH ASKING: did this moment behave differently from an arbitrary moment? A
 * signal whose median forward return matches the baseline is not detecting anything, however
 * satisfying its name is — and this is the number that justifies deleting it.
 */
export function liftOver(signalOutcomes, baselineOutcomes, { horizon = 15 } = {}) {
  const key = `m${horizon}`;
  const sig = median((signalOutcomes || []).map((o) => o?.forward?.[key]).filter(Number.isFinite));
  const base = median((baselineOutcomes || []).map((o) => o?.forward?.[key]).filter(Number.isFinite));
  if (sig == null || base == null) return null;
  return { horizon, signal: sig, baseline: base, lift: sig - base, n: (signalOutcomes || []).length };
}
