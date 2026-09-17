// PANE SIZING — how the price pane and the indicator panes beneath it share the chart's height.
//
// THE BUG THIS REPLACES. Lower panes were sized with Lightweight Charts' `pane.setHeight(px)`, and
// a redraw "kept" the user's height by reading `getHeight()` before tearing the panes down and
// calling `setHeight` again after rebuilding them. `setHeight` converts pixels into stretch factors
// using the panes' CURRENT pixel heights — and at that moment the lower panes had just been removed
// and re-added (height 0), while the price pane still reported its old, smaller height, because the
// library only re-lays-out on the next frame. So the restored height was measured against the PRICE
// PANE ALONE instead of the whole plot: a pane that was a fraction f of the chart came back as
// f / (1 − f). 110px of 600 (18%) became 22%, then 29%, 41%, 69% — every redraw, and a redraw
// happens on every symbol change, timeframe change, theme change and non-incremental refresh. That
// compounding is why RSI "opened" at half the chart. Two lesser faults rode along with it: the fixed
// 110px default was only ever applied to an indicator declaring a `scale` (RSI), so MACD and ATR
// took the library's default stretch of 1 against the price pane's 2 — a third of the chart — and a
// pixel default turned into a proportion at whatever size the chart happened to be when it drew.
//
// THE MODEL. Every pane's size is a SHARE of the plot, and it is applied as a stretch factor, which
// is what the library actually lays out from and what its own separator drag writes. A share needs
// no pixel measurement to apply, so it cannot be skewed by a stale height, and it keeps its
// proportion when the outer panel is resized.
//
//   1. A share the user chose by dragging a separator, saved per indicator instance.
//   2. Otherwise a compact default that keeps the price pane dominant.
//
// Pure: shares in, shares out, and a chart-shaped object with panes() for the two functions that
// read or write one. No React, no DOM.

/** The smallest height a lower pane is given by default, where there is room for it. */
export const LOWER_MIN_PX = 60;
/** The library's own floor for any pane; a saved share is never applied below it. */
export const PANE_FLOOR_PX = 30;
/** By default the price pane keeps at least this much of the plot, however many studies there are. */
export const PRICE_MIN_SHARE = 0.5;
/** A user may drag the price pane smaller than the default floor, but not below this. */
export const PRICE_MIN_SHARE_MANUAL = 0.25;
/** How much of the plot ALL lower panes take together by default, by count. Beyond the table: 0.5. */
export const LOWER_TOTAL_SHARE = [0, 0.22, 0.36, 0.45];
/** A stretch factor that moved by less than this is not a drag; it is rounding. */
export const MANUAL_TOLERANCE = 0.004;

const isShare = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1;

/**
 * The default share of each of `count` lower panes, in a plot `plotHeight` pixels tall.
 *
 * Grows with the count but not linearly — one study takes 22%, two take 36% between them, three
 * take 45% — so the price pane stays the chart. On a short plot each pane is lifted to a readable
 * minimum, but never at the price pane's expense past PRICE_MIN_SHARE.
 */
export function defaultLowerShares(count, plotHeight = 0) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return [];
  const total = n < LOWER_TOTAL_SHARE.length ? LOWER_TOTAL_SHARE[n] : 1 - PRICE_MIN_SHARE;
  let each = total / n;
  const h = Number(plotHeight);
  if (Number.isFinite(h) && h > 0) each = Math.max(each, LOWER_MIN_PX / h);
  each = Math.min(each, (1 - PRICE_MIN_SHARE) / n);
  return new Array(n).fill(each);
}

/**
 * The shares to apply: { price, lower[] }, summing to 1.
 *
 * `keys` are the lower panes' indicator instance keys, top to bottom; `saved` maps a key to the
 * share the user dragged it to. A saved share wins over the default. It is clamped rather than
 * discarded when the plot has changed size underneath it: never below the library's pane floor,
 * and never so large together that the price pane falls under PRICE_MIN_SHARE_MANUAL.
 */
export function resolvePaneShares(keys, saved = {}, plotHeight = 0) {
  const list = Array.isArray(keys) ? keys : [];
  const defaults = defaultLowerShares(list.length, plotHeight);
  const h = Number(plotHeight);
  const floor = Number.isFinite(h) && h > 0 ? PANE_FLOOR_PX / h : 0;
  let lower = list.map((k, i) => {
    const s = saved && Object.prototype.hasOwnProperty.call(saved, k) ? saved[k] : undefined;
    return isShare(s) ? Math.max(s, floor) : defaults[i];
  });
  const sum = lower.reduce((a, b) => a + b, 0);
  const maxLower = 1 - PRICE_MIN_SHARE_MANUAL;
  if (sum > maxLower) lower = lower.map((s) => (s * maxLower) / sum);
  const price = 1 - lower.reduce((a, b) => a + b, 0);
  return { price, lower };
}

/** Every pane's share of the plot, read from the stretch factors the library lays out from. */
export function readPaneShares(chart) {
  let panes;
  try { panes = chart?.panes?.() || []; } catch { return []; }
  const factors = panes.map((p) => {
    try { return Number(p.getStretchFactor()); } catch { return NaN; }
  });
  const total = factors.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
  if (!(total > 0)) return [];
  return factors.map((f) => (Number.isFinite(f) && f > 0 ? f / total : 0));
}

/**
 * Write shares onto the chart's panes as stretch factors. Returns the shares written, [price,
 * ...lower], or null when the chart does not have exactly one pane per share.
 */
export function applyPaneShares(chart, shares) {
  let panes;
  try { panes = chart?.panes?.() || []; } catch { return null; }
  const all = [shares.price, ...shares.lower];
  if (panes.length !== all.length) return null;
  all.forEach((s, i) => { try { panes[i].setStretchFactor(s); } catch { /* optional */ } });
  return all;
}

/**
 * Which lower panes the USER resized since `applied` was written — and to what.
 *
 * `applied` is { keys, shares } as last written; `current` is readPaneShares() now. A separator drag
 * changes the two panes either side of it, so dragging between price and RSI reports RSI, and
 * dragging between RSI and MACD reports both. A layout that no longer matches what was applied (a
 * different number of panes) reports nothing rather than guessing which pane is which.
 */
export function manualPaneChanges(applied, current, tolerance = MANUAL_TOLERANCE) {
  const out = {};
  if (!applied || !Array.isArray(applied.keys) || !Array.isArray(applied.shares)) return out;
  if (!Array.isArray(current) || current.length !== applied.shares.length) return out;
  if (applied.shares.length !== applied.keys.length + 1) return out;
  applied.keys.forEach((key, i) => {
    const was = applied.shares[i + 1];
    const now = current[i + 1];
    if (isShare(now) && Math.abs(now - was) > tolerance) out[key] = now;
  });
  return out;
}

/** A stored share map, made safe: string keys, shares strictly between 0 and 1, bounded in size. */
export function sanitizePaneShares(raw, max = 32) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= max) break;
    if (typeof k === 'string' && k && isShare(v)) out[k] = v;
  }
  return out;
}
