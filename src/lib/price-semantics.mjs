// CANONICAL PRICE SEMANTICS. PURE: no DB, no network.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// `ticker_daily_candles.close` meant two different things. Rows written from Tiingo carried the
// TOTAL-RETURN adjusted close; rows written from Polygon carried the SPLIT-ADJUSTED close. Where a
// ticker held both, the series changed meaning mid-stream and inserted a price move that never
// happened — measured at 9.88% on KO, 8.89% on JNJ, 8.19% on PG, and smaller elsewhere, on 16
// tickers across 18 boundaries.
//
// Nothing detected it. The continuity scan looks for sustained 4x level shifts (a reused symbol, an
// unapplied reverse split) and an adjustment seam of a few percent is far beneath it. The schema
// comment asserted the whole table was Tiingo-adjusted, which was true of 4% of the rows.
//
// The lesson is not "pick the other vendor". It is that ONE FIELD MUST MEAN ONE THING, and that a
// price series has to carry which thing it means.
//
// ── THE THREE CONVENTIONS ───────────────────────────────────────────────────
//
// RAW — what printed on the tape that day. A 2:1 split shows as a 50% fall; a dividend shows as an
//   ex-date drop. Correct for "what did this trade at on that date", wrong for any comparison
//   across a corporate action.
//
// SPLIT_ADJUSTED — share-count changes removed, cash distributions left in. A split is invisible;
//   an ex-dividend date still shows its drop, because that drop is a real fall in the share price
//   that a holder experienced. This is what a price chart shows and what technicians measure.
//
// TOTAL_RETURN — splits AND distributions removed, as though every dividend were reinvested. The
//   series answers "what did an investor earn", not "what did the share cost". Historical levels do
//   not match what anyone ever paid: PG's 2023 close reads 140.52 on this basis against the 153.09
//   that actually printed.
//
// ── WHICH ONE EACH USE CASE NEEDS, AND WHY ──────────────────────────────────
//
// The tempting shortcut is to use TOTAL_RETURN everywhere because it is continuous. That is exactly
// the mistake this file exists to prevent. Continuity is not correctness:
//
//   CHART DISPLAY        SPLIT_ADJUSTED. A trader comparing our chart against any other chart, or
//                        against their own broker, must see the same levels. A total-return series
//                        silently disagrees with every other chart in the world, by more the
//                        further back you look and by most on exactly the high-dividend names
//                        income investors care about.
//
//   TECHNICAL ANALYSIS   SPLIT_ADJUSTED. Support and resistance are memories of where people
//   SUPPORT/RESISTANCE   transacted. A level at $153 is a level because trades happened at $153.
//                        Re-basing it to $140 because dividends were paid since does not move where
//                        the market actually turned — it moves our number away from it. Moving
//                        averages, swing pivots and zones therefore all read the same series the
//                        chart shows, which is also the only way our stated levels can be checked
//                        against the chart by eye.
//
//   MARKET REACTION      SPLIT_ADJUSTED, deliberately, with a caveat recorded here. A total-return
//                        basis would be defensible — it is the investor's actual outcome — but a
//                        1-day reaction that quietly includes an ex-dividend drop of 0.6% is
//                        reporting something the reader cannot see on the chart beside it. Ex-date
//                        moves are real price moves and belong in a "what did the stock do" number.
//                        The honest treatment is to keep the basis consistent with the chart and,
//                        where an ex-date falls inside a reaction window, say so rather than
//                        silently removing it.
//
//   RETURN RESEARCH      TOTAL_RETURN, when the question is what an investor earned. Long-horizon
//                        comparisons across high- and low-yield securities are distorted on a
//                        split-adjusted basis, because the high-yield name's price series is
//                        structurally penalised by every distribution it makes.
//
//   VOLUME               Volume must be adjusted on the SAME basis as price or the two disagree
//                        about how many shares a bar represents. Split-adjusted price with raw
//                        volume misstates dollar volume across every split.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//
// A series carries its convention. A consumer declares the convention it requires. Comparing two
// prices from different conventions is a bug, and `assertSameConvention` exists so it fails loudly
// rather than producing a plausible wrong number.

export const CONVENTION = Object.freeze({
  RAW: 'raw',
  SPLIT_ADJUSTED: 'split_adjusted',
  TOTAL_RETURN: 'total_return',
  /** The series did not record what it is. Treat as unusable for any cross-date comparison. */
  UNKNOWN: 'unknown',
});

