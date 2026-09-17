// PROJECTION — turning a drawing's data anchors into the pixels a renderer strokes.
//
// THE BUG THIS FIXES. A Fibonacci's level lines and a horizontal line's span were built from
// SYNTHESIZED times — `view.from` and `view.to`, two moments manufactured from the visible range
// rather than anchors the user ever placed:
//
//     segments: (p, view) => [[{ time: view.from, price }, { time: view.to, price }]]
//
// Those times are not in the data, so they resolve only through a fallback path (timeToCoordinate
// returns null for anything that is not an exact bar, so the logical axis is consulted instead).
// And the renderer DISCARDED SILENTLY what it could not resolve:
//
//     const p1 = toScreen(a), p2 = toScreen(b);
//     if (p1 && p2) screenSegs.push([p1, p2]);      // ← a null here just vanished
//
// So the two tools whose geometry depended on manufactured times were the two that could lose their
// lines entirely — while a Fibonacci's LABELS, computed separately from the drawing's own anchors,
// carried on drawing. Labels with no lines under them is exactly that asymmetry.
//
// THE MODEL. An endpoint is resolved one of two ways, and never any other:
//
//   A DATA ANCHOR       { time, price } — a moment the user placed, through the chart's own scales.
//   A VIEWPORT EDGE     { edgeX } or { edgeY } — the edge of the PLOT, in pixels.
//
// A horizontal line spans the plot because the plot is what it spans; that is not data and it is no
// longer pretended to be. It cannot fail to resolve, cannot need a candle under it, and cannot come
// out diagonal. A Fibonacci's levels run between the fib's OWN two anchors — the same anchors a
// trendline uses, which already work in empty space — so nothing is manufactured at all.
//
// NOTHING IS DROPPED IN SILENCE. Anything that still fails to resolve is COUNTED, so a test can
// assert that a chart rendered no broken geometry rather than hoping it did.
//
// Pure: anchors and a scale adapter in, pixels out. No chart instance, no canvas, no DOM — which is
// what lets the geometry a browser actually strokes be asserted without a browser.

/** The plot edges an anchor may be pinned to. */
export const EDGE_LEFT = 'left';
export const EDGE_RIGHT = 'right';
export const EDGE_TOP = 'top';
export const EDGE_BOTTOM = 'bottom';

/** A price at one horizontal edge of the plot — how a horizontal line states its span. */
export const atEdgeX = (edgeX, price) => ({ edgeX, price });
/** A moment at one vertical edge of the plot — how a vertical line states its span. */
export const atEdgeY = (time, edgeY) => ({ time, edgeY });

/** Does this endpoint take any part of its position from the viewport rather than from data? */
export const isEdgeAnchor = (pt) => !!(pt && (pt.edgeX || pt.edgeY));

/**
 * One endpoint, in pixels — or null when it genuinely cannot be placed.
 *
 * `scale` is the adapter over whatever is drawing: { toX(time), toY(price), plotWidth, plotHeight }.
 * The edges come from the PLOT's measurements, never from the canvas: the canvas also covers the
 * price-scale gutter and the time axis, and using its width would push the right-hand edge out
 * underneath the price scale.
 */
