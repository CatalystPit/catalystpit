// THE INDICATOR SEAM.
//
// Indicators are PURE FUNCTIONS over bars. An indicator never touches the chart, never knows which
// library draws it, and never fetches anything — it takes the bars the chart already has and returns
// line data. That is what lets SMA, EMA, VWAP, RSI, MACD, Bollinger and ATR be added later as
// entries in this registry rather than as edits to the chart component.
//
// `pane` is the whole of the layout contract:
//   'price'    drawn over the candles, on the price scale (SMA, EMA, VWAP, Bollinger)
//   'separate' drawn in its own pane below (RSI, MACD, ATR) — Lightweight Charts v5 panes
//
// Two are implemented here, deliberately. A registry with nothing in it is an untested guess about
// an interface; one overlay and one session-anchored calculation are enough to prove the shape fits
// both the simple case and the case that needs session boundaries. The rest are listed as PLANNED so
// the gap is visible rather than implied.

/** @typedef {{ time: number|string, open: number, high: number, low: number, close: number, volume: number|null }} Bar */
/** @typedef {{ time: number|string, value: number }} LinePoint */

/** Simple moving average of close. The reference overlay implementation. */
export function sma(bars, { length = 20 } = {}) {
  const out = [];
  if (!Array.isArray(bars) || length < 1) return out;
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    sum += bars[i].close;
    if (i >= length) sum -= bars[i - length].close;
    if (i >= length - 1) out.push({ time: bars[i].time, value: sum / length });
  }
  return out;
}

/** Exponential moving average of close, seeded with the first `length` bars' SMA. */
export function ema(bars, { length = 20 } = {}) {
  const out = [];
  if (!Array.isArray(bars) || bars.length < length || length < 1) return out;
  const k = 2 / (length + 1);
  let acc = 0;
  for (let i = 0; i < length; i += 1) acc += bars[i].close;
  let prev = acc / length;
  out.push({ time: bars[length - 1].time, value: prev });
  for (let i = length; i < bars.length; i += 1) {
    prev = bars[i].close * k + prev * (1 - k);
    out.push({ time: bars[i].time, value: prev });
  }
  return out;
}

/**
 * Volume-weighted average price, ANCHORED TO THE SESSION.
 *
 * VWAP that runs continuously across days is not VWAP — the figure traders read resets at each
 * session open. `sessionKey` decides where that boundary falls, and is supplied by the caller
 * because only the caller knows the exchange timezone. Bars with no volume are skipped rather than
 * counted as zero, which would drag the average toward the last priced bar.
 *
 * Returns nothing at all when the bars carry no volume, rather than a flat line that looks like data.
 */
export function vwap(bars, { sessionKey = null } = {}) {
  const out = [];
  if (!Array.isArray(bars) || !bars.length) return out;
  let pv = 0, vol = 0, key = null;
  for (const b of bars) {
    const v = Number(b.volume);
    if (!Number.isFinite(v) || v <= 0) continue;
    const k = sessionKey ? sessionKey(b) : null;
    if (k !== key) { key = k; pv = 0; vol = 0; }
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * v;
    vol += v;
    if (vol > 0) out.push({ time: b.time, value: pv / vol });
  }
  return out;
}

/**
 * The registry the chart reads. Adding an indicator is adding a row here plus its pure function;
 * nothing in the chart component changes.
 */
export const INDICATORS = {
  sma:  { id: 'sma',  label: 'SMA',  pane: 'price',    compute: sma,  defaults: { length: 20 } },
  ema:  { id: 'ema',  label: 'EMA',  pane: 'price',    compute: ema,  defaults: { length: 20 } },
  vwap: { id: 'vwap', label: 'VWAP', pane: 'price',    compute: vwap, defaults: {}, intradayOnly: true },
};

/**
 * Declared, not built. Listed so the roadmap is in the code rather than in somebody's head, and so
 * the pane each one needs is decided before it is written.
 */
export const PLANNED_INDICATORS = [
  { id: 'rsi',       label: 'RSI',              pane: 'separate' },
  { id: 'macd',      label: 'MACD',             pane: 'separate' },
  { id: 'bollinger', label: 'Bollinger Bands',  pane: 'price' },
  { id: 'atr',       label: 'ATR',              pane: 'separate' },
];

/** Every indicator that can be applied to this timeframe. VWAP is meaningless on a daily bar. */
export function availableIndicators({ intraday }) {
  return Object.values(INDICATORS).filter((i) => (i.intradayOnly ? intraday : true));
}