export const CONVENTION_LABEL = Object.freeze({
  raw: 'as traded (unadjusted)',
  split_adjusted: 'split-adjusted',
  total_return: 'total return (splits and distributions)',
  unknown: 'unrecorded',
});

/**
 * What each use case requires. A consumer looks itself up rather than deciding case by case, so a
 * new surface cannot quietly adopt a different basis from the chart beside it.
 */
export const REQUIRED_CONVENTION = Object.freeze({
  chart_display: CONVENTION.SPLIT_ADJUSTED,
  technical_analysis: CONVENTION.SPLIT_ADJUSTED,
  support_resistance: CONVENTION.SPLIT_ADJUSTED,
  moving_averages: CONVENTION.SPLIT_ADJUSTED,
  market_reaction: CONVENTION.SPLIT_ADJUSTED,
  trend_classification: CONVENTION.SPLIT_ADJUSTED,
  screener_performance: CONVENTION.SPLIT_ADJUSTED,
  return_research: CONVENTION.TOTAL_RETURN,
  investor_outcome: CONVENTION.TOTAL_RETURN,
  last_traded_price: CONVENTION.RAW,
});

/** Which vendor field supplies each convention. Recorded so an ingester cannot guess. */
export const VENDOR_FIELDS = Object.freeze({
  tiingo: Object.freeze({
    [CONVENTION.RAW]: { open: 'open', high: 'high', low: 'low', close: 'close', volume: 'volume' },
    // Tiingo's adj* series removes splits AND dividends — it is total return, not split-adjusted,
    // which is precisely the confusion that produced the seam.
    [CONVENTION.TOTAL_RETURN]: { open: 'adjOpen', high: 'adjHigh', low: 'adjLow', close: 'adjClose', volume: 'adjVolume' },
    // Tiingo exposes splitFactor, so a split-only series is DERIVABLE from raw — see
    // splitAdjustSeries() below. It is not served directly.
    [CONVENTION.SPLIT_ADJUSTED]: null,
  }),
  polygon: Object.freeze({
    // Polygon's `adjusted=true` removes splits only. This is the convention 96% of our rows are on.
    [CONVENTION.SPLIT_ADJUSTED]: { open: 'o', high: 'h', low: 'l', close: 'c', volume: 'v' },
    [CONVENTION.RAW]: null,
    [CONVENTION.TOTAL_RETURN]: null,
  }),
});

export class ConventionMismatch extends Error {
  constructor(a, b, context) {
    super(`price convention mismatch${context ? ` in ${context}` : ''}: ${a} vs ${b}`);
    this.name = 'ConventionMismatch';
    this.a = a; this.b = b;
  }
}

/** Throws rather than returning a plausible wrong number. */
export function assertSameConvention(a, b, context = '') {
  if (a !== b || a === CONVENTION.UNKNOWN) throw new ConventionMismatch(a, b, context);
  return true;
}

