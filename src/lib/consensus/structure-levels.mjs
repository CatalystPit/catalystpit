// WHERE PRICE SITS RELATIVE TO MEANINGFUL DAILY-CHART LEVELS.
//
// ⚠️ THIS IS NOT MARKET REACTION, AND THE TWO WERE PREVIOUSLY MIXED IN ONE LIST. The card showed
// "-2.5% in the session · +1.4% last session · 5D +0.7% · -39.7% below the 20-day high" under a
// heading that said MARKET STRUCTURE. Three of those four are generic returns a trader can read
// anywhere, and the fourth is a distance to a level the card never names.
//
//   MARKET REACTION    what price did AFTER the evidence became public   (reaction engine, unchanged)
//   MARKET STRUCTURE   where price sits relative to daily-chart levels    (this file)
//
// ⚠️ DESCRIPTIVE, NEVER PREDICTIVE. Everything here is an observable relationship between the last
// completed close and a level derived from completed candles. Nothing says a level will hold, will
// reject, or implies a trade. "Testing support" is a statement about distance; "strong support will
// hold" would be a forecast, and this module must never produce one.
//
// Pure: no database, no clock, no network. The caller supplies completed daily bars.

export const STRUCTURE_VERSION = 'consensus_v1_structure';

/**
 * ⚠️ HOW MANY COMPLETED SESSIONS MUST SIT EITHER SIDE OF A PIVOT BEFORE IT IS A PIVOT.
 *
 * This is the whole lookahead-safety argument. A swing high is only a swing high once the market
 * has traded PAST it and failed to exceed it, so a pivot at bar i is not confirmed until bars
 * i+1 … i+k exist and are complete. Requiring k on BOTH sides means:
 *
 *   · the newest bar can never be a pivot (nothing has traded after it yet)
 *   · a level that appears in today's output was already confirmed k sessions ago
 *   · recomputing this for any historical date gives the same answer it would have given then
 *
 * Three is conservative: it needs a full week's shape around a turn, so a single volatile session
 * cannot mint a level. Larger would be more robust and would also stop finding levels at all on
 * anything but the longest ranges.
 */
export const PIVOT_CONFIRMATION_BARS = 3;

/** Only the last year matters for "where is it now" — older pivots are history, not context. */
export const PIVOT_LOOKBACK_SESSIONS = 252;

/**
 * ⚠️ WHAT COUNTS AS "AT" A LEVEL. Within 2% of a level is close enough that the level is the
 * relevant fact; beyond it, the level is context rather than a location. Deliberately not tighter:
 * daily closes are not intraday touches, and pretending to 0.25% precision on a close-only series
 * would be fake precision about a number that moves several percent intraday.
 */
export const NEAR_LEVEL_PCT = 2.0;

export const SESSIONS_20D = 20;
export const MA_SHORT = 50;
export const MA_LONG = 200;

/**
 * ⚠️ ABSENCE IS CHECKED BEFORE CONVERSION, AND THE OBVIOUS SPELLING IS WRONG.
 *
 * `Number.isFinite(Number(v))` — which is what this was — returns TRUE for null, because
 * `Number(null)` is 0 and zero is finite. Measured consequences before the fix: a 50-day average
 * on a 40-session series reported `{price: 0}` instead of being withheld, and a candle with a null
 * close survived the filter and became the "last close" at $0, which then failed the `close > 0`
 * gate and silently returned no structure at all for the whole ticker.
 *
 * This codebase has shipped that exact coercion twice before — once on the dividend calendar's
 * filters and once where a null quote became a −100% tile. Third time it is caught by a test.
 */
const fin = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const pctFrom = (level, price) => ((price - level) / level) * 100;

/**
 * CONFIRMED DAILY SWING HIGHS AND LOWS.
 *
 * A bar is a swing high when its HIGH is the strict maximum of the window [i-k, i+k]; a swing low
 * when its LOW is the strict minimum. Both sides required — see PIVOT_CONFIRMATION_BARS.
 *
 * ⚠️ THE LOOP BOUND IS THE LOOKAHEAD GUARD. `i <= n-1-k` is what stops the newest k bars from
 * being considered, which is precisely the case where confirmation has not happened yet. Removing
 * it would let today's bar declare itself a pivot and the level would vanish tomorrow.
 *
 * @returns { highs: [{date, price}], lows: [{date, price}] } oldest first
 */
