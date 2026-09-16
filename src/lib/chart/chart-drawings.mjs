// THE DRAWING MODEL.
//
// Pure geometry and state. No canvas, no React, no Lightweight Charts — which is what makes all of
// it testable without a browser, and what lets the renderer be replaced without touching the rules.
//
// COORDINATES ARE STORED IN DATA SPACE: every anchor is { time, price }, never a pixel. That single
// decision is why a drawing survives zooming, panning, resizing, a timeframe change and a page
// reload. Screen coordinates are derived at paint time and thrown away. Storing pixels would produce
// drawings that slide off their levels the moment the chart moves, which is the usual way this is
// got wrong.
//
// ADDING A TOOL is adding an entry to TOOLS: how many anchors it needs, how to turn those anchors
// into segments, and how to hit-test it. The toolbar, the renderer, the hit-tester and the store all
// read from that registry, so none of them changes.

/** @typedef {{ time: number|string, price: number }} Anchor */
/** @typedef {{ id: string, type: string, points: Anchor[], style: object, visible: boolean }} Drawing */

export const DEFAULT_STYLE = { color: 0, width: 2, dash: 'solid' };
export const LINE_WIDTHS = [1, 2, 3, 4];
export const LINE_DASHES = ['solid', 'dashed', 'dotted'];

/**
 * The tools.
 *
 * `points` is how many clicks it takes to place one. `segments(pts, view)` returns the straight
 * lines to stroke, in DATA space, given the visible range — that is how a ray and a horizontal line
 * extend to the edge of the chart without storing a second anchor that would move when the user
 * scrolls. `levels` marks a tool that also draws horizontal price levels (Fibonacci).
 */
export const TOOLS = {
  trend: {
    id: 'trend', label: 'Trend line', icon: '╱', points: 2,
    segments: (p) => [[p[0], p[1]]],
  },
  ray: {
    id: 'ray', label: 'Ray', icon: '→', points: 2,
    // Extends past the second anchor to the right edge of the visible range. Recomputed from the
    // view on every paint, so it stays "infinite" however far the user scrolls.
    segments: (p, view) => {
      const [a, b] = p;
      const end = extendRay(a, b, view);
      return [[a, end]];
    },
  },
  horizontal: {
    id: 'horizontal', label: 'Horizontal line', icon: '─', points: 1,
    segments: (p, view) => [[{ time: view.from, price: p[0].price }, { time: view.to, price: p[0].price }]],
    priceLabel: (p) => p[0].price,
  },
  vertical: {
    id: 'vertical', label: 'Vertical line', icon: '│', points: 1,
    segments: (p, view) => [[{ time: p[0].time, price: view.low }, { time: p[0].time, price: view.high }]],
  },
  rectangle: {
    id: 'rectangle', label: 'Rectangle', icon: '▭', points: 2,
    segments: (p) => {
      const [a, b] = p;
      const c1 = { time: a.time, price: a.price }, c2 = { time: b.time, price: a.price };
      const c3 = { time: b.time, price: b.price }, c4 = { time: a.time, price: b.price };
      return [[c1, c2], [c2, c3], [c3, c4], [c4, c1]];
    },
    fill: true,
  },
  fib: {
    id: 'fib', label: 'Fibonacci retracement', icon: '≡', points: 2,
    // The conventional set. 0 and 1 are the anchors themselves, so the tool is read as "the move"
    // plus its retracement levels rather than as seven unrelated lines.
    ratios: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
    segments: (p, view) => fibLevels(p).map((l) => [
      { time: view.from, price: l.price }, { time: view.to, price: l.price },
    ]),
    levels: true,
  },
};

export const TOOL_IDS = Object.keys(TOOLS);
export const tool = (id) => TOOLS[id] || null;

// ── categories ───────────────────────────────────────────────────────────────
// ONE RAIL BUTTON PER CATEGORY, not per tool. Six tools already crowd a narrow panel and the list
// is going to grow; a category button that remembers the last tool chosen from it keeps the rail a
// fixed height however many tools exist.
//
// Categories with no tools yet are declared but not rendered, so the roadmap is visible in the code
// without putting an empty button on the chart.

export const TOOL_CATEGORIES = [
  { id: 'lines', label: 'Lines', icon: '╱', tools: ['trend', 'ray', 'horizontal', 'vertical'] },
  { id: 'fib', label: 'Fibonacci', icon: '≡', tools: ['fib'] },
  { id: 'shapes', label: 'Shapes', icon: '▭', tools: ['rectangle'] },
  // Declared for later. Rendered only once they have tools.
  { id: 'text', label: 'Text & notes', icon: 'T', tools: [] },
  { id: 'measure', label: 'Measure', icon: '⇱', tools: [] },
];

/** Only the categories that actually have something in them. */
export const activeCategories = () => TOOL_CATEGORIES.filter((c) => c.tools.some((t) => !!TOOLS[t]));

/** Which category a tool belongs to — used to light up the right rail button. */
export function categoryOfTool(toolId) {
  return TOOL_CATEGORIES.find((c) => c.tools.includes(toolId)) || null;
}