/** Is this series fit for the job? Returns a reason rather than a boolean, for the UI. */
export function conventionFitness(seriesConvention, useCase) {
  const need = REQUIRED_CONVENTION[useCase];
  if (!need) return { ok: false, reason: `unknown use case '${useCase}'` };
  if (seriesConvention === CONVENTION.UNKNOWN) {
    return { ok: false, reason: 'the series does not record its adjustment convention' };
  }
  if (seriesConvention !== need) {
    return {
      ok: false,
      reason: `${useCase} requires ${CONVENTION_LABEL[need]}, series is ${CONVENTION_LABEL[seriesConvention]}`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Derive a SPLIT_ADJUSTED series from raw bars plus split factors.
 *
 * Walks backwards accumulating the split factor, so the most recent bars are unchanged and history
 * is divided down — the same orientation every vendor and chart uses, and the one that keeps
 * today's number equal to today's tape.
 *
 * Volume is multiplied by the same factor, because a 2:1 split doubles the share count: leaving
 * volume raw while dividing price would misstate dollar volume by exactly the split.
 */
export function splitAdjustSeries(bars) {
  const src = Array.isArray(bars) ? bars : [];
  if (!src.length) return [];
  const out = new Array(src.length);
  let factor = 1;
  for (let i = src.length - 1; i >= 0; i--) {
    const b = src[i];
    out[i] = {
      ...b,
      open: b.open / factor, high: b.high / factor, low: b.low / factor, close: b.close / factor,
      volume: b.volume == null ? b.volume : b.volume * factor,
      convention: CONVENTION.SPLIT_ADJUSTED,
    };
    // The factor applies to everything BEFORE this bar, so it is accumulated after writing.
    const sf = Number(b.splitFactor);
    if (Number.isFinite(sf) && sf > 0 && sf !== 1) factor *= sf;
  }
  return out;
}

/**
 * Detect an ADJUSTMENT SEAM: a one-bar move that the security did not make.
 *
 * ⚠️ DELIBERATELY NOT the existing break detector. price-continuity.mjs looks for a SUSTAINED LEVEL
 * SHIFT of 4x — a reused symbol, an unapplied reverse split. An adjustment seam is one to ten
 * percent and leaves the level otherwise intact, so it passes that test untouched: 0 of the 18 real
 * seams were flagged by it.
 *
 * The signal here is different. A convention change is a SINGLE-BAR step with no follow-through:
 * the gap appears, and the bars after it behave exactly as the bars before did. A genuine gap —
 * earnings, a guidance cut, an ex-dividend date — is accompanied by a change in behaviour, or is
 * explained by a known corporate action.
 *
 * Returns candidates, never a verdict. An ex-dividend drop looks identical to a small seam by
 * construction, so `knownExDates` is how a caller excludes them; without it the honest output is a
 * candidate list for a human or a vendor cross-check, which is what the audit script does.
 */
export const SEAM_MIN_PCT = 0.8;
export const SEAM_SIGMA = 4;
/** How many bars after the step are inspected for follow-through. */
export const SEAM_FOLLOW_BARS = 5;

export function findAdjustmentSeams(bars, { knownExDates = null, minPct = SEAM_MIN_PCT, sigma = SEAM_SIGMA } = {}) {
  const b = Array.isArray(bars) ? bars.filter((x) => Number.isFinite(x.close)) : [];
  if (b.length < 30) return [];
  const moves = [];
  for (let i = 1; i < b.length; i++) {
    const prev = b[i - 1].close;
    moves.push(prev > 0 ? Math.abs((b[i].close - prev) / prev) * 100 : 0);
  }
  const sorted = [...moves].sort((x, y) => x - y);
  const median = sorted[sorted.length >> 1] || 0.5;

  const out = [];
  for (let i = 1; i < b.length; i++) {
    const gapPct = ((b[i].close - b[i - 1].close) / b[i - 1].close) * 100;
    const mag = Math.abs(gapPct);
    if (mag < minPct || mag < sigma * median) continue;
    // An ex-dividend drop is a real price move, not corruption.
    if (knownExDates && knownExDates.has(String(b[i].date).slice(0, 10))) continue;
    // NO FOLLOW-THROUGH is what separates a convention change from news. A real move continues,
    // reverses, or at least raises volatility; a re-basing leaves the next bars behaving normally.
    //
    // The successive returns AFTER the step, compared against the series' own normal move. An
    // earlier version indexed the mapped array rather than the previous bar's close, so every
    // value was NaN and the test silently never fired — which is why the suite asserts both the
    // catch and the non-catch rather than only the catch.
    const win = b.slice(i, i + SEAM_FOLLOW_BARS + 1);
    const after = [];
    for (let k = 1; k < win.length; k++) {
      const p = win[k - 1].close;
      if (p > 0) after.push(Math.abs((win[k].close - p) / p) * 100);
    }
    // Too few bars after the step to judge follow-through: say so rather than guess quiet.
    const enough = after.length >= Math.ceil(SEAM_FOLLOW_BARS / 2);
    after.sort((x, y) => x - y);
    const afterMedian = after.length ? after[after.length >> 1] : null;
    const quietAfter = enough && afterMedian != null && afterMedian <= median * 1.5;
    out.push({
      date: String(b[i].date).slice(0, 10),
      prevDate: String(b[i - 1].date).slice(0, 10),
      prevClose: b[i - 1].close, close: b[i].close,
      gapPct: Math.round(gapPct * 100) / 100,
      sigma: Math.round((mag / median) * 10) / 10,
      // Higher when the step had no follow-through, which is the seam signature.
      seamLike: quietAfter,
      sourceChange: b[i].source && b[i - 1].source && b[i].source !== b[i - 1].source,
    });
  }
  return out;
}
