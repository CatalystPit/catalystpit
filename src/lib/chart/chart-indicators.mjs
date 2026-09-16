// THE INDICATOR LIBRARY.
//
// Every indicator is a PURE FUNCTION over the bars the chart already holds. None of them fetches,
// none knows which vendor produced the bars, and none touches the chart. That is what keeps them
// provider-agnostic: swapping Polygon or Tiingo changes chart-source.mjs and nothing in this file.
//
// ONE INTERFACE, so the chart renders any indicator without knowing which one it is:
//
//   compute(bars, params, ctx) -> { plots: [{ key, type, data, color?, lineWidth? }], guides?: [] }
//
//   plots   what to draw. `type` is 'line' or 'histogram'; `data` is [{ time, value }] using the
//           bars' own time values, so it lines up with the price series by construction.
//   guides  horizontal reference levels for a separate pane (RSI's 30/70). Purely visual.
//
// `pane: 'price'` draws over the candles; `pane: 'separate'` gets its own Lightweight Charts v5
// pane. Adding an indicator is a new entry in INDICATORS plus its pure function — no chart edits.
//
// ON CORRECTNESS. Wilder's smoothing (RSI, ATR) is not an EMA and not a simple mean; the seeding and
// the recurrence both matter, and getting them subtly wrong produces a line that looks plausible and
// is wrong. Each is implemented to its standard definition and checked in scripts/verify-chart.mjs
// against hand-computed values, not against itself.

/** @typedef {{ time: number|string, open: number, high: number, low: number, close: number, volume: number|null }} Bar */
/** @typedef {{ time: number|string, value: number }} Point */

const closes = (bars) => bars.map((b) => b.close);
const finite = (n) => Number.isFinite(n);

// ── moving averages ──────────────────────────────────────────────────────────