export function resolveAnchor(pt, scale) {
  if (!pt || !scale) return null;
  const x = pt.edgeX === EDGE_LEFT ? 0
    : pt.edgeX === EDGE_RIGHT ? scale.plotWidth
      : scale.toX(pt.time);
  const y = pt.edgeY === EDGE_TOP ? 0
    : pt.edgeY === EDGE_BOTTOM ? scale.plotHeight
      : scale.toY(pt.price);
  // Number.isFinite rejects null, undefined and NaN in one test, which is the whole contract: no
  // non-finite coordinate reaches a renderer, so nothing is ever stroked to nowhere.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * Every drawing, resolved to pixels and ready to stroke or hit-test.
 *
 * Returns { items, dropped }. `dropped` counts endpoints that could not be placed — zero on a
 * healthy chart, and the number a regression test pins to zero.
 */
export function projectDrawings(drawings, view, scale, toolOf) {
  const items = [];
  let dropped = 0;
  for (const d of drawings || []) {
    const def = toolOf(d?.type);
    if (!def) continue;
    // The DRAWING is passed too: extension flags and a custom level set belong to the drawing, not
    // to the tool, so the tool cannot resolve its own geometry without it.
    const segments = [];
    // A tool that extends says so, and says which ends; the drawing's own flags decide the rest.
    const ext = typeof def.extend === 'function' ? (def.extend(d) || {}) : null;
    for (const [a, b] of def.segments(d.points, view, d) || []) {
      const p1 = resolveAnchor(a, scale);
      const p2 = resolveAnchor(b, scale);
      if (!p1 || !p2) { dropped += 1; continue; }
      const end = ext?.right ? extendToBox(p1, p2, scale.plotWidth, scale.plotHeight) : p2;
      const start = ext?.left ? extendToBox(p2, p1, scale.plotWidth, scale.plotHeight) : p1;
      segments.push([start, end]);
    }
    const handles = [];
    for (const pt of d.points) {
      const h = resolveAnchor(pt, scale);
      if (h) handles.push(h);
    }
    if (!segments.length && !handles.length) continue;
    items.push({
      id: d.id, type: d.type, visible: d.visible, style: d.style, segments, handles, source: d,
    });
  }
  return { items, dropped };
}

/**
 * Extend the line a->b past b until it leaves the plot.
 *
 * IN PIXELS, which is the whole point. A ray used to be extended by inventing a TIME for its far end
 * — `extendRay` walked the slope out to `view.to`, a moment manufactured from the visible range —
 * and that had two failures. `view.to` is the last CANDLE, so a ray stopped dead there instead of
 * carrying on across the empty space beside it; and when the ray's own second anchor was already
 * past that moment, the "extension" pointed BACKWARDS and came out shorter than a plain trendline.
 * On a daily chart it did nothing at all, because `view.to` is a date string and the slope
 * arithmetic refused it.
 *
 * The plot's boundary is pixels. Both anchors are already resolved to pixels by the time we get
 * here, so extending to it is exact, needs no time arithmetic, works in empty space for free, and
 * cannot fail on a chart whose bar times are strings.
 */
export function extendToBox(a, b, plotWidth, plotHeight) {
  const dx = b.x - a.x, dy = b.y - a.y;
  // The nearest boundary the ray reaches, as a multiple of the a->b step. A zero-length or
  // non-finite step matches none of the four tests below, leaves t at Infinity and falls through to
  // returning b untouched — so it needs no guard of its own, and a guard here would be a line no
  // test could ever hold to account.
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (plotWidth - a.x) / dx);
  if (dx < 0) t = Math.min(t, -a.x / dx);
  if (dy > 0) t = Math.min(t, (plotHeight - a.y) / dy);
  if (dy < 0) t = Math.min(t, -a.y / dy);
  // t < 1 means b is already outside the plot; extending to the edge would SHORTEN the line, which
  // is what the old time-based version did whenever the anchor sat in future space.
  if (!Number.isFinite(t) || t < 1) return b;
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/** The widest horizontal run in a projected drawing — what "is this actually visible" measures. */
export function widestSpan(item) {
  let max = 0;
  for (const [a, b] of item?.segments || []) max = Math.max(max, Math.abs(b.x - a.x));
  return max;
}

/**
 * Where a level's label belongs: the right-hand end of THAT LEVEL, kept inside the plot.
 *
 * It used to be pinned to the canvas's right edge by `Math.max(4, Math.min(cw - w - 6, cw - w - 6))`
 * — a Math.min of a value with itself, so every label landed at the far right of the panel, out over
 * the price scale and nowhere near the drawing it belonged to.
 */
export function labelX(segment, textWidth, plotWidth, pad = 6) {
  const right = Math.max(segment[0].x, segment[1].x);
  const left = Math.min(segment[0].x, segment[1].x);
  // Inside the level when it is wide enough to hold the text, just past its right end otherwise —
  // a label must never sit where there is no line under it.
  const wanted = (right - left) >= textWidth + pad * 2 ? right - textWidth - pad : right + pad;
  return Math.max(2, Math.min(wanted, plotWidth - textWidth - 2));
}
