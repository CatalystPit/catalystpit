// PANEL RESIZING — which edge you grabbed, and what that does to the rectangle.
//
// WHY RESIZING WAS A SINGLE CORNER. The Terminal is a free-floating workspace: every panel is an
// absolutely positioned { x, y, w, h } in pixels, and the whole gesture was one formula —
//
//     { ...o, w: Math.max(MIN_W, o.w + dx), h: Math.max(MIN_H, o.h + dy) }
//
// which is only meaningful from the BOTTOM-RIGHT, because it moves the right and bottom edges and
// nothing else. There was no notion of a resize direction anywhere in the code, so there was nowhere
// for a left or top edge to have been handled: one 22×22 corner was not a design decision so much as
// the only thing that formula could express.
//
// THE MODEL. A gesture names a HANDLE — n, s, e, w and the four corners — and the handle says which
// edges move. The opposite edges stay exactly where they are, which is the whole difference between
// resizing a window and moving one.
//
// MINIMUMS CLAMP THE DELTA, NOT THE RESULT. Clamping the result is the classic bug: drag a left edge
// past the minimum width and `w = max(MIN_W, w - dx)` stops shrinking while `x = x + dx` keeps
// going, so the panel slides across the screen instead of stopping. Here the delta itself is capped
// first, so a panel at its minimum simply stops, with its far edge pinned where the user left it.
//
// SHARED BORDERS. Panels float and may overlap; nothing in the layout records that two of them are
// adjacent, so there is no split-pane tree to drive. Adjacency is therefore DERIVED AT GRAB TIME —
// an opposing edge within a few pixels, with a real overlap along the shared run — and used for that
// one gesture only. Nothing is stored, no panel is ever relocated behind the user's back, and when
// no neighbour is found the resize is simply independent.
//
// Pure: rectangles in, rectangles out. No DOM, no React, no pointer events.

/** How far from a border the pointer still counts as being on it. Generous on purpose: the border
 *  is the control, and hunting for a 1px line is exactly the problem being fixed. */
export const EDGE_PX = 8;
/** A corner claims a square this big, so two-axis resizing is easy to hit without being fiddly. */
export const CORNER_PX = 16;
/** How far the band reaches OUTSIDE the panel, into the gap between panels. */
export const OUTSET_PX = 4;

/** Every handle, in the order a frame renders them. 'move' is the header's, and is not an edge. */
export const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** The cursor that tells the user what a grab will do, before they commit to it. */
const CURSORS = {
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  nw: 'nwse-resize', se: 'nwse-resize',
  move: 'grabbing',
};
export const cursorFor = (handle) => CURSORS[handle] || 'default';

/** Does this handle move the west edge? …and so on. The single source of truth for the rest. */
export const movesWest = (h) => h === 'w' || h === 'nw' || h === 'sw';
export const movesEast = (h) => h === 'e' || h === 'ne' || h === 'se';
export const movesNorth = (h) => h === 'n' || h === 'ne' || h === 'nw';
export const movesSouth = (h) => h === 's' || h === 'se' || h === 'sw';
export const isResizeHandle = (h) => HANDLES.includes(h);

/**
 * Which handle a point inside (or just outside) a panel is on — null when it is on neither border.
 *
 * Coordinates are relative to the panel's own top-left, so this is testable without a browser and
 * is the same function whether it is asked about a pointer or about a hit rectangle.
 */
export function handleAt(x, y, w, h, { edge = EDGE_PX, corner = CORNER_PX, outset = OUTSET_PX } = {}) {
  if (x < -outset || y < -outset || x > w + outset || y > h + outset) return null;
  const west = x <= edge;
  const east = x >= w - edge;
  const north = y <= edge;
  const south = y >= h - edge;
  // Corners win over edges: inside the corner square the user means both axes, and an edge that
  // claimed the corner first would make diagonal resizing almost impossible to hit.
  const cWest = x <= corner, cEast = x >= w - corner;
  const cNorth = y <= corner, cSouth = y >= h - corner;
  if ((north || west) && cNorth && cWest) return 'nw';
  if ((north || east) && cNorth && cEast) return 'ne';
  if ((south || west) && cSouth && cWest) return 'sw';
  if ((south || east) && cSouth && cEast) return 'se';
  if (north) return 'n';
  if (south) return 's';
  if (west) return 'w';
  if (east) return 'e';
  return null;
}

/**
 * The delta a rectangle can actually accept, given the minimums.
 *
 * Returned rather than applied, so a shared border can ask BOTH panels what they will allow and act
 * on whichever is more restrictive — which is what stops one panel shoving its neighbour below its
 * own minimum.
 */
export function clampDelta(rect, handle, dx, dy, { minW, minH }) {
  let cx = dx, cy = dy;
  if (movesWest(handle)) cx = Math.min(cx, rect.w - minW);      // shrinking from the left
  if (movesEast(handle)) cx = Math.max(cx, minW - rect.w);      // shrinking from the right
  if (movesNorth(handle)) cy = Math.min(cy, rect.h - minH);
  if (movesSouth(handle)) cy = Math.max(cy, minH - rect.h);
  // The workspace starts at the origin; a panel cannot be dragged off its top or left.
  if (movesWest(handle)) cx = Math.max(cx, -rect.x);
  if (movesNorth(handle)) cy = Math.max(cy, -rect.y);
  if (!movesWest(handle) && !movesEast(handle)) cx = 0;
  if (!movesNorth(handle) && !movesSouth(handle)) cy = 0;
  return { dx: cx, dy: cy };
}

