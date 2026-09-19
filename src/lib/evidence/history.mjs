// HISTORICAL CONTEXT. PURE: no DB, no network, no AI.
//
// "A CEO bought $487K of stock" is a fact. "The first CEO open-market purchase in 842 days" is the
// same fact plus the thing a trader actually wants to know: IS THIS UNUSUAL FOR THIS COMPANY?
// That second sentence is most of the value in this product and all of its risk, because it is the
// one a reader cannot verify at a glance and will believe.
//
// ── THE RULE THAT GOVERNS THIS FILE ──────────────────────────────────────────
//
// NEVER CLAIM RARITY WE CANNOT PROVE. Three ways to get this wrong, all of them easy:
//
//   1. Calling something "first ever" when it is merely the first in the window we hold. If our
//      Form 4 history starts in 2023, a 2019 purchase is invisible to us — and a confident "first
//      ever" is then simply false.
//   2. Measuring a gap against a coverage boundary. If we hold three years and the last comparable
//      event is not in them, the honest statement is "first in our three-year history", NOT
//      "first in 1,095 days" — the second implies we looked at day 1,096 and found something.
//   3. Calling an ordinary gap unusual. Most companies go months without an insider purchase; a
//      90-day gap is not a story, and saying so on every ticker trains readers to ignore the line.
//
// So: every claim carries its coverage boundary, gaps below a floor produce NOTHING, and thin
// history produces NOTHING. An omitted line costs a little colour. A fabricated one costs the only
// thing this product sells.

const DAY = 24 * 3600e3;

/** Below this, a gap is normal and no claim is made. */
export const MIN_NOTABLE_GAP_DAYS = 180;
/** Below this much coverage, we do not characterise rarity at all. */
export const MIN_COVERAGE_DAYS = 365;
/** A burst needs at least this many events to be worth a sentence. */
export const MIN_CLUSTER_COUNT = 3;

const days = (ms) => ms / DAY;
const epoch = (v) => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Human coverage span. Deliberately coarse — "our 3-year Form 4 history" is honest and readable,
 * whereas "our 1,127-day history" implies a precision the boundary does not have.
 */
export function describeCoverage(spanMs) {
  const d = days(spanMs);
  if (d < MIN_COVERAGE_DAYS) return null;
  const years = Math.floor(d / 365);
  if (years >= 1) return `${years}-year`;
  return `${Math.floor(d / 30)}-month`;
}

/** Human gap. Days stay days while they are meaningful; beyond two years, months read better. */
// Days stay days out to three years. A precise day count is the most useful and most verifiable
// form — "first CEO open-market purchase in 842 days" is the brief's own example, and rounding it
// to "28 months" throws away the precision that makes the claim checkable.
export const GAP_DAYS_LIMIT = 1095;
export function describeGap(gapMs) {
  const d = Math.floor(days(gapMs));
  if (d < GAP_DAYS_LIMIT) return `${d.toLocaleString('en-US')} days`;
  return `${Math.floor(d / 365)} years`;
}

/**
 * "First <noun> in 842 days" / "First <noun> in our 3-year history" / null.
 *
 * `priorTimes` is every COMPARABLE earlier occurrence we hold — the caller decides what comparable
 * means (CEO open-market buys, congressional disclosures for this ticker) and that decision is what
 * makes the sentence true. `coverageStart` is the earliest moment our data for this family could
 * have contained such an event; without it no rarity claim is made at all, because a gap measured
 * against an unknown boundary is not a measurement.
 */
export function firstInContext({ priorTimes = [], coverageStart = null, now = Date.now(), noun = 'event' } = {}) {
  const cov = epoch(coverageStart);
  if (cov == null) return null;                       // unknown boundary → no claim
  const coverageSpan = now - cov;
  if (days(coverageSpan) < MIN_COVERAGE_DAYS) return null;   // too thin to characterise

  const prior = priorTimes.map(epoch).filter((t) => t != null && t <= now).sort((a, b) => b - a);

  if (!prior.length) {
    // Nothing comparable anywhere in what we hold. The claim is bounded BY OUR COVERAGE and says so.
    const span = describeCoverage(coverageSpan);
    return span ? { text: `First ${noun} in our ${span} history`, boundedByCoverage: true, gapDays: null } : null;
  }

  const gap = now - prior[0];
  if (days(gap) < MIN_NOTABLE_GAP_DAYS) return null;  // ordinary spacing, not a story

  // The previous occurrence is inside our window, so the gap is a real measurement.
  return { text: `First ${noun} in ${describeGap(gap)}`, boundedByCoverage: false, gapDays: Math.floor(days(gap)) };
}

/**
 * "3 open-market purchases in 14 days" / null.
 *
 * Counts occurrences inside a trailing window. Returns nothing below the cluster floor, so ordinary
 * single events never produce a line that implies a burst.
 */
export function burstContext({ times = [], windowDays = 30, now = Date.now(), noun = 'events' } = {}) {
  const cutoff = now - windowDays * DAY;
  const inWindow = times.map(epoch).filter((t) => t != null && t <= now && t >= cutoff);
  if (inWindow.length < MIN_CLUSTER_COUNT) return null;
  const spanDays = Math.max(1, Math.ceil(days(now - Math.min(...inWindow))));
  return { text: `${inWindow.length} ${noun} in ${spanDays} days`, count: inWindow.length, spanDays };
}

