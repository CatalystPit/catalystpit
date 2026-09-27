// PRICE-AXIS LABELS FOR DRAWINGS — the chips on the right-hand scale.
//
// A horizontal line IS a price, and a price level without its number on the axis makes the user
// guess what they placed. Lightweight Charts already draws exactly this chip for its own price
// lines, so the label is NOT reimplemented here: a native price line is created per drawing with
// `lineVisible: false`, which contributes the axis chip and nothing else.
//
// ⚠️ WHY `lineVisible: false` IS THE WHOLE TRICK. The overlay canvas already strokes the line, with
// this drawing's width, dash, extension flags, attached label, selection handles and hit test. A
// native price line that also drew itself would double-stroke every level at a slightly different
// width, and the second copy would be unselectable and undraggable because it is not ours. Hiding
// the native line keeps one line, one selection, one source of truth — and borrows only the chip.
//
// THE PRICE IS NEVER RE-DERIVED. A spec's price is read straight off the drawing's stored anchor
// through the tool's own `priceLabel`, so the chip cannot drift from the line: they are the same
// number. There is no second price source, and nothing here converts a pixel.
//
// FORMATTING IS THE LIBRARY'S JOB. The chip is rendered by the price scale, so it uses the series'
// own formatter and inherits the instrument's precision and minimum move. Nothing in this file
// formats a price, which is why an instrument quoted to four decimals needs no special case.
//
// Pure: drawings in, label specs out, and a tiny adapter so the reconciliation can be tested with no
// chart at all.

/**
 * Relative luminance of a #rrggbb colour, per WCAG.
 *
 * Needed because the chip is filled with the DRAWING'S colour, and the two palettes run in opposite
 * directions: the light theme's drawing colours are dark (#1A3A78) and the dark theme's are light
 * (#6FA8FF). A single text colour would be unreadable in one of them, and picking per theme would
 * still be wrong for any colour later added to the other end of a palette. Measured, not assumed.
 */
export function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const srgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

/** Ink or paper on this chip, whichever the eye can actually read. */
export const LABEL_INK = '#0B0F0C';
export const LABEL_PAPER = '#FFFFFF';

/** WCAG contrast between two colours, either order. */
export const contrastRatio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * ⚠️ MEASURED AGAINST BOTH, NOT THRESHOLDED. A cutoff on luminance ("above 0.42 use ink") is the
 * obvious version and it was wrong for four of the twelve palette colours: white on #6FA8FF is
 * 2.41:1, unreadable, because those mid-tone blues and greens sit well below the cutoff while still
 * being far too light for white text. Comparing the two candidates has no cutoff to get wrong and
 * cannot be wrong for a colour added later.
 */
export const readableTextOn = (hex) => (
  contrastRatio(hex, LABEL_PAPER) >= contrastRatio(hex, LABEL_INK) ? LABEL_PAPER : LABEL_INK
);

/**
 * One label spec per drawing that should carry a price chip.
 *
 * A tool opts in by declaring `priceLabel(points)` — the registry hook that says "this drawing IS a
 * price". Only the horizontal line declares it today; a tool that does not is skipped rather than
 * given a chip at some arbitrary anchor, because a trend line has two prices and neither is the
 * line's value.
 *
 * SKIPPED: a drawing hidden on its own, and every drawing when the layer is hidden. A chip left on
 * the axis for a line the user has turned off is a level they cannot see, cannot select and cannot
 * remove — the worst of the three states.
 */
export function axisLabelSpecs(drawings, toolOf, { colorOf, visible = true, inView } = {}) {
  if (!visible) return [];
  const specs = [];
  for (const d of drawings || []) {
    if (!d || d.visible === false) continue;
    const def = toolOf?.(d.type);
    if (typeof def?.priceLabel !== 'function') continue;
    let price;
    try { price = def.priceLabel(d.points, d); } catch { continue; }
    if (!Number.isFinite(price)) continue;
    // ⚠️ A PRICE OFF THE TOP OR BOTTOM OF THE PLOT GETS NO CHIP AT ALL.
    //
    // Lightweight Charts keeps a price line's axis label visible for ANY resolvable coordinate — its
    // CustomPriceLinePriceAxisView checks only that the coordinate is non-null — and then the axis
    // layout PINS a label that falls within half a label-height of an edge back onto that edge. That
    // is right for the crosshair and for the last-value chip, which always belong somewhere on the
    // axis. It is wrong for a drawing: zoom until a $270.04 line has left the top of the screen and
    // its chip sat on the boundary still reading 270.04, describing a level that is nowhere near it.
    //
    // ⚠️ THE FIX IS TO WITHHOLD THE PRICE LINE, NOT TO CLAMP A COORDINATE. Nothing here computes a
    // clamped y — no Math.max/Math.min over the plot bounds — because a clamped coordinate is exactly
    // the lie being removed. The drawing keeps its real stored price; only the chip comes and goes,
    // and it returns by itself the moment the price is back in view because this is re-evaluated on
    // every scale change.
    if (typeof inView === 'function' && !inView(Number(price))) continue;
    const color = colorOf ? colorOf(d) : '#888888';
    specs.push({ id: d.id, price: Number(price), color, textColor: readableTextOn(color) });
  }
  return specs;
}

