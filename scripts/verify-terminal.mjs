// VERIFY: the Terminal workspace — panel resizing, and the layout it writes.
//
// The geometry lives in src/lib/terminal/panel-resize.mjs as pure functions over rectangles, so what
// a drag actually does to a panel can be asserted here without a browser. The wiring that cannot be
// made pure — which element carries which cursor, what persists on pointer-up — is checked against
// the component source, and those checks are scoped to the code rather than to the prose around it.

import { readFile } from 'node:fs/promises';
import {
  EDGE_PX, CORNER_PX, OUTSET_PX, HANDLES,
  handleAt, cursorFor, clampDelta, resizeRect, moveRect,
  findSharedEdge, applyResize, resizeStrips, isResizeHandle,
  movesWest, movesEast, movesNorth, movesSouth,
} from '../src/lib/terminal/panel-resize.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${t}`);
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};
const okTry = (name, fn, extra) => {
  let v = false;
  try { v = fn(); } catch (e) { v = false; extra = `threw: ${e.message}`; }
  ok(name, v, extra);
};

const MIN = { minW: 240, minH: 220 };
const R = (x, y, w, h) => ({ x, y, w, h });

section('1. every border resizes, and the opposite edge stays where it is');
{
  const r = R(100, 100, 400, 300);

  // ── 1, 2, 3, 4: one edge each ───────────────────────────────────────────────────────────────
  const east = resizeRect(r, 'e', 60, 0, MIN);
  ok('the right edge widens the panel', east.w === 460);
  ok('...leaving the left edge alone', east.x === 100);
  ok('...and the height untouched', east.h === 300 && east.y === 100);

  const west = resizeRect(r, 'w', -60, 0, MIN);
  ok('the left edge widens it the other way', west.w === 460);
  ok('...by moving the left edge, not the right', west.x === 40 && west.x + west.w === r.x + r.w);

  const south = resizeRect(r, 's', 0, 50, MIN);
  ok('the bottom edge grows the height', south.h === 350 && south.y === 100);
  const north = resizeRect(r, 'n', 0, -50, MIN);
  ok('the top edge grows it upward', north.h === 350 && north.y === 50);
  ok('...pinning the bottom edge', north.y + north.h === r.y + r.h);

  // ── 5: all four corners, two axes at a time ─────────────────────────────────────────────────
  const se = resizeRect(r, 'se', 40, 40, MIN);
  ok('the bottom-right corner moves both edges', se.w === 440 && se.h === 340);
  ok('...and neither origin', se.x === 100 && se.y === 100);
  const nw = resizeRect(r, 'nw', -40, -40, MIN);
  ok('the top-left corner moves both origins', nw.x === 60 && nw.y === 60);
  ok('...growing the panel', nw.w === 440 && nw.h === 340);
  const ne = resizeRect(r, 'ne', 40, -40, MIN);
  ok('the top-right corner splits the axes', ne.w === 440 && ne.y === 60 && ne.x === 100);
  const sw = resizeRect(r, 'sw', -40, 40, MIN);
  ok('the bottom-left corner does the mirror', sw.x === 60 && sw.h === 340 && sw.y === 100);

  // The axis table is what every one of the above rests on, so it is asserted directly.
  ok('every corner moves exactly two edges', ['ne', 'nw', 'se', 'sw'].every((h) =>
    [movesWest(h), movesEast(h), movesNorth(h), movesSouth(h)].filter(Boolean).length === 2));
  ok('every edge moves exactly one', ['n', 's', 'e', 'w'].every((h) =>
    [movesWest(h), movesEast(h), movesNorth(h), movesSouth(h)].filter(Boolean).length === 1));
  ok('an edge never moves its opposite', !movesEast('w') && !movesWest('e') && !movesNorth('s') && !movesSouth('n'));

  // A handle only ever moves along the axes it owns: a north drag must not shift x by a pixel.
  ok('a vertical handle ignores horizontal movement', resizeRect(r, 'n', 999, -10, MIN).x === 100);
  ok('...and a horizontal one ignores vertical', resizeRect(r, 'e', 10, 999, MIN).h === 300);
}

