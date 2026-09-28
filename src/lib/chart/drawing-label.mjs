// TEXT ATTACHED TO A DRAWING — its style, and where it lands.
//
// ⚠️ THIS IS NOT A SECOND CAPTION. Drawings have carried an attached `label` since they were built:
// stored on the drawing, painted from its geometry, edited from the toolbar. The brief asks for text
// on a selected drawing with alignment, placement, colour, size and weight — which is that field
// grown up, not a new one beside it. A parallel `text` string on a labelable drawing would give one
// line two captions, two toolbar buttons that look interchangeable, and two things to keep in step
// when the line is dragged. So `label` is the content and this module is its style and geometry.
//
// The standalone Text NOTE tool is a different thing and stays as it is: there, the string IS the
// drawing. A tool is `hasText` or `labelable`, never both.
//
// ⚠️ PURE, AND THAT IS THE POINT. Where a caption lands is decidable from the segment, the style and
// the plot size — so it is decided here and asserted in node, rather than by dragging a chart around
// and looking. The renderer measures the text and asks; it does no placement arithmetic of its own.

import { coerceColorValue } from './color-palette.mjs';

/** Where the caption sits ALONG the drawing's first segment. */
export const LABEL_ALIGNS = Object.freeze(['left', 'center', 'right']);
/** Which side of the line it sits on. */
export const LABEL_PLACES = Object.freeze(['above', 'middle', 'below']);
/** The sizes offered. Four is a choice, not a spectrum: a caption is a tag, not typography. */
export const LABEL_SIZES = Object.freeze([10, 12, 14, 18]);

/**
 * ⚠️ RIGHT AND ABOVE, which the brief asks for and which is also the right default. A horizontal
 * line's segment spans the whole plot, so a right-aligned caption pins to the right edge — beside
 * the price axis, where the eye already is when it is reading what a level costs, and out of the way
 * of the candles on the left. Above, because a line drawn at a price is usually naming resistance
 * over the action rather than under it.
 *
 * ⚠️ AND `color` IS ABSENT, NOT null-as-a-value. Absent means "inherit the drawing's colour", the
 * same convention the Fibonacci levels use — so a caption on a red line is red until someone says
 * otherwise, and a drawing stored before any of this existed paints exactly as it always did.
 */
export const DEFAULT_LABEL_STYLE = Object.freeze({
  size: 12, bold: true, align: 'right', place: 'above',
});

/** Padding inside the caption's plate. */
export const LABEL_PAD = 4;
/** Clearance between the line and the plate. */
export const LABEL_GAP = 5;

/**
 * A caption's style from anything a caller or a stored record might hand us.
 *
 * ⚠️ AN ABSENT STYLE IS THE DEFAULT STYLE, NOT A MISSING ONE. Every drawing saved before captions
 * had styling comes back through here, and a size of undefined would reach canvas as `undefinedpx`
 * and silently paint nothing.
 */
/**
 * A manually chosen position, or null.
 *
 * ⚠️ AN ABSOLUTE POINT IN THE CHART'S OWN COORDINATES — a time and a price — NOT AN OFFSET FROM THE
 * DRAWING. It was an offset in seconds and price from the drawing's first anchor, and that model was
 * wrong twice over.
 *
 * It could not move horizontally at all on a daily chart. Daily series carry times as 'YYYY-MM-DD'
 * STRINGS, and the offset arithmetic converted a time to seconds with a helper that understood
 * numbers and {year,month,day} objects and nothing else. Number('2026-09-25') is NaN, so every
 * horizontal delta resolved to zero and the shift was silently dropped. Price is a plain number, so
 * the vertical axis worked and the horizontal one was frozen — exactly the reported symptom.
 *
 * And even repaired it would have been the wrong shape: a caption whose position is derived from the
 * drawing's geometry is a caption that can only ever be placed relative to it. A time and a price are
 * what the chart is made of, so they survive a pan, a zoom, a resize, a timeframe change and a reload
 * for the same reason the drawing's own anchors do, and they place the text anywhere in the plot.
 *
 * The caption still BELONGS to the drawing: it is stored on it, deleted with it, and carried along
 * when the drawing is dragged — see moveDrawing, which shifts this by the same delta. Belonging and
 * being positionally derived are different things, and conflating them is what broke this.
 */
export function sanitizeLabelAnchor(raw) {
  const price = Number(raw?.price);
  const time = raw?.time;
  if (!Number.isFinite(price)) return null;
  // The two shapes a series actually uses: unix seconds, or a 'YYYY-MM-DD' business day.
  const ok = (typeof time === 'number' && Number.isFinite(time))
    || (typeof time === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(time));
  return ok ? { time, price } : null;
}

export function sanitizeLabelStyle(raw) {
  const color = coerceColorValue(raw?.color);
  const size = Number(raw?.size);
  const at = sanitizeLabelAnchor(raw?.at);
  return {
    // Absent means inherit; present means the user chose it, in both themes.
    ...(color !== null ? { color } : {}),
    // ⚠️ ABSENT UNTIL THE USER DRAGS IT. While it is absent the caption follows align/place — the
    // sensible default near the drawing. Once it is present, it wins and nothing snaps it back.
    ...(at ? { at } : {}),
    size: LABEL_SIZES.includes(size) ? size : DEFAULT_LABEL_STYLE.size,
    bold: raw?.bold === undefined ? DEFAULT_LABEL_STYLE.bold : raw.bold === true,
    align: LABEL_ALIGNS.includes(raw?.align) ? raw.align : DEFAULT_LABEL_STYLE.align,
    place: LABEL_PLACES.includes(raw?.place) ? raw.place : DEFAULT_LABEL_STYLE.place,
  };
}

