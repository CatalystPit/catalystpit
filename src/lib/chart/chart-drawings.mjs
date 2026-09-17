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
    shapes: [['line', { x1: 2.5, y1: 13, x2: 13.5, y2: 3 }]],
    // EXTENSION IS PER DRAWING, not per tool. One trend line can run to the right edge while the
    // next stops at its anchors, which is how a trader actually uses them — so the flags live on the
    // drawing and this reads them rather than the registry deciding for every line at once.
    segments: (pt, view, d) => {
      const a = d?.extendLeft ? extendRay(pt[1], pt[0], view) : pt[0];
      const b = d?.extendRight ? extendRay(pt[0], pt[1], view) : pt[1];
      return [[a, b]];
    },
    extendable: true,
  },
  ray: {
    id: 'ray', label: 'Ray', icon: '→', points: 2,
    shapes: [['line', { x1: 2.5, y1: 12, x2: 13.5, y2: 5 }], ['polyline', { points: '10.5,3.5 13.8,4.8 11.6,7.4' }]],
    // Extends past the second anchor to the right edge of the visible range. Recomputed from the
    // view on every paint, so it stays "infinite" however far the user scrolls.
    segments: (pt, view, d) => {
      const [a, b] = pt;
      const start = d?.extendLeft ? extendRay(b, a, view) : a;
      return [[start, extendRay(a, b, view)]];
    },
    extendable: true,
  },
  horizontal: {
    id: 'horizontal', label: 'Horizontal line', icon: '─', points: 1,
    shapes: [['line', { x1: 2, y1: 8, x2: 14, y2: 8 }], ['rect', { x: 7, y: 6.5, width: 3, height: 3, fill: true }]],
    segments: (p, view) => [[{ time: view.from, price: p[0].price }, { time: view.to, price: p[0].price }]],
    priceLabel: (p) => p[0].price,
  },
  vertical: {
    id: 'vertical', label: 'Vertical line', icon: '│', points: 1,
    shapes: [['line', { x1: 8, y1: 2, x2: 8, y2: 14 }], ['rect', { x: 6.5, y: 6.5, width: 3, height: 3, fill: true }]],
    segments: (p, view) => [[{ time: p[0].time, price: view.low }, { time: p[0].time, price: view.high }]],
  },
  rectangle: {
    id: 'rectangle', label: 'Rectangle', icon: '▭', points: 2,
    shapes: [['rect', { x: 2.5, y: 4, width: 11, height: 8, faint: true, fill: true }], ['rect', { x: 2.5, y: 4, width: 11, height: 8 }]],
    segments: (p) => {
      const [a, b] = p;
      const c1 = { time: a.time, price: a.price }, c2 = { time: b.time, price: a.price };
      const c3 = { time: b.time, price: b.price }, c4 = { time: a.time, price: b.price };
      return [[c1, c2], [c2, c3], [c3, c4], [c4, c1]];
    },
    fill: true,
  },
  text: {
    id: 'text', label: 'Text note', icon: 'T', points: 1,
    shapes: [
      ['line', { x1: 3, y1: 4, x2: 13, y2: 4 }],
      ['line', { x1: 8, y1: 4, x2: 8, y2: 13 }],
    ],
    // A note is an anchor and a string. It draws no segments; the renderer paints its text and the
    // hit test uses the anchor handle, which is why 'segments' returns nothing rather than faking a
    // zero-length line that would be invisible to click.
    segments: () => [],
    hasText: true,
  },
  measure: {
    id: 'measure', label: 'Measure', icon: '⇱', points: 2,
    shapes: [
      ['rect', { x: 2.5, y: 3.5, width: 11, height: 9, faint: true, fill: true }],
      ['line', { x1: 8, y1: 3.5, x2: 8, y2: 12.5 }],
      ['polyline', { points: '6,5.5 8,3.5 10,5.5' }],
      ['polyline', { points: '6,10.5 8,12.5 10,10.5' }],
    ],
    segments: (pt) => {
      const [a, b] = pt;
      const c1 = { time: a.time, price: a.price }, c2 = { time: b.time, price: a.price };
      const c3 = { time: b.time, price: b.price }, c4 = { time: a.time, price: b.price };
      return [[c1, c2], [c2, c3], [c3, c4], [c4, c1]];
    },
    fill: true,
    // TRANSIENT. A measurement answers a question and is then done with; TradingView's behaves the
    // same way. It is never persisted, never appears in the object tree, and the next click or
    // Escape clears it — which is why it must not go through createDrawing at all.
    transient: true,
  },
  fib: {
    id: 'fib', label: 'Fibonacci retracement', icon: '≡', points: 2,
    shapes: [
      ['line', { x1: 2, y1: 3.5, x2: 14, y2: 3.5 }],
      ['line', { x1: 2, y1: 7, x2: 14, y2: 7 }],
      ['line', { x1: 2, y1: 10.5, x2: 14, y2: 10.5 }],
      ['line', { x1: 2, y1: 14, x2: 14, y2: 14 }],
    ],
    // The conventional set. 0 and 1 are the anchors themselves, so the tool is read as "the move"
    // plus its retracement levels rather than as seven unrelated lines.
    ratios: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
    segments: (pt, view, d) => fibLevels(pt, d?.levels).map((l) => [
      { time: view.from, price: l.price }, { time: view.to, price: l.price },
    ]),
    levels: true,
    editableLevels: true,
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
  { id: 'lines', label: 'Lines', icon: '╱', tools: ['trend', 'ray', 'horizontal', 'vertical'],
    shapes: [['line', { x1: 2.5, y1: 13, x2: 13.5, y2: 3 }]] },
  { id: 'fib', label: 'Fibonacci', icon: '≡', tools: ['fib'],
    shapes: [['line', { x1: 2, y1: 4, x2: 14, y2: 4 }], ['line', { x1: 2, y1: 8, x2: 14, y2: 8 }], ['line', { x1: 2, y1: 12, x2: 14, y2: 12 }]] },
  { id: 'shapes', label: 'Shapes', icon: '▭', tools: ['rectangle'],
    shapes: [['rect', { x: 2.5, y: 4, width: 11, height: 8 }]] },
  // Declared for later. Rendered only once they have tools.
  { id: 'text', label: 'Text & notes', icon: 'T', tools: ['text'],
    shapes: [['line', { x1: 3, y1: 4, x2: 13, y2: 4 }], ['line', { x1: 8, y1: 4, x2: 8, y2: 13 }]] },
  { id: 'measure', label: 'Measure', icon: '⇱', tools: ['measure'],
    shapes: [['line', { x1: 8, y1: 3, x2: 8, y2: 13 }], ['polyline', { points: '5.5,5.5 8,3 10.5,5.5' }], ['polyline', { points: '5.5,10.5 8,13 10.5,10.5' }]] },
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

/** The conventional set, used when a drawing does not carry its own. */
export const DEFAULT_FIB_LEVELS = TOOLS.fib.ratios.map((ratio) => ({ ratio, visible: true }));

/**
 * A stored level list, made safe.
 *
 * Levels are user-editable and persisted, so they come back as anything at all. A ratio that is not
 * a finite number is dropped rather than repaired — a Fibonacci line at NaN draws nowhere and is
 * worse than a missing one. Duplicates are collapsed because two lines at the same price are one
 * line the user cannot select separately, and the result is sorted so the editor reads in order.
 */
export function sanitizeFibLevels(raw) {
  if (!Array.isArray(raw)) return DEFAULT_FIB_LEVELS.map((l) => ({ ...l }));
  const seen = new Set();
  const out = [];
  for (const l of raw) {
    const ratio = Number(typeof l === 'object' && l !== null ? l.ratio : l);
    if (!Number.isFinite(ratio)) continue;
    const key = ratio.toFixed(6);
    if (seen.has(key)) continue;
    seen.add(key);
    const obj = (typeof l === 'object' && l !== null) ? l : {};
    // A per-level colour is an INDEX into the theme palette, like every other colour in the chart,
    // and is optional: absent means "use the drawing's own colour", which is what keeps the default
    // appearance a single clean hue rather than a rainbow.
    const color = Number(obj.color);
    out.push({
      ratio,
      visible: obj.visible !== false,
      ...(Number.isFinite(color) ? { color: Math.max(0, Math.round(color)) } : {}),
    });
  }
  if (!out.length) return DEFAULT_FIB_LEVELS.map((l) => ({ ...l }));
  out.sort((x, y) => x.ratio - y.ratio);
  return out;
}

/**
 * The Fibonacci levels of a two-anchor move, from the second anchor back toward the first.
 *
 * Takes the DRAWING's own level list when it has one, so a user's set is what gets drawn; hidden
 * levels are left out here rather than at paint time, which keeps the renderer from having to know
 * what a level is.
 */
export function fibLevels(points, levels = null) {
  const [a, b] = points;
  if (!a || !b) return [];
  const span = a.price - b.price;
  const list = levels ? sanitizeFibLevels(levels) : DEFAULT_FIB_LEVELS;
  return list.filter((l) => l.visible !== false)
    .map((l) => ({ ratio: l.ratio, price: b.price + span * l.ratio, color: l.color }));
}

// ── measurement ──────────────────────────────────────────────────────────────

/** A time in bar-list form turned into milliseconds, or null when it cannot be. */
function timeMs(t) {
  if (typeof t === 'number') return t * 1000;              // UNIX seconds, the intraday shape
  if (typeof t === 'string') {                             // 'YYYY-MM-DD', the daily shape
    const ms = Date.parse(`${t}T00:00:00Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** A duration in the largest unit that still reads naturally. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return null;
  const abs = Math.abs(ms);
  const m = abs / 60000;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 31) return d < 10 ? `${d.toFixed(1)}d` : `${Math.round(d)}d`;
  const mo = d / 30.44;
  if (mo < 12) return `${mo.toFixed(1)}mo`;
  return `${(d / 365.25).toFixed(1)}y`;
}

/**
 * What a measurement between two anchors reports.
 *
 * Every field is derived from data the chart already has, and any field that CANNOT be derived is
 * null rather than zero — a measurement that quietly reports "0 bars" because it could not find the
 * anchors is worse than one that reports nothing.
 *
 *   change   the price difference, signed
 *   pct      that as a percentage OF THE FIRST ANCHOR, which is what "up 2%" means
 *   bars     how many bars lie between the anchors, by index, not by arithmetic on timestamps —
 *            weekends, holidays and half-days make any time-based bar count wrong
 *   ms       elapsed wall-clock time, which is a different and also useful question
 */
export function measureBetween(a, b, bars = []) {
  if (!a || !b) return null;
  const from = Number(a.price);
  const to = Number(b.price);
  const change = (Number.isFinite(from) && Number.isFinite(to)) ? to - from : null;
  // Percent is meaningless against a zero or missing base, so it is null rather than Infinity.
  const pct = (change != null && Number.isFinite(from) && from !== 0) ? (change / from) * 100 : null;

  const ia = bars.findIndex((x) => x.time === a.time);
  const ib = bars.findIndex((x) => x.time === b.time);
  const barCount = (ia >= 0 && ib >= 0) ? Math.abs(ib - ia) : null;

  const ma = timeMs(a.time);
  const mb = timeMs(b.time);
  const ms = (ma != null && mb != null) ? Math.abs(mb - ma) : null;

  return { change, pct, bars: barCount, ms, duration: formatDuration(ms), up: change == null ? null : change >= 0 };
}

// ── magnet ───────────────────────────────────────────────────────────────────
// SNAPPING IS A DRAWING BEHAVIOUR, NOT A CROSSHAIR ONE. The crosshair keeps following the pointer
// exactly as it does with magnet off; all that changes is where an ANCHOR lands when one is placed
// or dragged. That split is deliberate — a crosshair that jumps while you are only reading prices is
// the thing people turn magnet off to escape.

/** How near, in PIXELS, a candle level must be before it captures the anchor. */
export const MAGNET_PX = 12;

/** The levels one bar offers a magnet: its open, high, low and close, without duplicates. */
export function barLevels(bar) {
  if (!bar) return [];
  const out = [];
  for (const v of [bar.open, bar.high, bar.low, bar.close]) {
    const n = Number(v);
    if (Number.isFinite(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The level that captures the cursor, or null when none is near enough.
 *
 * Measured in PIXELS rather than in price, because "near enough to snap" is a thing the eye judges
 * on screen: a $0.05 tolerance is invisible on a zoomed-out five-year chart and enormous on a
 * one-minute one. Ties go to the first level, which is the order barLevels returns — open, high,
 * low, close — so the result is deterministic rather than dependent on iteration order.
 */
export function snapToLevel(cursorY, levels, tolerance = MAGNET_PX) {
  let best = null;
  let bestD = Infinity;
  for (const l of levels) {
    if (!l || !Number.isFinite(l.y) || !Number.isFinite(l.price)) continue;
    const d = Math.abs(l.y - cursorY);
    if (d < bestD) { bestD = d; best = l.price; }
  }
  return bestD <= tolerance ? best : null;
}

// ── z-order ──────────────────────────────────────────────────────────────────
// THERE IS NO SEPARATE ORDERING MODEL. The array IS the z-order: the renderer paints front to back
// through it, so the last element is on top, and hit testing already searches from the end so the
// drawing you see on top is the one you grab. Persistence stores the array as it is.
//
// That is why these are array moves and nothing else — a z-index field alongside the array would be
// a second source of truth, and the two would disagree the first time a drawing was deleted.

/** Move the drawing at `from` to `to`, clamped. Returns the same array when nothing would change. */
function moveIndex(list, from, to) {
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return list;
  const out = list.slice();
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item);
  return out;
}

/** 'front' | 'back' | 'forward' | 'backward' — the four moves every drawing program offers. */
export function reorderDrawing(drawings, id, where) {
  const list = Array.isArray(drawings) ? drawings : [];
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return list;
  if (where === 'front') return moveIndex(list, i, list.length - 1);
  if (where === 'back') return moveIndex(list, i, 0);
  if (where === 'forward') return moveIndex(list, i, i + 1);
  if (where === 'backward') return moveIndex(list, i, i - 1);
  return list;
}

/** Whether a move would actually do anything — so a control can disable itself honestly. */
export function canReorder(drawings, id, where) {
  const list = Array.isArray(drawings) ? drawings : [];
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return false;
  if (where === 'front' || where === 'forward') return i < list.length - 1;
  return i > 0;
}

// ── angle constraint ─────────────────────────────────────────────────────────

/**
 * Snap a segment to the nearest 45°, in SCREEN space.
 *
 * Screen space is the only space this makes sense in: "45 degrees" is a thing the eye judges against
 * the pixels it can see, and the same two anchors subtend a completely different angle once the
 * chart is zoomed. Snapping in price/time space would give a line that looks like any angle at all.
 *
 * Returns the constrained end point, in pixels, preserving the length along the chosen direction so
 * the line does not jump as it snaps.
 */
export function constrainAngle(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return { ...to };
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  // Project the drag onto the snapped direction, so a long drag stays long.
  const len = dx * Math.cos(angle) + dy * Math.sin(angle);
  return { x: from.x + Math.cos(angle) * len, y: from.y + Math.sin(angle) * len };
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

export function createDrawing(type, points, style = {}, existing = [], extra = {}) {
  const def = tool(type);
  if (!def || !Array.isArray(points) || points.length !== def.points) return null;
  if (points.some((p) => !p || !Number.isFinite(Number(p.price)) || p.time == null)) return null;
  // A transient tool answers a question rather than leaving something behind, so it never becomes a
  // stored drawing. Refusing here means no caller can persist one by accident.
  if (def.transient) return null;
  return {
    // Only a tool that declares text carries any: an arbitrary payload on every drawing would
    // round-trip through storage and become a place for junk to accumulate.
    ...(def.hasText ? { text: typeof extra.text === 'string' ? extra.text : '' } : {}),
    // Only a tool that CAN extend carries the flags, and only one with editable levels carries them;
    // an extendLeft on a rectangle would be a field nothing reads and everything has to preserve.
    ...(def.extendable ? { extendLeft: extra.extendLeft === true, extendRight: extra.extendRight === true } : {}),
    ...(def.editableLevels ? { levels: sanitizeFibLevels(extra.levels), fill: extra.fill === true } : {}),
    id: newDrawingId(type, existing),
    type,
    points: points.map((p) => ({ time: p.time, price: Number(p.price) })),
    style: sanitizeStyle(style),
    visible: true,
    locked: false,
  };
}

/**
 * A copy of a drawing, with a fresh id.
 *
 * DELIBERATELY IN PLACE, not nudged aside. A time offset can only be applied to a numeric time, and
 * daily bars carry a date STRING — the same reason moveDrawing refuses to shift those horizontally.
 * Offsetting only the ones it could would make clone mean two different things depending on the
 * timeframe, so it means one: an exact copy, which the caller then selects for the user to drag.
 * A clone is never born locked, or it could not be moved off the original.
 */
export function cloneDrawing(drawing, existing = []) {
  if (!drawing || !tool(drawing.type)) return null;
  return {
    ...drawing,
    id: newDrawingId(drawing.type, existing),
    points: drawing.points.map((pt) => ({ ...pt })),
    style: { ...drawing.style },
    locked: false,
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
  // A LOCK IS ENFORCED HERE, not only in the UI. Every drag, nudge and handle pull goes through this
  // one function, so refusing here means there is no path that can move a locked drawing by accident.
  if (drawing?.locked) return drawing;
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
    // Absent means unlocked: a stored drawing from before locks existed must stay movable.
    locked: raw?.locked === true,
    ...(def.hasText ? { text: typeof raw?.text === 'string' ? raw.text : '' } : {}),
    ...(def.extendable ? { extendLeft: raw?.extendLeft === true, extendRight: raw?.extendRight === true } : {}),
    ...(def.editableLevels ? { levels: sanitizeFibLevels(raw?.levels), fill: raw?.fill === true } : {}),
  };
}