/** Simple moving average over an arbitrary series, returned aligned to `bars`. */
export function smaValues(values, length) {
  const out = new Array(values.length).fill(null);
  if (length < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `length` values.
 *
 * Seeding matters: starting from the first value instead makes the early line depend entirely on one
 * bar, and the two only converge after several multiples of the period.
 */
export function emaValues(values, length) {
  const out = new Array(values.length).fill(null);
  if (length < 1 || values.length < length) return out;
  const k = 2 / (length + 1);
  let acc = 0;
  for (let i = 0; i < length; i += 1) acc += values[i];
  let prev = acc / length;
  out[length - 1] = prev;
  for (let i = length; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Turn an aligned value array into plot points, dropping the leading nulls. */
const toPoints = (bars, values) => {
  const out = [];
  for (let i = 0; i < bars.length; i += 1) if (values[i] != null && finite(values[i])) out.push({ time: bars[i].time, value: values[i] });
  return out;
};

export function sma(bars, { length = 20 } = {}) {
  return { plots: [{ key: 'sma', type: 'line', data: toPoints(bars, smaValues(closes(bars), length)) }] };
}

export function ema(bars, { length = 20 } = {}) {
  return { plots: [{ key: 'ema', type: 'line', data: toPoints(bars, emaValues(closes(bars), length)) }] };
}

// ── VWAP ─────────────────────────────────────────────────────────────────────

/**
 * Volume-weighted average price, ANCHORED TO THE SESSION.
 *
 * VWAP that runs continuously across days is not VWAP: the number traders read resets every session.
 * The boundary comes from ctx.sessionKey, because only the caller knows the exchange timezone — see
 * sessionKeyFor() below, which is what the chart passes.
 *
 * EXTENDED HOURS. When the chart is showing pre- and post-market bars, those bars belong to the same
 * trading day and are included, so the line matches what a platform anchored at 04:00 ET shows. When
 * the chart is showing the regular session only, the extended bars are not in `bars` at all and the
 * anchor is effectively 09:30. Either way VWAP describes exactly the session on screen, which is the
 * only honest thing it can do with the data it is given.
 *
 * A bar with no volume is SKIPPED rather than counted as zero volume at its price — counting it
 * would drag the average toward a bar that never traded. If nothing has volume, there is no VWAP and
 * the plot is empty rather than a flat line that looks like data.
 */
export function vwap(bars, _params = {}, ctx = {}) {
  const key = ctx.sessionKey || null;
  const data = [];
  let pv = 0, vol = 0, session = null;
  for (const b of bars) {
    const v = Number(b.volume);
    if (!finite(v) || v <= 0) continue;
    const k = key ? key(b) : null;
    if (k !== session) { session = k; pv = 0; vol = 0; }
    pv += ((b.high + b.low + b.close) / 3) * v;
    vol += v;
    if (vol > 0) data.push({ time: b.time, value: pv / vol });
  }
  return { plots: [{ key: 'vwap', type: 'line', data }] };
}

// ── Bollinger Bands ──────────────────────────────────────────────────────────

/**
 * SMA with a POPULATION standard deviation band, which is the standard definition. Using the sample
 * (n-1) deviation widens every band slightly and is a common, quiet error.
 */
export function bollinger(bars, { length = 20, mult = 2 } = {}) {
  const c = closes(bars);
  const mid = smaValues(c, length);
  const upper = new Array(c.length).fill(null);
  const lower = new Array(c.length).fill(null);
  for (let i = length - 1; i < c.length; i += 1) {
    const m = mid[i];
    if (m == null) continue;
    let sq = 0;
    for (let j = i - length + 1; j <= i; j += 1) sq += (c[j] - m) ** 2;
    const sd = Math.sqrt(sq / length);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return {
    plots: [
      { key: 'upper', type: 'line', data: toPoints(bars, upper) },
      { key: 'basis', type: 'line', data: toPoints(bars, mid) },
      { key: 'lower', type: 'line', data: toPoints(bars, lower) },
    ],
  };
}

// ── RSI (Wilder) ─────────────────────────────────────────────────────────────

/**
 * Relative Strength Index, Wilder's original smoothing.
 *
 * Seeded with the simple mean of the first `length` gains and losses, then smoothed as
 * (prev * (length - 1) + current) / length. That is NOT an EMA of period `length` — it is an EMA of
 * period 2*length-1 — and substituting one for the other is the most common way this indicator is
 * silently wrong.
 *
 * An all-gains window has zero average loss. RS is then infinite and RSI is exactly 100; that is the
 * defined answer, not a divide-by-zero to guard against.
 */
export function rsi(bars, { length = 14 } = {}) {
  const c = closes(bars);
  const out = new Array(c.length).fill(null);
  if (c.length <= length) return { plots: [{ key: 'rsi', type: 'line', data: [] }], guides: [30, 50, 70] };
  let gain = 0, loss = 0;
  for (let i = 1; i <= length; i += 1) {
    const d = c[i] - c[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / length, avgLoss = loss / length;
  out[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = length + 1; i < c.length; i += 1) {
    const d = c[i] - c[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgGain = (avgGain * (length - 1) + g) / length;
    avgLoss = (avgLoss * (length - 1) + l) / length;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return {
    plots: [{ key: 'rsi', type: 'line', data: toPoints(bars, out) }],
    guides: [30, 50, 70],
    scale: { min: 0, max: 100 },
  };
}

// ── MACD ─────────────────────────────────────────────────────────────────────

/**
 * MACD line, signal line and histogram.
 *
 * The signal is an EMA of the MACD LINE, not of price, and it may only start once the MACD line
 * exists — so the leading nulls are stripped before the signal EMA runs and the result is realigned.
 * Computing the signal over an array padded with nulls (or zeros) is the usual bug here and pulls the
 * early signal toward zero.
 */
export function macd(bars, { fast = 12, slow = 26, signal = 9 } = {}) {
  const c = closes(bars);
  const fastE = emaValues(c, fast);
  const slowE = emaValues(c, slow);
  const line = new Array(c.length).fill(null);
  for (let i = 0; i < c.length; i += 1) if (fastE[i] != null && slowE[i] != null) line[i] = fastE[i] - slowE[i];

  const firstIdx = line.findIndex((v) => v != null);
  const sig = new Array(c.length).fill(null);
  const hist = new Array(c.length).fill(null);
  if (firstIdx >= 0) {
    const compact = line.slice(firstIdx);
    const sigCompact = emaValues(compact, signal);
    for (let i = 0; i < sigCompact.length; i += 1) {
      if (sigCompact[i] == null) continue;
      sig[firstIdx + i] = sigCompact[i];
      hist[firstIdx + i] = line[firstIdx + i] - sigCompact[i];
    }
  }
  return {
    plots: [
      { key: 'macd', type: 'line', data: toPoints(bars, line) },
      { key: 'signal', type: 'line', data: toPoints(bars, sig) },
      { key: 'hist', type: 'histogram', data: toPoints(bars, hist), signed: true },
    ],
    guides: [0],
  };
}

// ── ATR (Wilder) ─────────────────────────────────────────────────────────────

/** True range of a bar against the previous close. The first bar has no previous close. */
export function trueRange(bar, prevClose) {
  const hl = bar.high - bar.low;
  if (prevClose == null) return hl;
  return Math.max(hl, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

/** Average True Range, Wilder's smoothing — same recurrence as RSI, same reason it matters. */
export function atr(bars, { length = 14 } = {}) {
  const out = new Array(bars.length).fill(null);
  if (bars.length <= length) return { plots: [{ key: 'atr', type: 'line', data: [] }] };
  const tr = bars.map((b, i) => trueRange(b, i === 0 ? null : bars[i - 1].close));
  let sum = 0;
  for (let i = 1; i <= length; i += 1) sum += tr[i];
  let prev = sum / length;
  out[length] = prev;
  for (let i = length + 1; i < bars.length; i += 1) {
    prev = (prev * (length - 1) + tr[i]) / length;
    out[i] = prev;
  }
  return { plots: [{ key: 'atr', type: 'line', data: toPoints(bars, out) }] };
}

// ── volume ───────────────────────────────────────────────────────────────────

/**
 * Volume is drawn by the chart itself on its own pinned scale, so this entry exists to make it a
 * TOGGLE in the same menu as everything else rather than a special case the user has to find
 * somewhere different. `builtin` tells the chart to flip its own series instead of adding plots.
 */
export function volume() { return { plots: [] }; }

// ── the registry ─────────────────────────────────────────────────────────────

/**
 * Colours are indexes into the chart palette rather than hex, because the chart has two themes and a
 * hard-coded colour would be unreadable in one of them. See chart-theme.mjs → indicatorColors.
 */
export const INDICATORS = {
  volume:    { id: 'volume',    label: 'Volume',          pane: 'price',    builtin: true, compute: volume, params: [] },
  // ANY period the user types, within reason. 1000 covers every conventional average and more; 1 is
  // degenerate but valid — it is the close itself — and there is no reason to forbid it. Both are
  // O(n) whatever the length, so a long period costs screen space and nothing else.
  sma:       { id: 'sma',       label: 'SMA',             pane: 'price',    compute: sma,
    params: [{ key: 'length', label: 'Length', type: 'int', min: 1, max: 1000, default: 20 }],
    colors: { sma: 0 } },
  ema:       { id: 'ema',       label: 'EMA',             pane: 'price',    compute: ema,
    params: [{ key: 'length', label: 'Length', type: 'int', min: 1, max: 1000, default: 20 }],
    colors: { ema: 1 } },
  vwap:      { id: 'vwap',      label: 'VWAP',            pane: 'price',    compute: vwap, intradayOnly: true,
    params: [], colors: { vwap: 2 } },
  bollinger: { id: 'bollinger', label: 'Bollinger Bands', pane: 'price',    compute: bollinger,
    params: [
      { key: 'length', label: 'Length', type: 'int', min: 2, max: 400, default: 20 },
      { key: 'mult', label: 'Std dev', type: 'float', min: 0.5, max: 5, step: 0.5, default: 2 },
    ],
    colors: { upper: 3, basis: 0, lower: 3 } },
  rsi:       { id: 'rsi',       label: 'RSI',             pane: 'separate', compute: rsi,
    params: [{ key: 'length', label: 'Length', type: 'int', min: 2, max: 200, default: 14 }],
    colors: { rsi: 1 } },
  macd:      { id: 'macd',      label: 'MACD',            pane: 'separate', compute: macd,
    params: [
      { key: 'fast', label: 'Fast', type: 'int', min: 2, max: 200, default: 12 },
      { key: 'slow', label: 'Slow', type: 'int', min: 3, max: 400, default: 26 },
      { key: 'signal', label: 'Signal', type: 'int', min: 2, max: 200, default: 9 },
    ],
    colors: { macd: 1, signal: 3, hist: 0 } },
  atr:       { id: 'atr',       label: 'ATR',             pane: 'separate', compute: atr,
    params: [{ key: 'length', label: 'Length', type: 'int', min: 2, max: 200, default: 14 }],
    colors: { atr: 2 } },
};

export const INDICATOR_IDS = Object.keys(INDICATORS);

/**
 * Indicators a user may have more than one of at a time.
 *
 * A 9/21/50/200 EMA ribbon is one of the most common setups there is, and the single-instance model
 * could not express it. Only the moving averages are multi-instance: two RSIs at different lengths
 * is a legitimate but rare thing to want, and each would need its own pane, so it is left until
 * somebody asks. Adding one is adding an id to this set.
 */
export const MULTI_INSTANCE = new Set(['sma', 'ema']);
export const isMultiInstance = (id) => MULTI_INSTANCE.has(id);

/** A ceiling per indicator, so the chart cannot be drowned in lines by accident. */
export const MAX_INSTANCES_PER_INDICATOR = 8;

/**
 * A stable identity for one instance.
 *
 * Needed because two EMAs are no longer told apart by their id. The key is what the chart uses to
 * decide which series to keep, what the settings file stores, and what React keys the menu rows on,
 * so it must survive a settings edit — changing an EMA's length must not destroy and recreate it as
 * a different instance, or its colour and visibility would reset with it.
 *
 * Derived from the existing set rather than random, so it is deterministic and testable and does not
 * need a browser crypto API.
 */
export function nextInstanceKey(id, existing = []) {
  const used = new Set(existing.map((e) => e?.key).filter(Boolean));
  for (let n = 1; n <= 999; n += 1) {
    const k = `${id}-${n}`;
    if (!used.has(k)) return k;
  }
  return `${id}-${Date.now()}`;
}

/**
 * Sensible defaults for a NEW instance of a multi-instance indicator.
 *
 * The lengths traders actually reach for, in the order they usually add them, so clicking "Add"
 * repeatedly builds a conventional ribbon instead of four identical lines. Past the end of the list
 * it falls back to the registry default; the user can type anything regardless.
 */
const COMMON_LENGTHS = [9, 21, 50, 200, 10, 20, 100, 5];

export function defaultParamsForNew(id, existing = []) {
  const base = defaultParams(id);
  if (!isMultiInstance(id)) return base;
  const taken = new Set(existing.filter((e) => e.id === id).map((e) => e.params?.length));
  const pick = COMMON_LENGTHS.find((n) => !taken.has(n));
  return { ...base, length: pick ?? base.length };
}

/** Defaults for one indicator, as a plain object. */
export function defaultParams(id) {
  const def = INDICATORS[id];
  if (!def) return {};
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}

/**
 * Clamp user input to the declared range and type.
 *
 * Settings come from a text box and are persisted to localStorage, which means they can arrive as a
 * string, as NaN, or as whatever a previous version wrote. An out-of-range length is not a display
 * bug: `length` drives loop bounds, and a negative or absurd value produces either an empty
 * indicator or a very slow one.
 */
export function sanitizeParams(id, raw) {
  const def = INDICATORS[id];
  if (!def) return {};
  const out = {};
  for (const p of def.params) {
    let v = raw?.[p.key];
    // An EMPTY box is missing, not zero. Number('') is 0 and finite, so without this a user who
    // clears the field to retype gets a 1-period average rather than the default back.
    if (v === '' || v === null || v === undefined) v = p.default;
    v = p.type === 'int' ? Math.round(Number(v)) : Number(v);
    if (!finite(v)) v = p.default;
    out[p.key] = Math.min(p.max, Math.max(p.min, v));
  }
  // MACD is the one indicator whose parameters constrain each other: a fast period at or above the
  // slow one inverts the line's meaning rather than erroring.
  if (id === 'macd' && out.fast >= out.slow) out.fast = Math.max(2, out.slow - 1);
  return out;
}

/** Every indicator applicable to this timeframe. VWAP is meaningless on a daily bar. */
export function availableIndicators({ intraday }) {
  return Object.values(INDICATORS).filter((i) => (i.intradayOnly ? intraday : true));
}

/** A short label for the chart legend: "SMA 20", "MACD 12/26/9". */
export function indicatorLabel(id, params) {
  const def = INDICATORS[id];
  if (!def) return id;
  const vals = def.params.map((p) => params?.[p.key] ?? p.default);
  return vals.length ? `${def.label} ${vals.join('/')}` : def.label;
}

/**
 * Run one indicator, never throwing.
 *
 * An indicator that throws would take the whole chart down with it, and a chart that fails to render
 * because a moving average hit a bad bar is a worse outcome than a missing line. Any failure returns
 * no plots, which the chart draws as nothing.
 */
export function computeIndicator(id, bars, params, ctx) {
  const def = INDICATORS[id];
  if (!def || !Array.isArray(bars) || !bars.length) return { plots: [] };
  try {
    const res = def.compute(bars, sanitizeParams(id, params), ctx || {});
    return res && Array.isArray(res.plots) ? res : { plots: [] };
  } catch {
    return { plots: [] };
  }
}
