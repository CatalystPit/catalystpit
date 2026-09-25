// THE SELECTED-DRAWING TOOLBAR — where it goes, and what it offers.
//
// ── ⚠️ WHY THIS IS A MODULE AND NOT JSX ─────────────────────────────────────
//
// A floating panel that is one pixel off the edge of a Terminal panel looks fine on the machine it
// was written on and is unusable on a laptop. Both of the things that can be wrong here — the box
// escaping the plot, and a control appearing for a drawing it cannot act on — are decidable from
// numbers, so they are decided here and asserted in node rather than by dragging a panel around.
//
// ── ⚠️ ONE SELECTION SYSTEM ─────────────────────────────────────────────────
//
// There is no per-tool selection anywhere: the chart holds `selectedIds`, the layer projects those
// drawings to pixels, and this turns that into a position and a control list. A second selection
// model for "the tool with the fancy toolbar" is exactly how two drawings end up disagreeing about
// what is selected.

import { tool } from './chart-drawings.mjs';

/** Clearance between the toolbar and the drawing it belongs to. */
export const TOOLBAR_GAP = 10;
/** Never closer than this to an edge of the plot. */
export const TOOLBAR_EDGE = 6;

/**
 * The controls a toolbar can show.
 *
 * ⚠️ NAMES, NOT INDEXES. The order a toolbar renders them in is the order controlsFor returns, and
 * a numeric contract between two files is the kind that survives a refactor while meaning something
 * different afterwards.
 */
export const CONTROL = Object.freeze({
  COLOR: 'color',
  WIDTH: 'width',
  DASH: 'dash',
  /** A tag attached to a line — "Resistance", "PM High". Moves with the drawing. */
  LABEL: 'label',
  /** The body of a text note, which IS the drawing rather than an annotation on one. */
  TEXT: 'text',
  LOCK: 'lock',
  DELETE: 'delete',
  MORE: 'more',
});

/**
 * Which controls belong on the toolbar for a drawing type.
 *
 * ⚠️ A CONTROL THAT CANNOT ACT IS WORSE THAN A MISSING ONE. A text note draws no line, so a width
 * and a dash style would be two controls that change a stored field nothing reads — the user
 * changes them, nothing happens, and they stop trusting the rest of the toolbar. What each type
 * gets is derived from what the TOOL DECLARES, so a new tool arrives with the right controls and no
 * edit here.
 */
export function controlsFor(type) {
  const def = tool(type);
  if (!def) return [];
  const out = [];
  // A note is its words: they come first, and they are the only text it has.
  if (def.hasText) out.push(CONTROL.TEXT);
  out.push(CONTROL.COLOR);
  // Stroke controls only for something that strokes a line.
  if (!def.hasText) { out.push(CONTROL.WIDTH); out.push(CONTROL.DASH); }
  // An attached tag, for the tools whose model carries one.
  if (def.labelable) out.push(CONTROL.LABEL);
  out.push(CONTROL.LOCK, CONTROL.DELETE);
  if (hasMore(type)) out.push(CONTROL.MORE);
  return out;
}

/** Whether a type has secondary settings worth a More button — extension, levels, or a fill. */
export function hasMore(type) {
  const def = tool(type);
  return !!def && (def.extendable === true || def.editableLevels === true || def.fill === true);
}

/**
 * The pixel box a set of projected drawings occupies.
 *
 * Handles AND segment endpoints, because the two are not the same: a horizontal line's handle sits
 * at the anchor's own time, which may be scrolled off screen, while its segment spans the plot. A
 * box built from handles alone would put the toolbar somewhere the line is not.
 *
 * @param items projected drawings — { handles: [{x,y}], segments: [[{x,y},{x,y}]] }
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function selectionBox(items) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (pt) => {
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  };
  for (const it of items || []) {
    for (const h of it?.handles || []) eat(h);
    for (const seg of it?.segments || []) { eat(seg?.[0]); eat(seg?.[1]); }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Where the toolbar goes, in plot pixels.
 *
 * ── ⚠️ THE RULES, IN ORDER ──────────────────────────────────────────────────
 *
 * 1. ABOVE THE DRAWING BY DEFAULT, because the point a user is dragging is usually the one under
 *    the pointer, and the pointer came from below far more often than from above.
 * 2. BELOW IT when there is no room above — which is the case the brief names: a drawing near the
 *    top of the chart gets its toolbar underneath.
 * 3. INSIDE THE PLOT, ALWAYS. Clamped last, so a clamp can never undo a flip. A toolbar half
 *    outside the panel is the failure this function exists to make impossible, and the assertion
 *    the suite makes is exactly that: for every box and every plot size, the result is inside.
 * 4. NEVER OVER THE DRAWING when either side has room. When neither does — a rectangle filling the
 *    plot — it goes to the top, which is the least-used part of a chart with a full-height drawing
 *    on it, and it is the only case in which overlap is possible at all.
 *
 * ⚠️ IT RETURNS THE SIZE IT PLACED, NOT ONLY THE POSITION. A Terminal panel can be narrower than
 * the toolbar's natural width, and no left offset makes a 220px bar fit in a 200px plot — placing
 * it at the edge and calling that inside is how a control ends up under the price scale. So the
 * width is clamped HERE and handed back, and the component renders at the width that was placed.
 * The alternative — the component capping its own width while this reasons about the uncapped one —
 * is two numbers for one box, which is the shape of the bug rather than a fix for it.
 *
 * @returns {{left:number, top:number, width:number, height:number, placement:'above'|'below'}}
 */
export function placeToolbar(box, size, plot) {
  const pw0 = Math.max(0, plot?.w || 0);
  const ph0 = Math.max(0, plot?.h || 0);
  const w = Math.min(Math.max(0, size?.w || 0), Math.max(0, pw0 - TOOLBAR_EDGE * 2));
  const h = Math.min(Math.max(0, size?.h || 0), Math.max(0, ph0 - TOOLBAR_EDGE * 2));
  const pw = pw0;
  const ph = ph0;
  const b = box || { x: 0, y: 0, w: 0, h: 0 };

  const above = b.y - TOOLBAR_GAP - h;
  const below = b.y + b.h + TOOLBAR_GAP;
  let top;
  let placement;
  if (above >= TOOLBAR_EDGE) { top = above; placement = 'above'; }
  else if (below + h <= ph - TOOLBAR_EDGE) { top = below; placement = 'below'; }
  else { top = TOOLBAR_EDGE; placement = 'below'; }

  // Centred on the drawing, then clamped. Centring is what makes the toolbar feel attached; the
  // clamp is what keeps it on screen, and it wins.
  const left = clamp(b.x + b.w / 2 - w / 2, TOOLBAR_EDGE, Math.max(TOOLBAR_EDGE, pw - w - TOOLBAR_EDGE));
  return {
    left,
    top: clamp(top, TOOLBAR_EDGE, Math.max(TOOLBAR_EDGE, ph - h - TOOLBAR_EDGE)),
    width: w,
    height: h,
    placement,
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Is the placed toolbar entirely inside the plot?
 *
 * Exported so the property the suite cares about is stated once, in the same file as the function
 * that has to satisfy it.
 */
export function fitsInside(pos, plot) {
  return pos.left >= 0 && pos.top >= 0
    && pos.left + (pos?.width || 0) <= (plot?.w || 0) + 1e-9
    && pos.top + (pos?.height || 0) <= (plot?.h || 0) + 1e-9;
}