export function confirmedPivots(bars, { k = PIVOT_CONFIRMATION_BARS } = {}) {
  const out = { highs: [], lows: [] };
  const b = (bars || []).filter((x) => fin(x?.high) && fin(x?.low));
  const n = b.length;
  if (n < 2 * k + 1) return out;

  for (let i = k; i <= n - 1 - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (b[j].high >= b[i].high) isHigh = false;
      if (b[j].low <= b[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.highs.push({ date: b[i].date, price: b[i].high });
    if (isLow) out.lows.push({ date: b[i].date, price: b[i].low });
  }
  return out;
}

const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

/**
 * THE FACTS, before any selection. Every field is null rather than approximate when the history
 * is not there — a 200-day average computed from 80 bars is a different number wearing the name.
 */
export function structureFacts(bars) {
  const b = (bars || []).filter((x) => fin(x?.close));
  if (b.length < 2) return null;

  const last = b[b.length - 1];
  const close = Number(last.close);
  if (!(close > 0)) return null;

  const recent = b.slice(-PIVOT_LOOKBACK_SESSIONS);
  const { highs, lows } = confirmedPivots(recent);

  // Nearest level on each side of the current close. "Support" is the highest confirmed swing low
  // still BELOW price; "resistance" the lowest confirmed swing high still ABOVE it.
  const below = lows.filter((p) => p.price < close).sort((x, y) => y.price - x.price);
  const above = highs.filter((p) => p.price > close).sort((x, y) => x.price - y.price);
  const support = below[0] || null;
  const resistance = above[0] || null;

  // ⚠️ THE 20-SESSION RANGE EXCLUDES THE CURRENT BAR. Comparing today's close against a window
  // that contains today makes "closed above the 20-session high" unachievable by construction.
  const prior20 = b.slice(-(SESSIONS_20D + 1), -1);
  const high20 = prior20.length === SESSIONS_20D
    ? prior20.reduce((a, x) => (fin(x.high) && x.high > a ? x.high : a), -Infinity) : null;
  const low20 = prior20.length === SESSIONS_20D
    ? prior20.reduce((a, x) => (fin(x.low) && x.low < a ? x.low : a), Infinity) : null;

  const closes = b.map((x) => Number(x.close));
  const ma50 = closes.length >= MA_SHORT ? mean(closes.slice(-MA_SHORT)) : null;
  const ma200 = closes.length >= MA_LONG ? mean(closes.slice(-MA_LONG)) : null;

  return {
    version: STRUCTURE_VERSION,
    asOf: last.date,
    close: r2(close),
    sessions: b.length,
    support: support ? { price: r2(support.price), date: support.date, pct: r2(pctFrom(support.price, close)) } : null,
    resistance: resistance ? { price: r2(resistance.price), date: resistance.date, pct: r2(pctFrom(resistance.price, close)) } : null,
    high20: fin(high20) ? { price: r2(high20), pct: r2(pctFrom(high20, close)), broken: close > high20 } : null,
    low20: fin(low20) ? { price: r2(low20), pct: r2(pctFrom(low20, close)), broken: close < low20 } : null,
    ma50: fin(ma50) ? { price: r2(ma50), pct: r2(pctFrom(ma50, close)), above: close > ma50 } : null,
    ma200: fin(ma200) ? { price: r2(ma200), pct: r2(pctFrom(ma200, close)), above: close > ma200 } : null,
  };
}

const away = (p) => `${Math.abs(p).toFixed(1)}% ${p >= 0 ? 'above' : 'below'}`;

/**
 * THE 2–4 LINES A CARD SHOWS, chosen by how much they locate the stock right now.
 *
 * ⚠️ NOT EVERY METRIC THAT EXISTS. Six available numbers rendered as six lines is a data dump that
 * buries the one fact that matters. The order below is a relevance hierarchy, and a level that is
 * far away is dropped rather than padded in: a 200-day average 60% from price locates nothing.
 *
 * @returns [{ headline, detail }] — headline is a location, detail names the level and distance.
 */
export function structureLines(facts, { max = 4 } = {}) {
  if (!facts) return [];
  const lines = [];
  const near = (p) => Math.abs(p) <= NEAR_LEVEL_PCT;

  // 1–2. A BREAK OF THE RECENT RANGE OUTRANKS EVERYTHING, because it is the one state where the
  // level itself just changed rather than merely being approached.
  if (facts.high20?.broken) {
    lines.push({ headline: 'Above the prior 20-session high',
      detail: `Closed at ${facts.close} against a prior 20-session high of ${facts.high20.price}` });
  } else if (facts.low20?.broken) {
    lines.push({ headline: 'Below the prior 20-session low',
      detail: `Closed at ${facts.close} against a prior 20-session low of ${facts.low20.price}` });
  }

  // 3. NEARBY CONFIRMED SUPPORT.
  if (facts.support) {
    const p = facts.support.pct;
    lines.push({
      headline: near(p) ? 'Testing support' : 'Support',
      detail: `${facts.support.price} — recent daily swing low, price ${away(p)}`,
      emphasis: near(p),
    });
  }

  // 4. NEARBY CONFIRMED RESISTANCE.
  if (facts.resistance) {
    const p = facts.resistance.pct;
    lines.push({
      headline: near(p) ? 'Near resistance' : 'Resistance',
      detail: `${facts.resistance.price} — recent daily swing high, price ${away(p)}`,
      emphasis: near(p),
    });
  }

  // 5. RANGE PROXIMITY, only when we did not already say the range broke and only when it is close
  //    enough to be a location rather than a statistic.
  if (!facts.high20?.broken && !facts.low20?.broken) {
    if (facts.high20 && near(facts.high20.pct)) {
      lines.push({ headline: 'Near the 20-session high', detail: `${facts.high20.price}, price ${away(facts.high20.pct)}` });
    } else if (facts.low20 && near(facts.low20.pct)) {
      lines.push({ headline: 'Near the 20-session low', detail: `${facts.low20.price}, price ${away(facts.low20.pct)}` });
    }
  }

  // 6–7. THE MOVING AVERAGES, LAST AND ONLY IF THERE IS ROOM. They are the least locating fact
  //      here — every stock is above or below its 50-day, always — so they fill remaining space
  //      rather than competing for the top of the list.
  for (const [ma, name] of [[facts.ma50, '50D MA'], [facts.ma200, '200D MA']]) {
    if (lines.length >= max) break;
    if (!ma) continue;
    lines.push({ headline: `${ma.above ? 'Above' : 'Below'} ${name}`, detail: `${ma.price}, price ${away(ma.pct)}` });
  }

  // Emphasised lines first — "Testing support" locates the stock better than "Above 50D MA".
  return lines.sort((a, b) => (b.emphasis ? 1 : 0) - (a.emphasis ? 1 : 0)).slice(0, max);
}