/** The rectangle after a resize. The delta is clamped first, so the far edges never drift. */
export function resizeRect(rect, handle, dx, dy, { minW, minH }) {
  const d = clampDelta(rect, handle, dx, dy, { minW, minH });
  const out = { ...rect };
  if (movesWest(handle)) { out.x = rect.x + d.dx; out.w = rect.w - d.dx; }
  if (movesEast(handle)) { out.w = rect.w + d.dx; }
  if (movesNorth(handle)) { out.y = rect.y + d.dy; out.h = rect.h - d.dy; }
  if (movesSouth(handle)) { out.h = rect.h + d.dy; }
  return out;
}

/** A panel moved, with the workspace origin as a floor. Unchanged in behaviour from before. */
export function moveRect(rect, dx, dy) {
  return { ...rect, x: Math.max(0, rect.x + dx), y: Math.max(0, rect.y + dy) };
}

/** The handle on the far side — what a neighbour presents to the edge you are dragging. */
const OPPOSITE = { e: 'w', w: 'e', n: 's', s: 'n' };

/** The one axis a handle resizes along, for adjacency purposes. Corners are matched on neither. */
const primaryAxis = (h) => (h === 'e' || h === 'w' ? h : (h === 'n' || h === 's' ? h : null));

/**
 * The panel sharing the border being dragged, if there is one.
 *
 * Two conditions, both required: the neighbour's OPPOSING edge sits within `tolerance` of the edge
 * under the pointer, and the two panels genuinely overlap along the run of that border. Without the
 * second test, a panel diagonally across the workspace whose left edge merely happened to line up
 * would be dragged about by a resize it has nothing to do with.
 *
 * Only the straight edges take part. A corner drags two axes at once, and resolving two neighbours
 * from one gesture is where a floating layout stops behaving predictably.
 */
export function findSharedEdge(id, layout, handle, { tolerance = 14, minOverlap = 24 } = {}) {
  const axis = primaryAxis(handle);
  if (!axis) return null;
  const me = layout?.[id];
  if (!me) return null;
  const want = OPPOSITE[axis];
  const myLine = axis === 'e' ? me.x + me.w : axis === 'w' ? me.x : axis === 's' ? me.y + me.h : me.y;
  let best = null;
  let bestGap = Infinity;
  for (const [otherId, r] of Object.entries(layout)) {
    if (otherId === id || !r) continue;
    const theirLine = want === 'e' ? r.x + r.w : want === 'w' ? r.x : want === 's' ? r.y + r.h : r.y;
    const gap = Math.abs(theirLine - myLine);
    if (gap > tolerance) continue;
    // The overlap along the shared run: vertical borders share a span of y, horizontal ones of x.
    const overlap = (axis === 'e' || axis === 'w')
      ? Math.min(me.y + me.h, r.y + r.h) - Math.max(me.y, r.y)
      : Math.min(me.x + me.w, r.x + r.w) - Math.max(me.x, r.x);
    if (overlap < minOverlap) continue;
    if (gap < bestGap) { bestGap = gap; best = { id: otherId, handle: want }; }
  }
  return best;
}

/**
 * One gesture applied to the layout: the panel being resized, and its neighbour when they share the
 * border.
 *
 * The delta is capped by BOTH panels before either is written, so a shared border stops at the first
 * minimum it meets rather than one panel quietly overrunning the other.
 */
export function applyResize(layout, id, handle, dx, dy, { minW, minH }, { shared = null } = {}) {
  const me = layout?.[id];
  if (!me) return layout;
  let d = clampDelta(me, handle, dx, dy, { minW, minH });
  const other = shared && layout[shared.id];
  if (other) {
    const od = clampDelta(other, shared.handle, d.dx, d.dy, { minW, minH });
    // Whichever panel gives less is what the border actually does — take the smaller magnitude on
    // each axis, keeping the sign, so the two edges stay welded together for the whole drag.
    d = {
      dx: Math.abs(od.dx) < Math.abs(d.dx) ? od.dx : d.dx,
      dy: Math.abs(od.dy) < Math.abs(d.dy) ? od.dy : d.dy,
    };
  }
  const next = { ...layout, [id]: resizeRect(me, handle, d.dx, d.dy, { minW, minH }) };
  if (other) next[shared.id] = resizeRect(other, shared.handle, d.dx, d.dy, { minW, minH });
  return next;
}

/**
 * The hit strips a frame renders, as plain boxes.
 *
 * Described here rather than in the component so the geometry — and the fact that every handle is
 * reachable — can be asserted without rendering anything. Values are CSS pixels relative to the
 * panel box; negative offsets reach into the gap between panels, which is why the frame is rendered
 * outside the card rather than inside its overflow:hidden.
 */
export function resizeStrips(w, h, { edge = EDGE_PX, corner = CORNER_PX, outset = OUTSET_PX } = {}) {
  const band = edge + outset;
  return [
    { handle: 'n', left: corner - outset, top: -outset, width: Math.max(0, w - (corner - outset) * 2), height: band },
    { handle: 's', left: corner - outset, top: h - edge, width: Math.max(0, w - (corner - outset) * 2), height: band },
    { handle: 'w', left: -outset, top: corner - outset, width: band, height: Math.max(0, h - (corner - outset) * 2) },
    { handle: 'e', left: w - edge, top: corner - outset, width: band, height: Math.max(0, h - (corner - outset) * 2) },
    { handle: 'nw', left: -outset, top: -outset, width: corner, height: corner },
    { handle: 'ne', left: w - corner + outset, top: -outset, width: corner, height: corner },
    { handle: 'sw', left: -outset, top: h - corner + outset, width: corner, height: corner },
    { handle: 'se', left: w - corner + outset, top: h - corner + outset, width: corner, height: corner },
  ];
}