/**
 * "Largest disclosed purchase in our 3-year history" / "Largest in 2 years" / null.
 *
 * Same discipline as firstInContext: the claim is only made when the current value genuinely
 * exceeds everything we hold, and it names the boundary it was measured against.
 */
export function extremeContext({ value, priorValues = [], coverageStart = null, now = Date.now(), noun = 'purchase' } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const cov = epoch(coverageStart);
  if (cov == null) return null;
  const span = describeCoverage(now - cov);
  if (!span) return null;
  const priors = priorValues.filter((v) => typeof v === 'number' && Number.isFinite(v));
  // With nothing to compare against, "largest" is vacuous rather than impressive.
  if (priors.length < 2) return null;
  if (!priors.every((v) => value > v)) return null;
  return { text: `Largest ${noun} in our ${span} history`, boundedByCoverage: true };
}

/**
 * "Institutional breadth increased for 3 consecutive quarters" / null.
 *
 * `series` is oldest-first breadth counts. A run of two is noise; the floor keeps this from firing
 * on every mega-cap every quarter.
 */
export const MIN_STREAK_QUARTERS = 3;
export function streakContext({ series = [], noun = 'Institutional breadth' } = {}) {
  const s = series.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (s.length < MIN_STREAK_QUARTERS + 1) return null;
  let up = 0, down = 0;
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i] > s[i - 1]) { if (down) break; up++; }
    else if (s[i] < s[i - 1]) { if (up) break; down++; }
    else break;
  }
  if (up >= MIN_STREAK_QUARTERS) return { text: `${noun} increased for ${up} consecutive quarters`, direction: 'up', quarters: up };
  if (down >= MIN_STREAK_QUARTERS) return { text: `${noun} decreased for ${down} consecutive quarters`, direction: 'down', quarters: down };
  return null;
}

/**
 * Is a quarter-over-quarter breadth change too extreme to be real?
 *
 * ⚠️ MEASURED AGAINST LIVE DATA, NOT HYPOTHETICAL. Our Q1→Q2 2026 13F data contains CTRA at 912
 * managers falling to 6, and HON at 613 rising to 1,958. Neither is an event: a listed security
 * does not lose 99% of its institutional holders in a quarter, and a mega-cap does not triple its
 * holder base. They are CUSIP→ticker resolution shifts, where a quarter's positions landed under a
 * different symbol. Breadth alone cannot distinguish that from a genuine mass exit, and
 * "Manager breadth decreased from 912 to 6" is a fabricated finding stated with total confidence.
 *
 * THE TOLERANCE SCALES WITH THE HOLDER BASE, because stability does. A micro-cap moving from 14
 * managers to 26 is ordinary; a 600-holder name tripling is not. One flat ratio cannot express
 * both — loose enough for the micro-cap lets the HON artifact through.
 */
export const IMPLAUSIBLE_BREADTH_RATIO = 5;
export const LARGE_BASE_BREADTH = 300;
export const LARGE_BASE_MAX_RATIO = 2;

export function implausibleBreadth(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
  const hi = Math.max(from, to);
  const lo = Math.min(from, to);
  if (hi < 20) return false;                 // small bases move freely; nothing to claim either way
  if (lo <= 0) return true;                  // to or from zero on a real base is a mapping change
  const ratio = hi / lo;
  if (ratio > IMPLAUSIBLE_BREADTH_RATIO) return true;
  return hi >= LARGE_BASE_BREADTH && ratio > LARGE_BASE_MAX_RATIO;
}

/**
 * Is a quarter-over-quarter breadth change unusual FOR THIS TICKER?
 *
 * "116 funds added" is meaningless without knowing that this ticker's quarters normally move by
 * 8. Compared against the ticker's own historical absolute changes; when there is not enough
 * history to establish normal, returns the factual change with `unusual: false` and NO adjective —
 * which is exactly what section 6 of the brief asks for.
 */
export const BREADTH_UNUSUAL_SIGMA = 2;
export const MIN_BREADTH_HISTORY = 4;
export function breadthChangeContext({ from, to, priorChanges = [] } = {}) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const delta = to - from;
  if (delta === 0) return null;
  const verb = delta > 0 ? 'increased' : 'decreased';
  const factual = `Manager breadth ${verb} from ${from} to ${to}`;

  const hist = priorChanges.filter((n) => Number.isFinite(n)).map(Math.abs);
  if (hist.length < MIN_BREADTH_HISTORY) {
    // Not enough of the ticker's own history to call anything unusual. State the change, claim nothing.
    return { text: factual, delta, unusual: false, reason: 'insufficient_history' };
  }
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const variance = hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length;
  const sd = Math.sqrt(variance);
  // A flat history has sd 0; any change would then be "infinitely unusual", which is an artefact,
  // not a finding.
  const unusual = sd > 0 && Math.abs(delta) > mean + BREADTH_UNUSUAL_SIGMA * sd;
  // `factual` and `note` are kept APART so a caller can use the plain change as the headline and
  // the unusualness as the separate context line. Folding them into one string made the ticker page
  // print the identical sentence twice, once as the summary and once as its own context.
  return {
    text: factual,
    note: unusual ? 'Largest quarterly change in our history for this ticker' : null,
    delta, unusual, reason: unusual ? 'exceeds_own_history' : 'within_normal_range',
  };
}
