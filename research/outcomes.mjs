// FORWARD OUTCOMES — what actually happened after an observation date.
//
// ⚠️ RESEARCH ONLY. Never imported by src/.
//
// THE SEPARATION THIS FILE EXISTS TO ENFORCE: features are built from evidence dated strictly BEFORE
// the observation date, and outcomes are built from bars dated strictly AFTER it. The two never meet
// in the same function, and the bar on the observation date itself belongs to NEITHER — it is the
// price you would have transacted at, and letting it into the feature set is the classic one-bar
// leak that makes a backtest look brilliant.
//
// "THE STOCK WENT UP" IS NOT AN OUTCOME. A 12% gain that first drew down 30% is not the same event
// as a smooth 12% grind, and a model tuned on the first number would recommend positions nobody
// could hold. So each horizon reports the path as well as the endpoint: excursions both ways, the
// realized volatility, and which barrier was touched first.
//
// EVERYTHING IS RELATIVE AS WELL AS ABSOLUTE. A 10% gain in a quarter when the market rose 12% is
// underperformance, and a model scored on absolute returns will simply rediscover market beta and
// call it insight.
//
// Pure: bars in, numbers out. No database, no network, no clock.

/** Horizons in TRADING days, because calendar days are not comparable across holidays. */
export const HORIZONS = Object.freeze([5, 20, 63, 126, 252]);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (from, to) => (isNum(from) && isNum(to) && from > 0 ? ((to - from) / from) * 100 : null);

/**
 * The bars strictly after an observation date, oldest first.
 *
 * `bars` must be ascending, adjusted, and one row per session. ADJUSTED IS NOT OPTIONAL: an
 * unadjusted 2-for-1 split reads as a −50% return, which is a fabricated outcome label that would
 * teach the model that whatever preceded a split is bearish.
 */
export function forwardBars(bars, asOfDay) {
  if (!Array.isArray(bars) || !asOfDay) return [];
  return bars.filter((b) => b && typeof b.date === 'string' && b.date > asOfDay);
}

/** The last bar at or before a day — the entry price, and the only bar the observation date owns. */
export function priceOn(bars, asOfDay) {
  if (!Array.isArray(bars) || !asOfDay) return null;
  let found = null;
  for (const b of bars) { if (b?.date && b.date <= asOfDay) found = b; else break; }
  return found && isNum(found.close) ? found.close : null;
}

/**
 * One horizon's outcome for one security.
 *
 * Returns null when the window is INCOMPLETE — a 252-day label computed from 180 available days is
 * not a shorter-horizon label, it is a survivorship-flavoured guess, and a dataset full of them
 * quietly becomes a dataset about stocks that were still listed.
 */
export function horizonOutcome(bars, asOfDay, horizon, { upPct = 10, downPct = 10 } = {}) {
  const entry = priceOn(bars, asOfDay);
  const fwd = forwardBars(bars, asOfDay);
  if (entry == null || fwd.length < horizon) return null;

  const window = fwd.slice(0, horizon);
  const exit = isNum(window[horizon - 1]?.close) ? window[horizon - 1].close : null;
  if (exit == null) return null;

  let maxUp = 0, maxDown = 0, peak = entry, trough = entry, maxDrawdown = 0;
  let firstTouch = null;
  const rets = [];
  let prev = entry;

  for (const b of window) {
    const hi = isNum(b.high) ? b.high : b.close;
    const lo = isNum(b.low) ? b.low : b.close;
    if (isNum(hi)) maxUp = Math.max(maxUp, ((hi - entry) / entry) * 100);
    if (isNum(lo)) maxDown = Math.min(maxDown, ((lo - entry) / entry) * 100);
    // Which barrier was hit FIRST. Within a single bar we cannot know the order of the high and the
    // low, so a bar that touches both is recorded as ambiguous rather than resolved in our favour.
    if (firstTouch == null && isNum(hi) && isNum(lo)) {
      const up = ((hi - entry) / entry) * 100 >= upPct;
      const down = ((lo - entry) / entry) * 100 <= -downPct;
      if (up && down) firstTouch = 'ambiguous';
      else if (up) firstTouch = 'up';
      else if (down) firstTouch = 'down';
    }
    if (isNum(b.close)) {
      peak = Math.max(peak, b.close);
      trough = Math.min(trough, b.close);
      maxDrawdown = Math.min(maxDrawdown, ((b.close - peak) / peak) * 100);
      const r = pct(prev, b.close);
      if (r != null) rets.push(r);
      prev = b.close;
    }
  }

  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
  const variance = rets.length > 1 ? rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1) : null;
  // Annualized from daily, the standard 252 convention, stated rather than implied.
  const realizedVol = variance != null ? Math.sqrt(variance) * Math.sqrt(252) : null;

  return {
    horizon,
    entry,
    exit,
    returnPct: pct(entry, exit),
    maxFavorablePct: maxUp,
    maxAdversePct: maxDown,
    maxDrawdownPct: maxDrawdown,
    realizedVolPct: realizedVol,
    firstTouch: firstTouch ?? 'neither',
    bars: window.length,
  };
}

/**
 * The same horizon measured against a benchmark — the number that decides whether anything was added.
 *
 * Arithmetic excess, not a ratio: over these horizons the difference is immaterial and the
 * subtraction is the one a reader can check in their head.
 */
export function excessReturn(symbolReturnPct, benchmarkReturnPct) {
  if (!isNum(symbolReturnPct) || !isNum(benchmarkReturnPct)) return null;
  return symbolReturnPct - benchmarkReturnPct;
}

/**
 * Every horizon for one observation, with benchmark-relative figures where a benchmark is supplied.
 *
 * `benchmarkBars` and `sectorBars` are ordinary bar series for SPY and the sector ETF. A missing
 * benchmark yields null excess rather than a zero — an unmeasured comparison is not a comparison
 * that came out even.
 */
export function outcomesFor(bars, asOfDay, { benchmarkBars = null, sectorBars = null, horizons = HORIZONS, barriers } = {}) {
  const out = {};
  for (const h of horizons) {
    const own = horizonOutcome(bars, asOfDay, h, barriers);
    if (!own) { out[h] = null; continue; }
    const bench = benchmarkBars ? horizonOutcome(benchmarkBars, asOfDay, h, barriers) : null;
    const sector = sectorBars ? horizonOutcome(sectorBars, asOfDay, h, barriers) : null;
    out[h] = {
      ...own,
      benchmarkReturnPct: bench ? bench.returnPct : null,
      excessVsBenchmarkPct: bench ? excessReturn(own.returnPct, bench.returnPct) : null,
      sectorReturnPct: sector ? sector.returnPct : null,
      excessVsSectorPct: sector ? excessReturn(own.returnPct, sector.returnPct) : null,
    };
  }
  return out;
}

/**
 * ⚠️ THE LEAK CHECK. Asserts that no feature observation is dated at or after the decision instant.
 *
 * Cheap, and run on every dataset row rather than trusted to review: leakage does not announce
 * itself, it announces a great result.
 */
export function assertNoLookAhead(observations, asOfMs) {
  const offenders = (observations || []).filter((o) => !(o?.informationAt < asOfMs));
  if (offenders.length) {
    const sample = offenders.slice(0, 3).map((o) => `${o.ticker}/${o.family}.${o.type}@${o.informationAt}`).join(', ');
    throw new Error(`look-ahead: ${offenders.length} observation(s) not strictly before ${asOfMs} — ${sample}`);
  }
  return true;
}