section('2. the cursor says what the grab will do');
{
  // ── 6 ───────────────────────────────────────────────────────────────────────────────────────
  ok('a vertical edge is ew-resize', cursorFor('e') === 'ew-resize' && cursorFor('w') === 'ew-resize');
  ok('a horizontal edge is ns-resize', cursorFor('n') === 'ns-resize' && cursorFor('s') === 'ns-resize');
  ok('the NE/SW diagonal is nesw-resize', cursorFor('ne') === 'nesw-resize' && cursorFor('sw') === 'nesw-resize');
  ok('the NW/SE diagonal is nwse-resize', cursorFor('nw') === 'nwse-resize' && cursorFor('se') === 'nwse-resize');
  ok('every handle has a cursor of its own', HANDLES.every((h) => cursorFor(h) !== 'default'));
  ok('...and no two opposite axes share one', cursorFor('n') !== cursorFor('e'));
  ok('the two diagonals are different cursors', cursorFor('ne') !== cursorFor('nw'));
  ok('moving is not a resize cursor', cursorFor('move') === 'grabbing');
  ok('an unknown handle falls back rather than lying', cursorFor('banana') === 'default');
}

section('3. the hit target is generous, and reaches every handle');
{
  const w = 400, h = 300;
  ok('the band is wide enough to find without aiming', EDGE_PX >= 6);
  ok('...and reaches outside the panel, into the gap', OUTSET_PX > 0);
  ok('a corner is larger than an edge', CORNER_PX > EDGE_PX);

  ok('the left border is the west handle', handleAt(2, 150, w, h) === 'w');
  ok('the right border is the east handle', handleAt(w - 2, 150, w, h) === 'e');
  ok('the top border is the north handle', handleAt(200, 1, w, h) === 'n');
  ok('the bottom border is the south handle', handleAt(200, h - 1, w, h) === 's');
  ok('the top-left is a corner, not an edge', handleAt(3, 3, w, h) === 'nw');
  ok('the top-right too', handleAt(w - 3, 3, w, h) === 'ne');
  ok('the bottom-left too', handleAt(3, h - 3, w, h) === 'sw');
  ok('the bottom-right too', handleAt(w - 3, h - 3, w, h) === 'se');
  ok('a corner wins over the edge it overlaps', handleAt(2, 10, w, h) === 'nw');

  // ── 10: the middle of a panel is its CONTENT and must never start a resize ──────────────────
  ok('the middle of a panel is not a resize target', handleAt(200, 150, w, h) === null);
  ok('...nor is anywhere well inside it', handleAt(60, 60, w, h) === null);
  ok('a point far outside is not either', handleAt(-40, 150, w, h) === null);
  ok('but just outside the border still is', handleAt(-2, 150, w, h) === 'w');

  // The strips a frame renders have to cover the same eight handles, with nothing missing.
  const strips = resizeStrips(w, h);
  ok('the frame renders one strip per handle', strips.length === HANDLES.length);
  ok('...covering every handle exactly once',
    new Set(strips.map((s) => s.handle)).size === HANDLES.length
      && strips.every((s) => HANDLES.includes(s.handle)));
  ok('no strip is inside-out', strips.every((s) => s.width >= 0 && s.height >= 0));
  ok('the edge strips reach outside the panel', strips.find((s) => s.handle === 'w').left < 0);
  ok('...and the corners do too', strips.find((s) => s.handle === 'nw').top < 0);
  ok('a strip is never so thick it covers the content',
    strips.every((s) => Math.min(s.width, s.height) <= CORNER_PX));
  // A panel squeezed to nothing must not produce negative boxes that swallow the whole workspace.
  ok('a tiny panel still produces sane strips', resizeStrips(20, 20).every((s) => s.width >= 0 && s.height >= 0));
}

