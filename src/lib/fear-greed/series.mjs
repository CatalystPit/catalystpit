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
/**
 * Sessions in the volatility-market moving average.
 *
 * ⚠️ PROPRIETARY. This length, the instrument it is applied to and the inversion are the recipe for
 * the Market Volatility component, and none of them appear in anything the API serves or the page
 * renders — see the registry entry in model.mjs, which is deliberately conceptual.
 */
export const VOL_MARKET_MA = 50;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * A volume count: finite and non-negative, where ZERO IS A LEGITIMATE VALUE but absence is not.
 *
 * ⚠️ `num` above refuses zero, which is right for a price and wrong for a contract count — a
 * session with no puts is conceivable and would be real data. What must never pass is a MISSING
 * count, because Number(null) and Number('') are both 0 and would arrive as "no puts traded", the
 * most greedy reading the options component can produce, manufactured from an absent number.
 */
const count = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Close / SMA(length) - 1, per session. The shared shape behind Momentum and Market Volatility.
 *
 * ⚠️ ONE IMPLEMENTATION, TWO COMPONENTS, BECAUSE TWO WOULD DRIFT. Both measure the same thing —
 * how far a close sits from its own trailing average — over different lengths and on different
 * instruments, and both depend on the window ending AT the session. A second copy is a second
 * chance to write `i + 1` somewhere and leak a future bar into a historical value.
 *
 * The rolling sum only ever holds bars at or before the current one, so the value at index i is
 * computed from bars i-length+1 .. i and nothing later.
 *
 * @param {Array<{date,close}>} bars oldest first
 * @param {number} length sessions in the moving average
 * @returns {Array<{date,value}>} only sessions with a full moving average behind them
 */
export function smaDistanceSeries(bars = [], length) {
  const out = [];
  let sum = 0;
  const win = [];
  for (const b of bars) {
    const c = num(b.close);
    if (c === null) continue;
    win.push(c); sum += c;
    if (win.length > length) sum -= win.shift();
    if (win.length < length) continue;
    const sma = sum / length;
    if (sma > 0) out.push({ date: b.date, value: c / sma - 1 });
  }
  return out;
}

/**
 * Close / SMA(MOMENTUM_MA) - 1, per session.
 *
 * @param {Array<{date,close}>} bars oldest first
 * @returns {Array<{date,value}>} only sessions with a full moving average behind them
 */
export function momentumSeries(bars = []) {
  return smaDistanceSeries(bars, MOMENTUM_MA);
}

/**
 * The volatility market's own trend distance: close / SMA(VOL_MARKET_MA) - 1, per session.
 *
 * ⚠️ IT IS NOT THE VIX AND IT IS NOT A LEVEL. Catalyst Pit has no entitled source for the VIX index
 * (see METHODOLOGY.excluded), so this reads a market-traded short-term volatility instrument from
 * our own licensed daily bars. Two rules follow, and both are structural rather than editorial:
 *
 *   1. THE ABSOLUTE PRICE IS NEVER THE SIGNAL. These instruments decay by construction — a
 *      persistent downward drift from roll and compounding — so their level says more about how
 *      long they have existed than about today's stress. Measuring the close against its OWN
 *      trailing average subtracts that drift: the question becomes "is this unusual for this
 *      instrument lately", which is the same question every other component answers.
 *   2. HIGHER IS FEAR. Above its own trend means the volatility market is bidding up protection.
 *      The inversion is declared once, in COMPONENT_DIRECTION, and applied by scoreComponent.
 *
 * Trailing-only by the same construction as every other series here.
 */
/**
 * ⚠️ AUDITED 2026-09-26. THIS IS THE MOST DUPLICATED COMPONENT IN THE INDEX AND IT STAYS ANYWAY.
 *
 * Regressed on the other six components it scores R² 69.6%, the highest of the seven. The
 * redundancy decomposes by how much R² is lost when each predictor is dropped:
 *
 *   momentum 20.1pp   credit 15.3pp   realized volatility 14.9pp
 *   breadth 0.2pp     price strength 0.0pp
 *
 * So it overlaps the index-direction components, not the cross-sectional ones. The cause is the
 * instrument, not the arithmetic: its daily log returns correlate -0.762 with SPY with a beta of
 * -4.53, so 58% of its daily variance IS the equity index going the other way. Anything built on
 * it that is responsive enough to notice a volatility shock also notices the selloff that caused
 * the shock, and three other components already report that selloff.
 *
 * ⚠️ FIVE ALTERNATIVES WERE BUILT AND SCORED THROUGH THIS SAME NORMALISATION. All were rejected,
 * and the reason is always the same shape: R² can be lowered, but only by giving up the ability to
 * tell a volatility shock from a calm tape. Stress response below is the mean score in quiet bull
 * markets minus the mean across sharp selloffs and volatility shocks; this construction scores 56.9.
 *
 *   20-session return of the instrument   R² 69.3%  response 48.3  — no R² gain; moves the overlap
 *                                                                   onto credit (0.704)
 *   acceleration of the trend distance    R² 68.3%  response 33.2  — 1.3pp for a third of the
 *                                                                   response
 *   same shape against a 25-session mean  R² 63.9%  response 36.2  — 5.7pp for a third
 *   same shape against a 10-session mean  R² 39.5%  response  8.8  — reads 53.8 in a volatility
 *                                                                   shock and 32.7 in a sharp
 *                                                                   selloff. That is noise.
 *   instrument elevation MINUS realized-  R² 77.3%  response -32.4 — the interesting failure.
 *   volatility elevation                                            Built to separate priced
 *     forward stress from realized turbulence, and its divergence statistics looked ideal (on the
 *     same side of 50 as Realized Volatility only 24.7% of sessions). But subtracting the realized
 *     leg over-corrected into -0.537 correlation WITH Realized Volatility, so the regression
 *     reproduces it easily and R² went UP. It reads 87.9 — extreme greed — during volatility
 *     shocks. A divergence table alone would have shipped this; the R² and regime tests caught it.
 *
 * ⚠️ THE BINDING CONSTRAINT IS DATA, NOT CONSTRUCTION. Genuinely forward-looking stress needs
 * option prices or a volatility index, and we hold neither with settled rights: no entitled VIX
 * source (see METHODOLOGY.excluded), and the clearing-house feed carries contract counts with no
 * prices and no implied volatility. The unleveraged volatility ETFs are in the candle table but
 * have 269 sessions against the 504 this normalisation requires before it may score at all, so
 * they cannot produce a point-in-time value until roughly 2027. Worth revisiting then.
 *
 * Drift, for the record: full-year means 37.5 / 49.4 / 55.5 for 2024-2026, a swing of 18.0 within
 * the 16-24 that live components occupy — but rising monotonically, which is worth watching on a
 * decaying instrument. The 2023 partial year holds 22 sessions and must not be read as a fourth
 * point; including it reports a swing of 52 and means nothing.
 */
