// RAW COMPONENT SERIES — pure arithmetic over daily closes.
//
// Each function turns a date-ordered close series into the component's RAW value per session. None
// of them normalises, scores or knows which direction means fear; model.mjs owns that. Keeping the
// two apart is what lets the direction rules be mutation-tested without a database.
//
// ── ⚠️ EVERY SERIES IS TRAILING-ONLY ────────────────────────────────────────
//
// A value at index i is computed from bars at i and earlier, never later. That is what makes the
// historical index honest: the reading published for a past date uses only what existed on it.
// A future-leakage test asserts this directly by truncating the input and comparing.

/** Sessions in the momentum moving average. */
export const MOMENTUM_MA = 125;
/** Sessions in the realized-volatility estimate. */
export const VOL_LOOKBACK = 21;
/** Trading sessions per year, for annualising volatility. */
export const TRADING_YEAR = 252;
/** Sessions in the credit-appetite relative-return comparison. */
export const CREDIT_LOOKBACK = 20;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Close / SMA(MOMENTUM_MA) - 1, per session.
 *
 * @param {Array<{date,close}>} bars oldest first
 * @returns {Array<{date,value}>} only sessions with a full moving average behind them
 */
export function momentumSeries(bars = []) {
  const out = [];
  let sum = 0;
  const win = [];
  for (const b of bars) {
    const c = num(b.close);
    if (c === null) continue;
    win.push(c); sum += c;
    if (win.length > MOMENTUM_MA) sum -= win.shift();
    if (win.length < MOMENTUM_MA) continue;
    const sma = sum / MOMENTUM_MA;
    if (sma > 0) out.push({ date: b.date, value: c / sma - 1 });
  }
  return out;
}

/**
 * Annualised standard deviation of the last VOL_LOOKBACK daily log returns.
 *
 * ⚠️ REALIZED, NOT IMPLIED. This is what the market DID. It is not a VIX substitute and is never
 * presented as one — see METHODOLOGY in model.mjs for why there is no implied-volatility component.
 *
 * Population standard deviation (divide by n), which is the convention for a fixed rolling window;
 * the sample correction would change the level slightly and nothing about the ranking.
 */
export function volatilitySeries(bars = []) {
  const clean = bars.filter((b) => num(b.close) !== null);
  const rets = [];
  for (let i = 1; i < clean.length; i++) {
    rets.push({ date: clean[i].date, r: Math.log(num(clean[i].close) / num(clean[i - 1].close)) });
  }
  const out = [];
  for (let i = VOL_LOOKBACK - 1; i < rets.length; i++) {
    const w = rets.slice(i - VOL_LOOKBACK + 1, i + 1).map((x) => x.r);
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    const varc = w.reduce((a, b) => a + (b - mean) ** 2, 0) / w.length;
    out.push({ date: rets[i].date, value: Math.sqrt(varc) * Math.sqrt(TRADING_YEAR) });
  }
  return out;
}

/**
 * Relative performance of two close series over CREDIT_LOOKBACK sessions: riskReturn - safeReturn.
 *
 * Positive means the risk asset outperformed — credit appetite. Only sessions present in BOTH
 * series are compared, so a vendor gap in one cannot silently shift the other's window.
 */
export function relativeReturnSeries(riskBars = [], safeBars = [], lookback = CREDIT_LOOKBACK) {
  const safe = new Map(safeBars.map((b) => [String(b.date), num(b.close)]));
  const paired = [];
  for (const b of riskBars) {
    const r = num(b.close);
    const s = safe.get(String(b.date));
    if (r === null || s == null) continue;
    paired.push({ date: b.date, r, s });
  }
  const out = [];
  for (let i = lookback; i < paired.length; i++) {
    const now = paired[i], then = paired[i - lookback];
    out.push({ date: now.date, value: (now.r / then.r - 1) - (now.s / then.s - 1) });
  }
  return out;
}

/** Index a series by date for point-in-time lookup. */
export function byDate(series = []) {
  const m = new Map();
  for (const p of series) m.set(String(p.date), p.value);
  return m;
}

/**
 * The trailing window of a series ending at `date`, inclusive.
 *
 * ⚠️ THE WHOLE POINT-IN-TIME GUARANTEE LIVES HERE. Nothing after `date` may enter the window that
 * `date`'s percentile is computed against, or the historical index would be ranked against a future
 * it could not have seen.
 */
export function trailingWindow(series = [], date, size) {
  const key = String(date);
  const idx = series.findIndex((p) => String(p.date) === key);
  if (idx < 0) return [];
  const start = Math.max(0, idx - size + 1);
  return series.slice(start, idx + 1).map((p) => p.value);
}