/** The canvas font a style asks for. One place, so the measurement and the paint cannot disagree. */
export const labelFont = (style) =>
  `${style?.bold === false ? 400 : 700} ${style?.size || DEFAULT_LABEL_STYLE.size}px 'DM Sans', sans-serif`;

/** The plate's height for a size — the line box plus the padding above and below it. */
export const labelHeight = (style) =>
  Math.round((style?.size || DEFAULT_LABEL_STYLE.size) * 1.35) + LABEL_PAD * 2;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Where a manually placed caption sits, in pixels — or null if the user has not placed one.
 *
 * The stored anchor is chart data, so turning it into a position needs the chart's own projection.
 * That is passed in rather than imported: this module stays pure, and the caller already holds the
 * exact projection the strokes were drawn with, which is the one the caption has to agree with.
 */
export function labelAnchorPoint(style, toScreen) {
  const at = style?.at;
  if (!at || typeof toScreen !== 'function') return null;
  const px = toScreen(at);
  return px && Number.isFinite(px.x) && Number.isFinite(px.y) ? { x: px.x, y: px.y } : null;
}

/**
 * Where a caption's plate goes, in plot pixels.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 *
 * `align` picks a point ALONG the drawing's first segment — its start, middle or end. `place` offsets
 * the plate off that point, to the side of the line.
 *
 * ⚠️ WHY ALONG THE SEGMENT AND NOT AT A REMEMBERED PIXEL. A caption anchored to a stored position is
 * one that drifts off its line the first time the line is dragged, and jumps on every zoom. Anchoring
 * to the segment means the answer is recomputed from the same projection the stroke came from, every
 * frame — so panning, zooming, resizing and dragging the line all move the caption exactly as much as
 * they move the line, and none of them move it on their own.
 *
 * For a horizontal line the segment spans the visible plot, so `right` pins the caption to the right
 * edge and it stays there while the chart scrolls underneath — which is what it should do, because
 * that line has no right-hand end to sit at.
 *
 * ⚠️ THE OFFSET IS PERPENDICULAR-ISH, NOT ALWAYS VERTICAL. On a segment that runs more vertically than
 * horizontally — a vertical line — offsetting "above" upward would put the caption on top of the line
 * it is naming. So for those, above/below become left/right: the same before/after-the-line
 * relationship, rotated with the line. The words stay because they are right for every other tool.
 *
 * @param segment    [{x,y},{x,y}] in plot pixels — the drawing's first segment
 * @param style      a sanitized label style
 * @param textWidth  the measured width of the string, in px
 * @param plot       { w, h } the drawable area
 * @returns {{x:number,y:number,w:number,h:number,textX:number,textY:number}|null}
 */
export function labelBox(segment, style, textWidth, plot, opts = {}) {
  const a = segment?.[0];
  const b = segment?.[1];
  if (!a || !b || !plot) return null;
  for (const v of [a.x, a.y, b.x, b.y, plot.w, plot.h, textWidth]) {
    if (!Number.isFinite(v)) return null;
  }
  const gap = opts.gap ?? LABEL_GAP;
  const pad = opts.pad ?? LABEL_PAD;
  const s = style || DEFAULT_LABEL_STYLE;

  // ⚠️ A MANUAL POSITION WINS, AND NOTHING SNAPS IT BACK. `opts.at` is where the caller projected the
  // stored data-space offset to, in pixels. align and place still exist and still work — they are the
  // DEFAULT, used until the user drags the caption somewhere of their own choosing.
  if (opts.at && Number.isFinite(opts.at.x) && Number.isFinite(opts.at.y)) {
    const wFixed = Math.max(1, textWidth) + pad * 2;
    const hFixed = labelHeight(s);
    const x0 = clamp(opts.at.x, pad, Math.max(pad, plot.w - wFixed - pad));
    const y0 = clamp(opts.at.y, pad, Math.max(pad, plot.h - hFixed - pad));
    return { x: x0, y: y0, w: wFixed, h: hFixed, textX: x0 + pad, textY: y0 + hFixed / 2, manual: true };
  }

  const f = s.align === 'left' ? 0 : s.align === 'center' ? 0.5 : 1;
  const px = a.x + (b.x - a.x) * f;
  const py = a.y + (b.y - a.y) * f;

  const w = Math.max(1, textWidth) + pad * 2;
  const h = labelHeight(s);
  const steep = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);

  let x;
  let y;
  if (steep) {
    // A near-vertical line: along it is vertical, so the side-offset is horizontal.
    y = s.align === 'left' ? py + gap : s.align === 'right' ? py - gap - h : py - h / 2;
    x = s.place === 'above' ? px - gap - w : s.place === 'below' ? px + gap : px - w / 2;
  } else {
    x = s.align === 'left' ? px + gap : s.align === 'right' ? px - gap - w : px - w / 2;
    y = s.place === 'above' ? py - gap - h : s.place === 'below' ? py + gap : py - h / 2;
  }

  // ⚠️ INSIDE THE PLOT, ALWAYS, and clamped last so a clamp cannot undo a placement. A caption drawn
  // over the price scale reads as a rendering fault rather than as a label.
  x = clamp(x, pad, Math.max(pad, plot.w - w - pad));
  y = clamp(y, pad, Math.max(pad, plot.h - h - pad));
  return { x, y, w, h, textX: x + pad, textY: y + h / 2, manual: false };
}