/** Where a ray leaves the visible window. Null view means "stop at the second anchor". */
export function extendRay(a, b, view) {
  if (!view || typeof a.time !== 'number' || typeof b.time !== 'number') return b;
  const dt = b.time - a.time;
  if (dt === 0) return { time: b.time, price: view.high };      // straight up: clamp to the top
  const slope = (b.price - a.price) / dt;
  const edge = dt > 0 ? view.to : view.from;
  if (typeof edge !== 'number') return b;
  return { time: edge, price: a.price + slope * (edge - a.time) };
}

/** The Fibonacci levels of a two-anchor move, from the second anchor back toward the first. */
export function fibLevels(points) {
  const [a, b] = points;
  if (!a || !b) return [];
  const span = a.price - b.price;
  return TOOLS.fib.ratios.map((r) => ({ ratio: r, price: b.price + span * r }));
}

// ── hit testing ──────────────────────────────────────────────────────────────
// Done in SCREEN space, because "near enough to click" is a pixel judgement: eight pixels is eight
// pixels whether the chart is showing a day or five years.

/** Distance from point p to the segment ab, all in pixels. */
export function distanceToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export const HIT_TOLERANCE = 7;
export const HANDLE_RADIUS = 5;

/**
 * Which drawing is under the cursor, and whether the cursor is on one of its handles.
 *
 * Searched newest-first so the drawing on top is the one you grab, which is what clicking a stack
 * should do. Handles win over the body: dragging an endpoint is a different intent from moving the
 * whole shape, and the endpoint is the smaller target.
 */
export function hitTest(screenPoint, projected, { tolerance = HIT_TOLERANCE } = {}) {
  for (let i = projected.length - 1; i >= 0; i -= 1) {
    const d = projected[i];
    if (!d || d.visible === false) continue;
    for (let h = 0; h < d.handles.length; h += 1) {
      if (Math.hypot(screenPoint.x - d.handles[h].x, screenPoint.y - d.handles[h].y) <= HANDLE_RADIUS + 3) {
        return { id: d.id, handle: h };
      }
    }
    for (const [a, b] of d.segments) {
      if (distanceToSegment(screenPoint, a, b) <= tolerance) return { id: d.id, handle: null };
    }
  }
  return null;
}

// ── mutation ─────────────────────────────────────────────────────────────────

let seq = 0;
/** Deterministic enough to test, unique enough to key on. */
export function newDrawingId(type, existing = []) {
  const used = new Set(existing.map((d) => d.id));
  for (let n = 1; n <= 9999; n += 1) {
    const id = `${type}-${n}`;
    if (!used.has(id)) return id;
  }
  seq += 1;
  return `${type}-x${seq}`;
}

export function createDrawing(type, points, style = {}, existing = []) {
  const def = tool(type);
  if (!def || !Array.isArray(points) || points.length !== def.points) return null;
  if (points.some((p) => !p || !Number.isFinite(Number(p.price)) || p.time == null)) return null;
  return {
    id: newDrawingId(type, existing),
    type,
    points: points.map((p) => ({ time: p.time, price: Number(p.price) })),
    style: sanitizeStyle(style),
    visible: true,
  };
}

/** Styles are persisted and user-editable, so they arrive as anything at all. */
export function sanitizeStyle(raw) {
  const color = Number(raw?.color);
  const width = Number(raw?.width);
  return {
    // A palette INDEX, not hex — the chart has two themes and a fixed colour is unreadable in one.
    color: Number.isFinite(color) ? Math.max(0, Math.round(color)) : DEFAULT_STYLE.color,
    width: LINE_WIDTHS.includes(width) ? width : DEFAULT_STYLE.width,
    dash: LINE_DASHES.includes(raw?.dash) ? raw.dash : DEFAULT_STYLE.dash,
  };
}

/**
 * Move a whole drawing, or one of its anchors, by a delta in DATA space.
 *
 * The caller converts a pixel drag into a time/price delta, because only it knows the scales. Doing
 * it that way keeps this function pure and means a drag behaves identically at any zoom level.
 */
export function moveDrawing(drawing, { dTime = 0, dPrice = 0 }, handle = null) {
  const shift = (p) => ({
    // A date-string time (daily bars) cannot have a numeric delta added to it, so those drawings
    // move vertically only. Snapping to a bar is the caller's job; this refuses to invent a date.
    time: typeof p.time === 'number' ? p.time + dTime : p.time,
    price: p.price + dPrice,
  });
  const points = handle == null
    ? drawing.points.map(shift)
    : drawing.points.map((p, i) => (i === handle ? shift(p) : p));
  return { ...drawing, points };
}

// ── serialisation ────────────────────────────────────────────────────────────

/** Drop anything that cannot be drawn. A stored drawing whose tool no longer exists is not repaired. */
export function coerceDrawing(raw, existing = []) {
  const type = typeof raw?.type === 'string' ? raw.type : null;
  const def = type ? tool(type) : null;
  if (!def) return null;
  const pts = Array.isArray(raw?.points) ? raw.points : [];
  if (pts.length !== def.points) return null;
  const points = [];
  for (const p of pts) {
    const price = Number(p?.price);
    if (!Number.isFinite(price) || p?.time == null) return null;
    points.push({ time: p.time, price });
  }
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : newDrawingId(type, existing),
    type,
    points,
    style: sanitizeStyle(raw?.style),
    visible: raw?.visible !== false,
  };
}