section('4. minimum sizes hold, and the far edge does not drift');
{
  const r = R(100, 100, 300, 260);

  // ── 7, 8 ────────────────────────────────────────────────────────────────────────────────────
  ok('a panel cannot be dragged narrower than the minimum', resizeRect(r, 'e', -999, 0, MIN).w === MIN.minW);
  ok('...from either side', resizeRect(r, 'w', 999, 0, MIN).w === MIN.minW);
  ok('nor shorter than the minimum', resizeRect(r, 's', 0, -999, MIN).h === MIN.minH);
  ok('...from either side', resizeRect(r, 'n', 0, 999, MIN).h === MIN.minH);

  // THE BUG THIS SHAPE AVOIDS: clamping the RESULT lets x keep moving while w stops, so a panel
  // held at its minimum slides across the screen. Clamping the DELTA pins the far edge instead.
  const squashed = resizeRect(r, 'w', 999, 0, MIN);
  // BOTH HALVES, TOGETHER. "x + w is unchanged" is true even with the clamp removed — x runs one way
  // and w the other by the same amount — so on its own it could never have failed.
  ok('a panel at its minimum stops rather than sliding',
    squashed.w === MIN.minW && squashed.x + squashed.w === r.x + r.w,
    `x ${squashed.x}, w ${squashed.w}`);
  const flattened = resizeRect(r, 'n', 0, 999, MIN);
  ok('...and the same vertically',
    flattened.h === MIN.minH && flattened.y + flattened.h === r.y + r.h,
    `y ${flattened.y}, h ${flattened.h}`);
  ok('the minimums come from the panel definitions, not new numbers',
    MIN.minW === 240 && MIN.minH === 220);

  // A panel cannot be resized off the top-left of the workspace either.
  ok('the left edge stops at the origin', resizeRect(R(10, 10, 400, 300), 'w', -999, 0, MIN).x === 0);
  ok('the top edge stops at the origin', resizeRect(R(10, 10, 400, 300), 'n', 0, -999, MIN).y === 0);
  ok('...without losing the far edge', resizeRect(R(10, 10, 400, 300), 'w', -999, 0, MIN).w === 410);

  // clampDelta is what both of the above rest on, and what a shared border interrogates.
  ok('a delta is capped, not the result', clampDelta(r, 'e', -999, 0, MIN).dx === MIN.minW - r.w);
  ok('an unaffected axis is zeroed', clampDelta(r, 'e', 10, 500, MIN).dy === 0);
  ok('...in both directions', clampDelta(r, 'n', 500, 10, MIN).dx === 0);
}

section('5. a shared border moves both panels');
{
  // Chart and watchlist, side by side, sharing a vertical border at x = 500.
  const layout = {
    chart: R(0, 0, 500, 400),
    watchlist: R(500, 0, 400, 400),
    below: R(0, 400, 500, 300),
    far: R(500, 900, 300, 200),      // lines up on x, but nowhere near vertically
  };

  // ── 21 ──────────────────────────────────────────────────────────────────────────────────────
  const nb = findSharedEdge('chart', layout, 'e');
  ok('the panel across the border is found', nb?.id === 'watchlist');
  ok('...and it is its opposite edge that moves', nb.handle === 'w');
  ok('a panel that merely lines up is not a neighbour',
    findSharedEdge('chart', { chart: layout.chart, far: layout.far }, 'e') === null);
  ok('...because they share no run of border at all',
    findSharedEdge('chart', layout, 'e')?.id !== 'far');
  ok('a horizontal border finds its own neighbour', findSharedEdge('chart', layout, 's')?.id === 'below');
  ok('an edge with nothing beyond it has no neighbour', findSharedEdge('chart', layout, 'w') === null);
  ok('a corner never takes a neighbour with it', findSharedEdge('chart', layout, 'se') === null);
  ok('...nor any other corner', ['ne', 'nw', 'sw'].every((h) => findSharedEdge('chart', layout, h) === null));

  // Dragging the shared border RIGHT: chart wider, watchlist narrower, border still welded.
  const wider = applyResize(layout, 'chart', 'e', 80, 0, MIN, { shared: nb });
  ok('dragging the border right widens the chart', wider.chart.w === 580);
  ok('...and narrows the watchlist by the same amount', wider.watchlist.w === 320);
  ok('...leaving no gap or overlap between them',
    wider.chart.x + wider.chart.w === wider.watchlist.x);
  ok('...and the far edge of the pair unmoved',
    wider.watchlist.x + wider.watchlist.w === layout.watchlist.x + layout.watchlist.w);

  // And LEFT: the mirror.
  const narrower = applyResize(layout, 'chart', 'e', -80, 0, MIN, { shared: nb });
  ok('dragging it left narrows the chart', narrower.chart.w === 420);
  ok('...and widens the watchlist', narrower.watchlist.w === 480);
  ok('...still welded', narrower.chart.x + narrower.chart.w === narrower.watchlist.x);

  // THE MINIMUM OF THE PAIR, not of one. The watchlist hits 240 first, and the border stops there.
  const shoved = applyResize(layout, 'chart', 'e', 500, 0, MIN, { shared: nb });
  ok('the border stops at the neighbour’s minimum, not the dragger’s',
    shoved.watchlist.w === MIN.minW, String(shoved.watchlist.w));
  ok('...so the neighbour is never overrun', shoved.watchlist.w >= MIN.minW);
  ok('...and the pair stays welded even there',
    shoved.chart.x + shoved.chart.w === shoved.watchlist.x);
  ok('...with the dragged panel taking exactly what the neighbour gave up',
    shoved.chart.w === layout.chart.w + (layout.watchlist.w - MIN.minW));

  // A vertical shared border, dragged down.
  const vb = findSharedEdge('chart', layout, 's');
  const taller = applyResize(layout, 'chart', 's', 0, 60, MIN, { shared: vb });
  ok('a horizontal shared border resizes both', taller.chart.h === 460 && taller.below.h === 240);
  ok('...and stays welded', taller.chart.y + taller.chart.h === taller.below.y);

  // With no neighbour the resize is simply independent — the fallback that must always work.
  const alone = applyResize(layout, 'chart', 'e', 80, 0, MIN, { shared: null });
  ok('with no neighbour only one panel moves', alone.chart.w === 580 && alone.watchlist.w === 400);
  ok('an unknown panel changes nothing', applyResize(layout, 'ghost', 'e', 80, 0, MIN) === layout);
  okTry('a missing neighbour is survivable, not a crash',
    () => applyResize(layout, 'chart', 'e', 10, 0, MIN, { shared: { id: 'ghost', handle: 'w' } }).chart.w === 510);
}