/**
 * Is this price inside the plot, as the chart currently maps it?
 *
 * Built from the live conversion rather than from a remembered range, so it answers for the scale as
 * it is now. `top`/`bottom` are the plot's pixel bounds; a coordinate the scale cannot produce at all
 * is out of view by definition.
 *
 * ⚠️ INCLUSIVE OF THE EDGES. A level sitting exactly on the first or last pixel of the plot IS
 * visible — its line is drawn there — so its chip belongs on the axis. Only a coordinate genuinely
 * past an edge is withheld.
 */
export function priceInPlot(price, coordinateOf, top, bottom) {
  if (!Number.isFinite(price) || typeof coordinateOf !== 'function') return false;
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return false;
  let y;
  try { y = coordinateOf(price); } catch { return false; }
  if (y == null || !Number.isFinite(y)) return false;
  return y >= top && y <= bottom;
}

/** Does this chip need touching, or is it already showing the right number in the right colour? */
export const sameSpec = (a, b) => !!a && !!b
  && a.price === b.price && a.color === b.color && a.textColor === b.textColor;

/**
 * Bring the chart's price lines in line with the specs, touching as little as possible.
 *
 * `current` maps drawing id -> { spec, handle }. The adapter is { create(spec), update(handle, spec),
 * remove(handle) } so this can be driven by a fake in a test and by the series in the browser.
 *
 * ⚠️ RECONCILED, NOT REBUILT. Clearing every price line and re-adding them on each render is the
 * obvious version and it flickers: the chips blink on every repaint, and a repaint happens on every
 * crosshair move. Reconciling by drawing id means a chip is created once, updated only when its
 * price or colour actually changes, and removed only when its drawing is gone — so adding a second
 * horizontal line cannot disturb the first one's label, and selecting one cannot disturb any.
 */
export function reconcileAxisLabels(current, specs, adapter) {
  const next = new Map();
  const wanted = new Map((specs || []).map((s) => [s.id, s]));

  // Gone, hidden, or no longer a price-labelled tool: drop the chip.
  for (const [id, entry] of current || new Map()) {
    if (!wanted.has(id)) {
      try { adapter.remove(entry.handle); } catch { /* the chart may already be torn down */ }
    }
  }

  for (const [id, spec] of wanted) {
    const existing = current?.get(id);
    if (existing) {
      if (sameSpec(existing.spec, spec)) { next.set(id, existing); continue; }
      // Same chip, new number — an applyOptions keeps the SAME price line, which is what lets a drag
      // move the label continuously instead of destroying and recreating it sixty times a second.
      try {
        adapter.update(existing.handle, spec);
        next.set(id, { spec, handle: existing.handle });
        continue;
      } catch { /* fall through and recreate it */ }
    }
    try {
      const handle = adapter.create(spec);
      if (handle) next.set(id, { spec, handle });
    } catch { /* a label is decoration; never fail the chart for one */ }
  }
  return next;
}

/**
 * The price-line options for a spec.
 *
 * `axisLabelColor` defaults to the line's colour in Lightweight Charts, but it is passed explicitly
 * so the chip's fill cannot quietly change if that default ever does. `title` is deliberately empty:
 * a title is painted on the PANE, over the candles, and the chip on the axis is the whole point.
 */
export const priceLineOptionsFor = (spec) => ({
  price: spec.price,
  color: spec.color,
  lineVisible: false,        // ← our canvas draws the line; this contributes only the axis chip
  axisLabelVisible: true,
  axisLabelColor: spec.color,
  axisLabelTextColor: spec.textColor,
  title: '',
});
