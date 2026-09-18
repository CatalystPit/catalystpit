// POPOVER PLACEMENT.
//
// Pure geometry: given the trigger's rect and the size of the window, where does the menu go. No
// React, no DOM — which is what lets every panel size be tested in node instead of by dragging a
// Terminal panel around by hand and hoping.
//
// WHY THE CHART'S MENUS ARE PLACED IN VIEWPORT COORDINATES AT ALL: the chart lives inside a Terminal
// panel that is `overflow: hidden`, so a menu positioned inside the chart is clipped by the panel —
// in a small panel it was cut off mid-row or lost entirely. The menus are therefore portalled out to
// the document and placed against the WINDOW, staying pinned to their trigger's rect. See Popover in
// components/chart/ChartUI.jsx.
//
// THE INVARIANT, and the thing the tests actually assert: whatever the panel size, whatever the
// trigger position, the resulting box lies entirely inside the window with an EDGE margin. A menu
// the user cannot see all of is the bug being fixed here, so "it fits" is the property, not a
// specific top/left.

export const EDGE = 6;          // never closer than this to a window edge
export const MIN_PANEL = 120;   // below this, a side is too small to be worth flipping into

/**
 * Where a popover goes, in viewport coordinates.
 *
 * Returns CSS box offsets — `top` OR `bottom`, `left` OR `right` — rather than always a top/left
 * pair. Anchoring a flipped menu by its BOTTOM edge is what avoids having to measure the panel's
 * height first, which would otherwise need a render, a measure and a second render: a visible jump.
 *
 * @param rect       the trigger's bounding rect ({ top, bottom, left, right })
 * @param placement  'bottom-start' | 'bottom-end' (toolbar dropdowns) | 'right-start' (rail flyouts)
 * @param viewport   { width, height } — defaults to the window, passed explicitly by the tests
 */
export function placeFor(rect, placement = 'bottom-start', opts = {}) {
  const { gap = 4, width = 200, maxHeight = 360, viewport } = opts;
  const vw = viewport?.width ?? globalThis.innerWidth;
  const vh = viewport?.height ?? globalThis.innerHeight;
  const w = Math.min(width, Math.max(1, vw - EDGE * 2));
  const out = { width: w };

  if (placement === 'right-start') {
    // A RAIL FLYOUT: beside the icon, flipped to its other side when that side has no room, and
    // clamped into the window when NEITHER side fits (a panel narrower than the menu).
    if (rect.right + gap + w <= vw - EDGE) out.left = rect.right + gap;
    else if (rect.left - gap - w >= EDGE) out.right = Math.max(EDGE, vw - rect.left + gap);
    else out.left = Math.max(EDGE, Math.min(rect.right + gap, vw - w - EDGE));
    // Vertically it hangs from the icon's top, sliding up only when it would run off the bottom.
    if (vh - rect.top - EDGE >= MIN_PANEL) {
      out.top = Math.max(EDGE, Math.min(rect.top, vh - EDGE - MIN_PANEL));
      out.maxHeight = vh - out.top - EDGE;
    } else {
      out.bottom = Math.max(EDGE, vh - rect.bottom);
      out.maxHeight = vh - out.bottom - EDGE;
    }
  } else {
    // A TOOLBAR DROPDOWN: directly under the control, flipped above only when it will not fit below.
    const spaceBelow = vh - rect.bottom - gap - EDGE;
    const spaceAbove = rect.top - gap - EDGE;
    if (spaceBelow >= Math.min(maxHeight, MIN_PANEL) || spaceBelow >= spaceAbove) {
      out.top = Math.max(EDGE, Math.min(rect.bottom + gap, vh - EDGE - 1));
      out.maxHeight = vh - out.top - EDGE;
    } else {
      out.bottom = Math.max(EDGE, Math.min(vh - rect.top + gap, vh - EDGE - 1));
      out.maxHeight = vh - out.bottom - EDGE;
    }
    // `bottom-end` hangs from the control's right edge, so a control near the window edge opens
    // inward. `bottom-center` centres on the control — what a small icon wants, since a 14px trigger
    // with a 270px panel left-aligned to it reads as unattached. The clamp below still applies, so
    // the rightmost column's icon pulls its tooltip inward rather than off the screen.
    const wanted = placement === 'bottom-end' ? rect.right - w
      : placement === 'bottom-center' ? (rect.left + rect.right) / 2 - w / 2
        : rect.left;
    out.left = Math.max(EDGE, Math.min(wanted, vw - w - EDGE));
  }

  out.maxHeight = Math.max(1, Math.min(out.maxHeight, maxHeight));
  return out;
}

/**
 * The box a placement actually occupies, at its largest (i.e. filled to maxHeight).
 *
 * Only the tests need this — it turns "top or bottom, left or right" back into a plain rect so the
 * fits-in-the-window invariant can be asserted directly.
 */
export function boxOf(pos, viewport) {
  const left = pos.left != null ? pos.left : viewport.width - pos.right - pos.width;
  const top = pos.top != null ? pos.top : viewport.height - pos.bottom - pos.maxHeight;
  return { left, top, right: left + pos.width, bottom: top + pos.maxHeight };
}
