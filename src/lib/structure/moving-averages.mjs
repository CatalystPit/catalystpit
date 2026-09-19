// MOVING AVERAGES BY TIMEFRAME. PURE.
//
// ── NOT 20/50/200 ON EVERYTHING ─────────────────────────────────────────────
//
// The brief is explicit and it is right: calculating 20/50/200 on every timeframe because the code
// can is how you end up quoting a 200-month moving average — SIXTEEN YEARS of history, which most
// listed securities do not have, and which no trader references. Each timeframe gets the averages
// that are actually spoken about on it, and each one states how much history it needs.
//
//   DAILY    20 / 50 / 200   the universally quoted set. 200 needs ~10 months of sessions.
//   WEEKLY   10 / 30 / 40    10w ≈ the 50-day in weekly terms; 30w and 40w are the long-term
//                            references actually used on weekly charts. 40w ≈ 200 days.
//   MONTHLY  10 / 20         10-month and 20-month are real long-horizon references. Deliberately
//                            NO 200-month: it would demand 17 years and would describe a company
//                            that in many cases no longer exists in the same form.
//
// MISSING HISTORY IS UNAVAILABLE, NEVER APPROXIMATED. An average computed over fewer bars than its
// period is a different statistic wearing the same name, and a "200DMA" from 80 bars is simply
// false. Those come back null.

export const MA_SETS = Object.freeze({
  daily: Object.freeze([
    { period: 20, label: '20DMA', note: 'short-term daily reference' },
    { period: 50, label: '50DMA', note: 'the most widely watched daily average' },
    { period: 200, label: '200DMA', note: 'the long-term daily line; needs ~10 months of sessions' },
  ]),
  weekly: Object.freeze([
    { period: 10, label: '10WMA', note: 'weekly equivalent of the 50-day' },
    { period: 30, label: '30WMA', note: 'intermediate weekly reference' },
    { period: 40, label: '40WMA', note: 'weekly equivalent of the 200-day' },
  ]),
  monthly: Object.freeze([
    { period: 10, label: '10MMA', note: 'long-horizon monthly reference' },
    { period: 20, label: '20MMA', note: 'roughly a full cycle; needs 20 months' },
  ]),
});

/**
 * Simple moving average of closes at the last bar, or null when history is short.
 *
 * Simple rather than exponential: the levels traders actually talk about and defend are the simple
 * ones, and an EMA of the same period sits at a different price — quoting one as the other would
 * put the line in the wrong place.
 */
export function sma(bars, period) {
  const b = Array.isArray(bars) ? bars : [];
  if (b.length < period) return null;          // NOT approximated from what we have
  const slice = b.slice(-period);
  const sum = slice.reduce((s, x) => s + Number(x.close), 0);
  const v = sum / period;
  return Number.isFinite(v) ? v : null;
}

/** The SMA as of an arbitrary bar index — used to measure slope and historical position. */
export function smaAt(bars, period, endIndex) {
  const b = Array.isArray(bars) ? bars : [];
  if (endIndex + 1 < period || endIndex >= b.length) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += Number(b[i].close);
  const v = sum / period;
  return Number.isFinite(v) ? v : null;
}

/**
 * Slope, as percent change of the average itself over `lookback` bars of its own timeframe.
 *
 * Expressed in percent rather than price so it is comparable across securities, and measured on the
 * AVERAGE rather than on price, because the question is whether the line is rising — not whether
 * price happens to be above it.
 */
export const SLOPE_LOOKBACK = Object.freeze({ daily: 20, weekly: 8, monthly: 6 });
export const FLAT_SLOPE_PCT = 0.5;   // below this, the line is flat rather than trending

export function maSlope(bars, period, { lookback = 20 } = {}) {
  const b = Array.isArray(bars) ? bars : [];
  const end = b.length - 1;
  const now = smaAt(b, period, end);
  const then = smaAt(b, period, end - lookback);
  if (now == null || then == null || then <= 0) return null;
  const pct = ((now - then) / then) * 100;
  return {
    pct: Math.round(pct * 100) / 100,
    direction: pct > FLAT_SLOPE_PCT ? 'rising' : pct < -FLAT_SLOPE_PCT ? 'falling' : 'flat',
    lookback,
  };
}

/**
 * Every meaningful average for a timeframe, with its slope and price's relation to it.
 *
 * Returns entries for unavailable averages too, carrying `available: false` and the shortfall, so a
 * surface can say "200DMA needs 200 sessions, we hold 96" instead of silently omitting the line and
 * leaving a reader to assume it was not worth showing.
 */
export function movingAverages(bars, timeframe) {
  const set = MA_SETS[timeframe] || [];
  const b = Array.isArray(bars) ? bars : [];
  const last = b.length ? Number(b[b.length - 1].close) : null;
  const lookback = SLOPE_LOOKBACK[timeframe] ?? 20;

  return set.map((m) => {
    const value = sma(b, m.period);
    if (value == null) {
      return {
        ...m, timeframe, available: false, value: null, slope: null, priceVs: null,
        reason: `needs ${m.period} ${timeframe} bars, have ${b.length}`,
      };
    }
    const slope = maSlope(b, m.period, { lookback });
    return {
      ...m, timeframe, available: true,
      value: round(value),
      slope,
      priceVs: last == null ? null : {
        above: last > value,
        distancePct: round(((last - value) / value) * 100, 2),
      },
    };
  });
}

/**
 * The stacking of the averages — a descriptive fact, not a score.
 *
 * "Rising 50 above rising 200" is the classic bullish alignment and it is worth stating plainly.
 * Returns null rather than guessing when any required average is unavailable.
 */
export function maStructure(mas) {
  const avail = (mas || []).filter((m) => m.available);
  if (avail.length < 2) return { state: 'unavailable', reasons: ['not enough averages with history'] };
  const sorted = [...avail].sort((a, b) => a.period - b.period);
  const reasons = [];

  const ascending = sorted.every((m, i) => i === 0 || sorted[i - 1].value > m.value);
  const descending = sorted.every((m, i) => i === 0 || sorted[i - 1].value < m.value);
  const rising = sorted.filter((m) => m.slope?.direction === 'rising').length;
  const falling = sorted.filter((m) => m.slope?.direction === 'falling').length;

  let state = 'mixed';
  if (ascending && rising >= Math.ceil(sorted.length / 2)) {
    state = 'bullish-stack';
    reasons.push(`${sorted.map((m) => m.label).join(' > ')}`, `${rising} of ${sorted.length} rising`);
  } else if (descending && falling >= Math.ceil(sorted.length / 2)) {
    state = 'bearish-stack';
    reasons.push(`${sorted.map((m) => m.label).join(' < ')}`, `${falling} of ${sorted.length} falling`);
  } else {
    reasons.push('averages are not cleanly stacked');
  }
  return { state, reasons, ordered: sorted.map((m) => ({ label: m.label, value: m.value, slope: m.slope?.direction ?? null })) };
}

const round = (n, dp = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);