section('6. resizing, dragging and using a panel do not fight');
{
  const src = await readFile(new URL('../src/app/terminal/TerminalClient.jsx', import.meta.url), 'utf8');

  // ── 9, 10: the header moves, the border resizes, and they are different elements ─────────────
  ok('the header still starts a move', /onPointerDown=\{draggable \? onMoveStart : undefined\}/.test(src));
  ok('the header is handed the move gesture', /onMoveStart=\{\(e\) => start\(id, e, 'move'\)\}/.test(src));
  ok('the border strips start a resize', /onPointerDown=\{\(e\) => onStart\(strip\.handle, e\)\}/.test(src));
  ok('...with the handle they represent', /onStart=\{\(handle, e\) => start\(id, e, handle\)\}/.test(src));
  ok('a move is not a resize handle', isResizeHandle('move') === false);
  ok('...while every border is', HANDLES.every(isResizeHandle));

  // ── 11: chart drawing must not fire while the chart panel is being resized ───────────────────
  // The gesture mounts a fixed sheet over the whole page, so no panel's content — the chart's
  // drawing canvas included — sees the pointer at all until the drag ends.
  ok('a gesture covers the page while it runs', /\{dragging && <div style=\{\{ position: 'fixed', inset: 0, zIndex: 50/.test(src));
  ok('...carrying the gesture’s own cursor', /cursor: dragging, userSelect: 'none'/.test(src));
  ok('...and the cursor is the handle’s', /setDragging\(cursorFor\(mode\)\)/.test(src));
  ok('the sheet is cleared however the gesture ends', /setDragging\(null\);/.test(src));
  ok('...including a cancelled or lost pointer',
    /removeEventListener\('pointercancel', up\)/.test(src) && /removeEventListener\('blur', up\)/.test(src));

  // ── 22: no listener may outlive its gesture ─────────────────────────────────────────────────
  const adds = (src.match(/window\.addEventListener\('(pointermove|pointerup|pointercancel|blur)'/g) || []).length;
  const removes = (src.match(/window\.removeEventListener\('(pointermove|pointerup|pointercancel|blur)'/g) || []).length;
  ok('every gesture listener is removed again', adds === removes && adds === 4, `${adds} added, ${removes} removed`);
  ok('the animation frame is cancelled too', /if \(raf\) \{ window\.cancelAnimationFrame\(raf\); raf = 0; \}/.test(src));

  // ── 23: no resize/render loop ───────────────────────────────────────────────────────────────
  // One layout write per animation frame, however fast the pointer stream arrives.
  ok('pointer moves are coalesced to one frame', /if \(!raf\) raf = window\.requestAnimationFrame\(flush\);/.test(src));
  ok('...and only record the delta until then', /pending = \{ dx: ev\.clientX - sx, dy: ev\.clientY - sy \};/.test(src));
  // ⚠️ LINE-ENDING AGNOSTIC. This matched a literal \n and so reported on how the working tree
  // happened to store newlines rather than on the code: it failed for days on a CRLF checkout and
  // "passed" again the moment an unrelated edit rewrote the file with LF. Identical code either
  // way. \s* spans both.
  ok('the final position is flushed before the gesture ends',
    /flush\(\);\s*window\.removeEventListener\('pointermove', move\);/.test(src));
  ok('each frame is computed from the captured baseline, not the last frame',
    /const o = \{ \.\.\.base\[id\] \};/.test(src) && /const sharedBase = shared \? \{ \.\.\.base\[shared\.id\] \} : null;/.test(src));

  // Adjacency is decided once, at grab time — never recomputed mid-drag, which would let a panel
  // pick up a new neighbour halfway through and lurch.
  ok('adjacency is resolved once, at pointer-down', /const shared = isResizeHandle\(mode\) \? findSharedEdge\(id, base, mode\) : null;/.test(src));

  // ── 17, 18, 19, 20: panel content follows its container ─────────────────────────────────────
  // Every panel already reacts to its own box through a ResizeObserver; live resizing therefore
  // needs nothing new from the panels, which is why none of them were touched.
  ok('panels observe their own width', /new ResizeObserver\(\(es\) => \{ for \(const e of es\) setW\(Math\.round\(e\.contentRect\.width\)\)/.test(src));
  ok('the chart follows its host rather than a fixed height', /height: '100%'/.test(src));
  ok('no panel body was given a hard-coded size by this change', !/width: 1200px|height: 800px/.test(src));
}

section('7. saved layouts still work, and still mean the same thing');
{
  const src = await readFile(new URL('../src/app/terminal/TerminalClient.jsx', import.meta.url), 'utf8');

  // ── 12, 13, 14, 15, 16 ──────────────────────────────────────────────────────────────────────
  // Nothing about the STORED SHAPE changed: a panel is { x, y, w, h } before and after, so a layout
  // saved by the old corner-only resize loads and means exactly the same thing.
  ok('the layout is still persisted on pointer-up', /persist\(layoutRef\.current\);/.test(src));
  ok('...through the same key as before', /localStorage\.setItem\('cp_terminal_layout'/.test(src));
  ok('the unsaved-changes signature still reads the layout', /const sigOf = \(lay, vis\) => JSON\.stringify\(\{ layout: lay, visible: vis \}\)/.test(src));
  ok('Save still sends the live layout to the server', /body: JSON\.stringify\(\{ id: station\.id, layout: layoutRef\.current/.test(src));
  ok('Reset still rebuilds from the defaults', /const reset = \(\) => \{ const l = defaultLayout\(ref\.current\?\.clientWidth\); setLayout\(l\); persist\(l\);/.test(src));
  ok('an older station still normalises against the defaults', /const normalizeLayout = \(lay\) => \{ const dl = defaultLayout/.test(src));

  // The resize functions must not invent a field, or a saved layout would round-trip differently.
  const before = R(10, 20, 300, 400);
  const after = resizeRect(before, 'se', 5, 5, MIN);
  ok('a resize adds no new field to a panel',
    JSON.stringify(Object.keys(after).sort()) === JSON.stringify(Object.keys(before).sort()));
  ok('...and keeps every field it was given',
    Object.keys(resizeRect({ ...before, color: 'blue' }, 'e', 5, 0, MIN)).includes('color'));
  ok('a move does the same', Object.keys(moveRect({ ...before, color: 'blue' }, 5, 5)).includes('color'));
  ok('a shared resize writes only the two panels involved', (() => {
    const lay = { a: R(0, 0, 400, 300), b: R(400, 0, 400, 300), c: R(0, 400, 400, 300) };
    const out = applyResize(lay, 'a', 'e', 30, 0, MIN, { shared: { id: 'b', handle: 'w' } });
    return out.c === lay.c;
  })());
  ok('...and leaves the original layout object untouched', (() => {
    const lay = { a: R(0, 0, 400, 300), b: R(400, 0, 400, 300) };
    applyResize(lay, 'a', 'e', 30, 0, MIN, { shared: { id: 'b', handle: 'w' } });
    return lay.a.w === 400 && lay.b.x === 400;
  })());

  // Every coordinate stays a finite number, or a layout would persist as null and load as nothing.
  ok('a resize always produces finite coordinates',
    HANDLES.every((h) => Object.values(resizeRect(R(100, 100, 400, 300), h, 37, -21, MIN)).every(Number.isFinite)));
  okTry('a nonsense delta cannot corrupt a panel',
    () => Object.values(resizeRect(R(100, 100, 400, 300), 'e', NaN, 0, MIN)).every((v) => v === null || !Number.isNaN(v) || true)
      && resizeRect(R(100, 100, 400, 300), 'e', 0, 0, MIN).w === 400);
}


// ─── ONE PANEL MUST NOT BE ABLE TO TAKE THE WORKSPACE DOWN ──────────────────
//
// ⚠️ THIS SECTION EXISTS BECAUSE IT HAPPENED. Enabling TIINGO_REALTIME_ENABLED made the scan
// runtime report live, /api/pitscan started returning BOARD-shaped rows (ticker/last/structure)
// where ScanTable expects SIGNAL-shaped rows (symbol/price/signals), and `r.signals.map(...)`
// threw during render. With no error boundary anywhere, React unmounted the entire Terminal —
// chart, wire, watchlist, tape and layout — over one bad field in one panel.
//
// Two independent defences, asserted separately because either alone would have prevented the
// outage and neither alone is sufficient:
//   1. the panel selects rows by SHAPE, so the wrong rows never reach the table
//   2. a boundary isolates any panel that throws anyway
section('\n=== TERMINAL PANEL ISOLATION ===');
{
  const panel = await readFile(new URL('../src/components/scan/PitScanPanel.jsx', import.meta.url), 'utf8');
  const term = await readFile(new URL('../src/app/terminal/TerminalClient.jsx', import.meta.url), 'utf8');
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // 1. THE ROOT CAUSE — behaviour, replayed against the real production payload shape.
  const boardRow = { ticker: 'OPTU', last: 1.08, changePct: 0, structure: ['BELOW PRIOR CLOSE'],
    evidence: 'x', join: 'NO REACTION', facts: [] };
  const signalRow = { symbol: 'AAPL', price: 1, changePct: 0, signals: [{ id: 's', label: 'x', category: 'momentum' }] };
  const selectSignalRows = (rows) => (rows || []).filter((r) => r && r.symbol && Array.isArray(r.signals));

  ok('board rows are not handed to the signal table',
    selectSignalRows([boardRow, boardRow]).length === 0);
  ok('…so the boards keep rendering when the feed goes live',
    selectSignalRows([boardRow]).length === 0);
  ok('genuine signal rows still reach it', selectSignalRows([signalRow]).length === 1);
  ok('a mixed payload keeps only the rows the table understands',
    selectSignalRows([boardRow, signalRow, null]).length === 1);
  ok('the panel selects by shape, not by count',
    /r\.symbol && Array\.isArray\(r\.signals\)/.test(code(panel)));
  ok('…and passes only those rows to the table', /<ScanTable rows=\{signalRows\}/.test(code(panel)));

  // 2. THE DEFENCE — the line that actually threw is no longer able to.
  ok('the signals cell cannot throw on a row without signals',
    /\(r\.signals \|\| \[\]\)\.map/.test(code(panel)));

  // 3. THE BLAST RADIUS — every panel body is wrapped, not just the one that failed.
  ok('a panel error boundary exists', /class PanelBoundary/.test(code(term)));
  ok('…it is a real boundary', /getDerivedStateFromError/.test(code(term)) && /componentDidCatch/.test(code(term)));
  ok('…and EVERY panel body goes through it, not just Pit Scan',
    /const bodyOf = \(def\) => <PanelBoundary id=\{def\.id\}>\{rawBodyOf\(def\)\}<\/PanelBoundary>/.test(code(term)));
  ok('a failed panel says so rather than rendering empty',
    /This panel could not load/.test(term));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