export function volMarketSeries(bars = []) {
  return smaDistanceSeries(bars, VOL_MARKET_MA);
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

/**
 * The equity-options put/call ratio, per session, from stored OCC volumes.
 *
 * ⚠️ DERIVED FROM TWO ACTUAL NUMBERS, NEVER STORED AS ONE. Each point is puts ÷ calls for a
 * session OCC actually published; a session we do not hold simply has no point, which is what makes
 * the component absent rather than wrong on a day the data is late. No interpolation, no carrying
 * a previous session's ratio forward, no default.
 *
 * ⚠️ AND IT IS TRAILING BY CONSTRUCTION in the only sense that applies: the value at a session is
 * that session's own cleared volume and nothing else's. There is no window here to leak through.
 *
 * @param {Array<{date,calls,puts}>} observations oldest first
 * @returns {Array<{date,value}>}
 */
export function optionsPcrSeries(observations = []) {
  const out = [];
  for (const o of observations) {
    // ⚠️ null IS NOT ZERO HERE EITHER. Number(null) is 0 and Number('') is 0, so a plain isFinite
    // guard accepts a missing put count as "no puts traded" — a ratio of 0.00, the most greedy
    // reading the component can produce, manufactured out of an absent number. Caught by the suite.
    const calls = count(o?.calls), puts = count(o?.puts);
    if (calls === null || puts === null || calls <= 0 || puts < 0) continue;
    out.push({ date: String(o.date), value: puts / calls });
  }
  return out;
}

/** Sessions over which the options put/call ratio's CHANGE is measured. */
export const OPTIONS_CHANGE_LOOKBACK = 20;

/**
 * The CHANGE in the equity-options put/call ratio over OPTIONS_CHANGE_LOOKBACK sessions.
 *
 * ── ⚠️ A CHANGE, NOT A LEVEL, AND THAT IS THE WHOLE REASON THIS COMPONENT WORKS ────
 *
 * The level construction shipped once and was withdrawn. Measured over 2024-2026 its yearly mean
 * slid 82 → 66 → 38 — a 44-point drift against 16-24 for every other component — because the
 * options market's product mix has shifted structurally on roughly the same horizon as the
 * normalisation window, and a rolling percentile cannot tell that apart from sentiment. The raw
 * ratio's own yearly medians went 0.73 → 0.68 → 0.76, non-monotonic, while the score fell
 * monotonically: the slide was manufactured by the window, not present in the market.
 *
 * Differencing removes it. Measured on the same data: the 20-session change drifts 8.1 points,
 * better than any component currently in the index. "Positioning is becoming more defensive" is
 * also the more honest sentiment question than "positioning is historically defensive", because
 * the second one requires the historical baseline to still mean what it meant.
 *
 * ⚠️ AND IT IS A DIFFERENCE, NOT A RATIO OF RATIOS. Dividing today's ratio by its own trailing
 * average scores almost as well on drift but correlates 0.550 with the rest of the index against
 * this construction's 0.421 — it is the same shape as Market Volatility (a level against its own
 * trailing mean) and inherits that component's information.
 *
 * @param {Array<{date,calls,puts}>} observations oldest first
 * @returns {Array<{date,value}>} one point per session that has a session lookback behind it
 */
export function optionsPcrChangeSeries(observations = [], lookback = OPTIONS_CHANGE_LOOKBACK) {
  const pcr = optionsPcrSeries(observations);
  const out = [];
  for (let i = lookback; i < pcr.length; i++) {
    out.push({ date: pcr[i].date, value: pcr[i].value - pcr[i - lookback].value });
  }
  return out;
}
