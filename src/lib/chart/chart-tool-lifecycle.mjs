// THE DRAWING TOOL LIFECYCLE — arm, click, commit.
//
// Two shapes of tool, and the difference is explicit rather than implied:
//
//   TWO-POINT TOOLS   trend, ray, rectangle, fib, measure — an anchor, then a second that fixes the
//                     geometry. They commit on the SECOND click, and between the two they preview
//                     from the anchor already placed to wherever the pointer is.
//   ONE-POINT TOOLS   horizontal, vertical, text — the click IS the drawing. They commit on the
//                     FIRST click, and they preview from the POINTER ALONE, because there is no
//                     placed anchor to preview from and a tool that shows nothing until it commits
//                     reads as a tool that does not work.
//
// THAT SECOND CASE IS WHAT WAS MISSING. The preview was gated on `draft.points.length`, which for a
// one-point tool is zero before the click and gone after it — so arming Horizontal Line or Vertical
// Line and moving the pointer across the chart produced no feedback of any kind.
//
// COMMITTING SUPPRESSES THE NEXT CHART CLICK. Lightweight Charts reports its own click after our
// pointerdown has already committed and disarmed the tool, so the chart's click handler no longer
// saw an armed tool, ran a hit test and deselected the drawing that had just been made. A one-point
// tool feels this worst: the whole gesture is one click, so the drawing appeared and lost its
// selection in the same motion.
//
// Pure: a state object in, a new state object out. No pointer events, no canvas, no React — which is
// what lets the creation lifecycle itself be tested rather than only the helpers underneath it.

import { tool } from './chart-drawings.mjs';

/** How many clicks this tool needs. Unknown tools need none — they cannot be armed. */
export const clicksNeeded = (toolId) => tool(toolId)?.points ?? 0;
/** Is this a tool whose single click is the whole drawing? */
export const isOnePoint = (toolId) => clicksNeeded(toolId) === 1;

/** Nothing armed, nothing half-drawn. */
export const idleTool = () => ({ activeTool: null, points: [], cursor: null, suppressClick: false });

/**
 * Arm a tool — or disarm when the same one is picked again.
 *
 * SWITCHING TOOLS DISCARDS THE HALF-DRAWN SHAPE. Carrying one tool's anchors into another is how a
 * trendline ends up with a rectangle's second corner; the anchors belong to the tool that placed
 * them.
 */
export function armTool(state, toolId) {
  const id = toolId && tool(toolId) ? toolId : null;
  if (!id) return { ...idleTool(), suppressClick: state?.suppressClick === true };
  return { activeTool: id, points: [], cursor: null, suppressClick: state?.suppressClick === true };
}

/** Escape, a tool change, or any other abandonment. The armed tool survives; the geometry does not. */
export function cancelDraft(state) {
  return { ...state, points: [], cursor: null };
}

/** Track the pointer so the shape being placed can be previewed under it. */
export function hoverTool(state, anchor) {
  if (!state?.activeTool) return state;
  return { ...state, cursor: anchor || null };
}

/**
 * A click.
 *
 * Returns { state, commit } where `commit` is the finished anchor list when this click completed the
 * drawing, and null when the tool is still collecting. The caller creates the drawing — this decides
 * only WHEN there is one to create, which is the part that has to be the same for every tool.
 */
export function clickTool(state, anchor) {
  const id = state?.activeTool;
  const need = clicksNeeded(id);
  if (!id || !need || !anchor) return { state, commit: null };
  const points = [...(state.points || []), anchor];
  if (points.length < need) {
    return { state: { ...state, points, cursor: anchor }, commit: null };
  }
  // Disarmed on commit, and the chart's own click — which arrives after this one — is suppressed so
  // it cannot hit-test the brand-new drawing and deselect it.
  return {
    state: { activeTool: null, points: [], cursor: null, suppressClick: true },
    commit: points.slice(0, need),
  };
}

/** The chart's click has been consumed; the next one is a real click again. */
export function clearSuppression(state) {
  return state?.suppressClick ? { ...state, suppressClick: false } : state;
}

/**
 * The anchors to draw as a preview right now, or null when there is nothing to show.
 *
 * A one-point tool previews from the pointer alone — that is the fix. A two-point tool previews from
 * its placed anchor to the pointer, as it always did.
 */
export function draftPreview(state) {
  const id = state?.activeTool;
  const need = clicksNeeded(id);
  if (!id || !need || !state.cursor) return null;
  const pts = [...(state.points || []), state.cursor].slice(0, need);
  return pts.length === need ? { type: id, points: pts } : null;
}

/** Is there a half-placed shape that Escape or a tool switch would throw away? */
export const hasDraft = (state) => !!(state?.points && state.points.length > 0);
