// DOES A HORIZONTAL LINE READ OUT ITS PRICE, AND KEEP IT?
//
//   node scripts/verify-price-axis-labels.mjs
//
// Two features and one invariant:
//
//   THE LIVE READOUT   while the horizontal tool is armed, the price under the cursor is on the axis
//   THE PERSISTENT CHIP  a placed line carries its own price on the axis, and keeps it
//   THE INVARIANT      market coordinates are state, screen coordinates are derived — so changing the
//                      view may move the PIXELS and must never move the PRICE
//
// ⚠️ HOW THE INVARIANT IS ACTUALLY TESTED. A fake series carries a price<->coordinate mapping this
// file can change at will, which is what "zoom", "rescale", "autoscale" and "resize" all are from a
// drawing's point of view: the same price lands on a different pixel. Asserting the stored price
// while the mapping moves underneath is the only way to catch a drawing that secretly holds a pixel —
// a test that merely re-reads the drawing after calling a zoom method proves nothing, because a
// broken implementation and a correct one both return the number they stored.
//
// The real DrawingLayer is mounted and driven with real pointer events. Lightweight Charts is faked,
// not the component: the thing under test is our conversion, storage and reconciliation.

import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  axisLabelSpecs, reconcileAxisLabels, priceLineOptionsFor, readableTextOn, luminance, sameSpec,
  priceInPlot,
} from '../src/lib/chart/price-axis-labels.mjs';
import { tool, createDrawing, moveDrawing } from '../src/lib/chart/chart-drawings.mjs';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const near = (a, b, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < eps;

// ── 1. the label derives from the drawing, never from a pixel ──────────────────────────────────
console.log('\n1. the label derives from the drawing, never from a pixel');

const hline = (id, price, color = 0) => ({
  id, type: 'horizontal', points: [{ time: 1700000000, price }],
  style: { color, width: 2, dash: 'solid' }, visible: true, locked: false, label: '',
});

const specs = axisLabelSpecs([hline('h1', 220.37)], tool, { colorOf: () => '#1A3A78' });
ok('a horizontal line produces one axis label', specs.length === 1);
ok('...carrying the drawing\'s exact stored price', specs[0].price === 220.37, String(specs[0]?.price));
// ⚠️ THE SAME NUMBER, NOT A ROUNDED ONE. The chip is formatted by the price scale at paint time; a
// price rounded on the way in would make the chip and the line disagree by a tick.
const odd = axisLabelSpecs([hline('h1', 7787.754321)], tool, { colorOf: () => '#1A3A78' });
ok('...to full precision, unrounded', odd[0].price === 7787.754321, String(odd[0]?.price));

// Only tools that ARE a price get one. A trend line has two prices and neither is its value.
for (const type of ['trend', 'ray', 'rectangle', 'vertical', 'text']) {
  const def = tool(type);
  const pts = Array.from({ length: def.points }, (_, i) => ({ time: 1700000000 + i * 60, price: 100 + i }));
  const made = { id: 't', type, points: pts, style: { color: 0, width: 2, dash: 'solid' }, visible: true };
  ok(`a ${type} gets no price chip`, axisLabelSpecs([made], tool, { colorOf: () => '#000000' }).length === 0);
}

// A hidden drawing, and a hidden layer, must not leave a chip on the axis for a line nobody can see.
ok('a hidden drawing has no chip',
  axisLabelSpecs([{ ...hline('h1', 220), visible: false }], tool, { colorOf: () => '#000' }).length === 0);
ok('a hidden drawing layer has no chips',
  axisLabelSpecs([hline('h1', 220)], tool, { colorOf: () => '#000', visible: false }).length === 0);

// ── 2. the chip is readable in both themes ─────────────────────────────────────────────────────
console.log('\n2. the chip is readable in both themes');

// The two palettes run in OPPOSITE directions — light-theme drawing colours are dark, dark-theme ones
// are light — so one fixed text colour would be unreadable in one of them.
const LIGHT = ['#1A3A78', '#7A5818', '#7B3F98', '#2A7848', '#B4530A', '#0F6E6E'];
const DARK = ['#6FA8FF', '#E0B84A', '#C08CE0', '#4FB37C', '#F0913F', '#4FC5C5'];
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
for (const c of LIGHT) {
  ok(`light-theme chip ${c} gets readable text`, contrast(c, readableTextOn(c)) >= 4.5,
    `contrast ${contrast(c, readableTextOn(c)).toFixed(2)}:1 with ${readableTextOn(c)}`);
}
for (const c of DARK) {
  ok(`dark-theme chip ${c} gets readable text`, contrast(c, readableTextOn(c)) >= 4.5,
    `contrast ${contrast(c, readableTextOn(c)).toFixed(2)}:1 with ${readableTextOn(c)}`);
}
// And the two palettes really do resolve differently, or the rule above is untested.
ok('the rule actually discriminates between the palettes',
  new Set([...LIGHT, ...DARK].map(readableTextOn)).size === 2);

// ── 3. the native price line contributes the chip and NOT a line ───────────────────────────────
console.log('\n3. the native price line contributes the chip and NOT a line');

const opt = priceLineOptionsFor({ id: 'h1', price: 220.37, color: '#1A3A78', textColor: '#FFFFFF' });
ok('the axis label is switched on', opt.axisLabelVisible === true);
// ⚠️ THE CRITICAL ONE. Our canvas already strokes the line with its own width, dash and extension. A
// visible native line would double-stroke every level, and the second copy could not be selected or
// dragged because it is not ours.
ok('the native LINE is switched off, so the canvas stays the only one drawing it',
  opt.lineVisible === false);
ok('the chip is filled with the line\'s own colour', opt.axisLabelColor === '#1A3A78');
// A title is painted on the PANE, over the candles. The chip on the axis is the point.
ok('no title is painted over the candles', opt.title === '');
// ⚠️ NOTHING FORMATS THE PRICE HERE. The price scale formats the chip with the series' own formatter,
// which is how a four-decimal instrument works without a decimal count being hard-coded anywhere.
ok('the price is passed as a raw number for the scale to format',
  typeof opt.price === 'number' && opt.price === 220.37);
const src = fs.readFileSync(path.join(ROOT, 'src/lib/chart/price-axis-labels.mjs'), 'utf8');
ok('the label module formats no prices itself',
  !/toFixed\(/.test(src) && !/toPrecision\(/.test(src));

// ── 4. reconciliation: created once, updated in place, never rebuilt ──────────────────────────
console.log('\n4. reconciliation: created once, updated in place, never rebuilt');

const fakeAdapter = () => {
  const log = [];
  let n = 0;
  return {
    log,
    create: (spec) => { log.push(['create', spec.price]); return { id: `pl${n += 1}`, opts: { ...spec } }; },
    update: (h, spec) => { log.push(['update', spec.price]); h.opts = { ...spec }; },
    remove: (h) => { log.push(['remove', h.id]); },
  };
};

{
  const a = fakeAdapter();
  let map = new Map();
  const three = [hline('a', 100), hline('b', 200), hline('c', 300)];
  map = reconcileAxisLabels(map, axisLabelSpecs(three, tool, { colorOf: () => '#1A3A78' }), a);
  ok('three lines produce three chips', map.size === 3);
  ok('...one create each', a.log.filter((l) => l[0] === 'create').length === 3);

  // ⚠️ AN IDENTICAL PASS MUST DO NOTHING. A repaint happens on every crosshair move; recreating the
  // chips each time makes them blink, and would also mean selecting one line disturbs the others.
  a.log.length = 0;
  map = reconcileAxisLabels(map, axisLabelSpecs(three, tool, { colorOf: () => '#1A3A78' }), a);
  ok('an unchanged pass touches nothing', a.log.length === 0, JSON.stringify(a.log));
  ok('...and keeps all three chips', map.size === 3);

  // Moving ONE line updates ONE chip, in place, and leaves the other two alone.
  a.log.length = 0;
  const moved = [hline('a', 100), { ...hline('b', 0), points: [{ time: 1700000000, price: 581.17 }] }, hline('c', 300)];
  map = reconcileAxisLabels(map, axisLabelSpecs(moved, tool, { colorOf: () => '#1A3A78' }), a);
  ok('moving one line updates exactly one chip',
    a.log.length === 1 && a.log[0][0] === 'update' && a.log[0][1] === 581.17, JSON.stringify(a.log));
  ok('...in place, so the price line is not recreated',
    a.log.every((l) => l[0] !== 'create' && l[0] !== 'remove'));
  ok('...and the other two chips are untouched', map.size === 3);

  // Deleting one line removes exactly its chip.
  a.log.length = 0;
  map = reconcileAxisLabels(map, axisLabelSpecs([hline('a', 100), hline('c', 300)], tool, { colorOf: () => '#1A3A78' }), a);
  ok('deleting a line removes exactly its chip',
    a.log.length === 1 && a.log[0][0] === 'remove', JSON.stringify(a.log));
  ok('...leaving the rest', map.size === 2);

  // A colour change is a chip change, because the chip is filled with the line's colour.
  a.log.length = 0;
  map = reconcileAxisLabels(map, axisLabelSpecs([hline('a', 100), hline('c', 300)], tool, { colorOf: () => '#7A5818' }), a);
  ok('a restyle updates the chips', a.log.filter((l) => l[0] === 'update').length === 2);
}

// A create that throws must not take the chart down, and must not poison the map.
{
  const a = fakeAdapter();
  a.create = () => { throw new Error('price scale gone'); };
  const map = reconcileAxisLabels(new Map(), axisLabelSpecs([hline('a', 100)], tool, { colorOf: () => '#000' }), a);
  ok('a chip that cannot be created is skipped, not thrown', map.size === 0);
}

// ── 5. the real layer, against a scale that moves ──────────────────────────────────────────────
console.log('\n5. the real layer, against a scale that moves');

const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-axis');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const out = path.join(TMP, 'DrawingLayer.mjs');
await build({
  entryPoints: [path.join(ROOT, 'src/components/chart/DrawingLayer.jsx')],
  bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  logLevel: 'silent', absWorkingDir: ROOT,
});

const BARS = Array.from({ length: 120 }, (_, i) => ({
  time: 1700000000 + i * 60, open: 220, high: 221, low: 219, close: 220.5,
}));
const PLOT_H = 400, PLOT_W = 800;

/**
 * A fake chart whose price<->coordinate mapping this test OWNS.
 *
 * `zoomTo(high, low)` is every view change a drawing can experience — wheel zoom, a price-scale drag,
 * autoscale, a resize — expressed as what they all are underneath: the same price now lands on a
 * different pixel. Linear on purpose; the library's own mapping is not what is under test.
 */
function fakeChart() {
  // ⚠️ DELIBERATELY NOT ROUND. A scale of 240..200 over 400px maps every integer pixel to exactly one
  // decimal, so a bug that rounded a stored price to 2dp changed nothing at the probe pixel and went
  // undetected. These bounds give prices with many decimals, which is also what a real instrument does.
  const view = { high: 241.37, low: 199.11 };
  const priceLines = [];
  const crosshair = [];
  const ranges = [];
  const priceToCoordinate = (price) =>
    ((view.high - price) / (view.high - view.low)) * PLOT_H;
  const coordinateToPrice = (y) => view.high - (y / PLOT_H) * (view.high - view.low);
  const series = {
    priceToCoordinate, coordinateToPrice,
    createPriceLine: (o) => {
      const h = { o: { ...o }, applyOptions(next) { Object.assign(this.o, next); } };
      priceLines.push(h); return h;
    },
    removePriceLine: (h) => {
      const i = priceLines.indexOf(h);
      if (i >= 0) priceLines.splice(i, 1);
    },
  };
  const crosshairSubs = [];
  const chart = {
    // ⚠️ THE ONLY HOOK AVAILABLE FOR A VERTICAL RESCALE. The library has subscriptions for the time
    // range, clicks, the crosshair and size — and none for the price scale. Dragging the price axis
    // therefore moves every price on the chart silently, so the component watches the crosshair and
    // re-checks the top and bottom of the plot. Modelled here so that path is actually testable.
    subscribeCrosshairMove: (fn) => crosshairSubs.push(fn),
    unsubscribeCrosshairMove: (fn) => {
      const i = crosshairSubs.indexOf(fn);
      if (i >= 0) crosshairSubs.splice(i, 1);
    },
    timeScale: () => ({
      width: () => PLOT_W,
      height: () => 28,
      coordinateToLogical: (x) => (x / PLOT_W) * (BARS.length - 1),
      logicalToCoordinate: (l) => (l / (BARS.length - 1)) * PLOT_W,
      timeToCoordinate: (t) => {
        const i = BARS.findIndex((b) => b.time === t);
        return i < 0 ? null : (i / (BARS.length - 1)) * PLOT_W;
      },
      getVisibleLogicalRange: () => ({ from: 0, to: BARS.length - 1 }),
      subscribeVisibleLogicalRangeChange: (fn) => ranges.push(fn),
      unsubscribeVisibleLogicalRangeChange: () => {},
    }),
    subscribeClick: () => {}, unsubscribeClick: () => {},
    setCrosshairPosition: (price, time, s) => crosshair.push({ price, time, series: s }),
    clearCrosshairPosition: () => crosshair.push(null),
  };
  return { chart, series, view, priceLines, crosshair, ranges, crosshairSubs,
    priceToCoordinate, coordinateToPrice,
    /** A pointer moving over the chart, which is what a price-scale drag looks like. */
    fireCrosshair: () => crosshairSubs.forEach((fn) => fn({ point: { x: 10, y: 10 } })) };
}

function makeDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'https://catalystpit.test/', pretendToBeVisual: true });
  const { window } = dom;
  // jsdom has no 2D context, and paint() would throw on the first frame. A recording stub keeps the
  // component's real paint path running — what is under test is the coordinates, not the pixels.
  window.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fill() {}, fillRect() {}, strokeRect() {}, arc() {}, closePath() {}, setLineDash() {},
    fillText() {}, measureText: () => ({ width: 30 }), roundRect() {}, rect() {}, clip() {}, ellipse() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', { value: PLOT_W, configurable: true });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientHeight', { value: PLOT_H + 28, configurable: true });
  window.HTMLCanvasElement.prototype.getBoundingClientRect = function rect() {
    return { left: 0, top: 0, right: PLOT_W, bottom: PLOT_H + 28, width: PLOT_W, height: PLOT_H + 28, x: 0, y: 0 };
  };
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'Event', 'PointerEvent',
    'devicePixelRatio']) {
    try { globalThis[k] = window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
  }
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

const dom = makeDom();
const { act } = await import('react');
const ReactDOMClient = await import('react-dom/client');
const DrawingLayer = (await import(pathToFileURL(out).href)).default;

const fc = fakeChart();
let drawings = [];
let selectedIds = [];
const onChange = (next) => { drawings = typeof next === 'function' ? next(drawings) : next; };

const container = dom.window.document.getElementById('root');
let mountError = null;
const root = ReactDOMClient.createRoot(container, { onUncaughtError: (e) => { mountError = mountError || e; } });

let activeTool = null;
const render = async () => {
  await act(async () => {
    root.render(React.createElement(DrawingLayer, {
      chart: fc.chart, series: fc.series, theme: 'light', symbol: 'NVDA', bars: BARS,
      drawings, onChange, activeTool, onToolUsed: () => { activeTool = null; },
      selectedIds, onSelect: (id) => { selectedIds = id ? [id] : []; },
      visible: true, style: { color: 0, width: 2, dash: 'solid' }, magnet: false,
      clearSignal: 0, toolDefaults: null,
      onRequestText: () => {}, onOpenSettings: () => {}, onSelectionBox: () => {},
    }));
  });
};

await render();
ok('the drawing layer mounts against the fake chart', !mountError,
  mountError ? `${mountError.name}: ${mountError.message}` : '');

const canvas = container.querySelector('canvas[data-cp-drawings]');
ok('the drawing canvas is present', !!canvas);

const pointer = async (type, y, x = 400) => {
  await act(async () => {
    const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, shiftKey: false });
    canvas.dispatchEvent(ev);
  });
};

// ── 6. the live readout follows the cursor ─────────────────────────────────────────────────────
console.log('\n6. the live readout follows the cursor');

activeTool = 'horizontal';
await render();
fc.crosshair.length = 0;

// Three heights, three prices, read off the SAME conversion the chart uses.
const probes = [100, 200, 317];
for (const y of probes) {
  await pointer('pointermove', y);
}
ok('a pointer move with the tool armed puts a price on the axis', fc.crosshair.length >= probes.length,
  `${fc.crosshair.length} crosshair updates`);
const got = fc.crosshair.filter(Boolean).map((c) => c.price);
for (const y of probes) {
  const want = fc.coordinateToPrice(y);
  ok(`cursor at y=${y} reads out ${want}`, got.some((p) => near(p, want)),
    `got ${JSON.stringify(got)}`);
}
// ⚠️ IT IS THE CHART'S OWN CONVERSION, not arithmetic of ours. The readout must change when the
// mapping changes even for the SAME pixel — a hard-coded or cached scale would keep the old number.
fc.crosshair.length = 0;
const beforeZoom = fc.coordinateToPrice(200);
fc.view.high = 1000; fc.view.low = 0;
await pointer('pointermove', 200);
const afterZoom = fc.crosshair.filter(Boolean).map((c) => c.price);
ok('the same pixel reads a different price after a rescale',
  afterZoom.some((p) => near(p, fc.coordinateToPrice(200))) && !near(beforeZoom, fc.coordinateToPrice(200)),
  `before ${beforeZoom}, after ${JSON.stringify(afterZoom)}`);
// The readout is attached to OUR price series, not to some other scale.
ok('the readout is placed against the price series', fc.crosshair.filter(Boolean).every((c) => c.series === fc.series));
fc.view.high = 241.37; fc.view.low = 199.11;

// Putting the tool down ends the preview.
fc.crosshair.length = 0;
activeTool = null;
await render();
ok('disarming the tool clears the preview', fc.crosshair.includes(null));

// ── 7. clicking freezes that exact price ───────────────────────────────────────────────────────
console.log('\n7. clicking freezes that exact price');

activeTool = 'horizontal';
await render();
const CLICK_Y = 137;
const EXPECTED = fc.coordinateToPrice(CLICK_Y);
fc.crosshair.length = 0;
await pointer('pointermove', CLICK_Y);
await pointer('pointerdown', CLICK_Y);
// ⚠️ CHECKED BEFORE THE RE-RENDER, ON PURPOSE. Disarming the tool also clears the preview, so a test
// that re-renders first cannot tell whether the COMMIT cleared it or the disarm did — and the
// mutation that removed the commit-time clear passed. Nothing has re-rendered at this point, so the
// only thing that can have cleared it is the commit itself.
ok('committing the line clears the preview immediately, before any re-render',
  fc.crosshair.includes(null));
await render();

ok('the click created one drawing', drawings.length === 1, `${drawings.length}`);
const line = drawings[0];
ok('...a horizontal line', line?.type === 'horizontal');
// ⚠️ THE PRICE, NOT THE PIXEL. 137 must not appear anywhere in the stored anchor.
ok(`...storing the converted price ${EXPECTED}, not the pixel ${CLICK_Y}`,
  near(line?.points?.[0]?.price, EXPECTED), `stored ${line?.points?.[0]?.price}`);
ok('...and the stored value is not the raw coordinate', line?.points?.[0]?.price !== CLICK_Y);
// ⚠️ AND IT IS NOT ROUNDED. The chip is formatted by the price scale at paint time; rounding the
// stored value would put the line and its label a fraction of a tick apart, and would silently
// degrade an instrument quoted to four decimals.
ok('...stored to full precision, not rounded to 2dp',
  line?.points?.[0]?.price !== Math.round(line.points[0].price * 100) / 100,
  `stored ${line?.points?.[0]?.price}`);


// ── 8. the placed line carries its own chip ────────────────────────────────────────────────────
console.log('\n8. the placed line carries its own chip');

ok('one price line exists on the axis', fc.priceLines.length === 1, `${fc.priceLines.length}`);
ok('...at the drawing\'s stored price', near(fc.priceLines[0]?.o?.price, EXPECTED),
  `chip ${fc.priceLines[0]?.o?.price} vs stored ${line?.points?.[0]?.price}`);
ok('...showing its axis label', fc.priceLines[0]?.o?.axisLabelVisible === true);
ok('...and drawing no second line over ours', fc.priceLines[0]?.o?.lineVisible === false);

// ── 9. no view change may alter a stored price ─────────────────────────────────────────────────
console.log('\n9. no view change may alter a stored price');

const PRICE_AT_PLACEMENT = drawings[0].points[0].price;
const CHIP_AT_PLACEMENT = fc.priceLines[0].o.price;

// Each of these is a different view change, and each must move the PIXEL while leaving the PRICE.
const VIEW_CHANGES = [
  ['zoom in (vertical)', () => { fc.view.high = 230; fc.view.low = 215; }],
  ['zoom out (vertical)', () => { fc.view.high = 400; fc.view.low = 10; }],
  ['pan the price scale', () => { fc.view.high = 260; fc.view.low = 220; }],
  ['autoscale to the data', () => { fc.view.high = 221; fc.view.low = 219; }],
  ['a resize that changes the mapping', () => { fc.view.high = 300; fc.view.low = 100; }],
];
for (const [label, apply] of VIEW_CHANGES) {
  const pixelBefore = fc.priceToCoordinate(PRICE_AT_PLACEMENT);
  apply();
  // The chart tells the overlay it moved, exactly as Lightweight Charts does.
  await act(async () => { fc.ranges.forEach((fn) => fn({ from: 0, to: BARS.length - 1 })); });
  await render();
  const pixelAfter = fc.priceToCoordinate(PRICE_AT_PLACEMENT);
  ok(`${label}: the pixel really did move`, !near(pixelBefore, pixelAfter),
    `${pixelBefore} -> ${pixelAfter}`);
  ok(`${label}: the stored price is unchanged`,
    drawings[0].points[0].price === PRICE_AT_PLACEMENT, `${drawings[0].points[0].price}`);
  // ⚠️ THE CHIP IS CONDITIONAL ON BEING ON SCREEN — and that is the point, not an exception. Some of
  // these rescales (autoscale onto a two-dollar window) push the level off the plot entirely, and a
  // chip that survived that would be the boundary-pinned label this change exists to remove. So the
  // rule asserted is the full one: present and exact while visible, absent while not. The STORED
  // price above is unconditional.
  const onScreen = pixelAfter >= 0 && pixelAfter <= PLOT_H;
  if (onScreen) {
    ok(`${label}: the chip is still there, reading exactly the same price`,
      fc.priceLines.length === 1 && fc.priceLines[0].o.price === CHIP_AT_PLACEMENT,
      `${fc.priceLines.length} chip(s): ${fc.priceLines.map((h) => h.o.price).join(',')}`);
  } else {
    ok(`${label}: the level left the plot, so its chip is gone rather than pinned to the edge`,
      fc.priceLines.length === 0,
      `y=${pixelAfter.toFixed(1)} is outside 0..${PLOT_H} yet ${fc.priceLines.length} chip(s) remain`);
  }
}
fc.view.high = 241.37; fc.view.low = 199.11;
await render();

// A THEME CHANGE must not move it either — it recolours the chip and nothing else.
{
  const before = fc.priceLines[0].o.price;
  await act(async () => {
    root.render(React.createElement(DrawingLayer, {
      chart: fc.chart, series: fc.series, theme: 'dark', symbol: 'NVDA', bars: BARS,
      drawings, onChange, activeTool: null, onToolUsed: () => {},
      selectedIds, onSelect: () => {}, visible: true,
      style: { color: 0, width: 2, dash: 'solid' }, magnet: false, clearSignal: 0, toolDefaults: null,
      onRequestText: () => {}, onOpenSettings: () => {}, onSelectionBox: () => {},
    }));
  });
  ok('a theme change leaves the price alone', fc.priceLines[0].o.price === before);
  ok('...and recolours the chip for the dark palette', fc.priceLines[0].o.axisLabelColor === '#6FA8FF',
    fc.priceLines[0].o.axisLabelColor);
  ok('...keeping its text readable', contrast(fc.priceLines[0].o.axisLabelColor, fc.priceLines[0].o.axisLabelTextColor) >= 4.5);
  await render();
}

// ── 10. dragging moves the line and its chip together ─────────────────────────────────────────
console.log('\n10. dragging moves the line and its chip together');

// moveDrawing is the one path a drag takes, so the price delta it applies is asserted directly.
{
  const start = hline('d1', 578.42);
  const moved = moveDrawing(start, { dTime: 600, dPrice: 2.75 }, null);
  ok('a drag changes the price by the price delta', near(moved.points[0].price, 581.17),
    String(moved.points[0].price));
  // lockTime means a horizontal line cannot creep sideways however it is dragged.
  ok('...and never sideways, so it cannot come out diagonal',
    moved.points[0].time === start.points[0].time);
  const a = fakeAdapter();
  let m = reconcileAxisLabels(new Map(), axisLabelSpecs([start], tool, { colorOf: () => '#1A3A78' }), a);
  a.log.length = 0;
  m = reconcileAxisLabels(m, axisLabelSpecs([moved], tool, { colorOf: () => '#1A3A78' }), a);
  ok('...and the chip follows to the new price',
    a.log.length === 1 && a.log[0][0] === 'update' && near(a.log[0][1], 581.17), JSON.stringify(a.log));
}

// ── 10b. dragging the REAL line, with real pointer events ─────────────────────────────────────
console.log('\n10b. dragging the real line, with real pointer events');

// ⚠️ THIS SECTION EXISTS BECAUSE SECTION 10 WAS NOT ENOUGH. It exercises moveDrawing and the
// reconciler directly, which is worth doing — but it never dispatched a drag, so removing the live
// readout from the drag path changed nothing any assertion could see. A real gesture does.
{
  // One line, and a grab exactly on it: a horizontal line spans the plot at its own price.
  const only = drawings[0];
  const startPrice = only.points[0].price;
  const grabY = fc.priceToCoordinate(startPrice);
  const chipBefore = fc.priceLines.find((h) => h.o.price === startPrice);
  ok('the line under test has a chip before the drag', !!chipBefore);

  fc.crosshair.length = 0;
  await pointer('pointerdown', grabY);
  // Somewhere clearly else on the scale.
  const dropY = grabY + 73;
  const wantPrice = startPrice + (fc.coordinateToPrice(dropY) - fc.coordinateToPrice(grabY));
  await pointer('pointermove', dropY);
  await render();

  ok('the drag reported a live price on the axis', fc.crosshair.filter(Boolean).length > 0,
    `${fc.crosshair.length} updates`);
  ok('...the price the pointer is actually over',
    fc.crosshair.filter(Boolean).some((c) => near(c.price, fc.coordinateToPrice(dropY))),
    JSON.stringify(fc.crosshair.filter(Boolean).map((c) => c.price)));

  const after = drawings.find((d) => d.id === only.id);
  ok('the line moved to the dragged price', near(after?.points?.[0]?.price, wantPrice),
    `${after?.points?.[0]?.price} vs ${wantPrice}`);
  ok('...and did not move sideways', after.points[0].time === only.points[0].time);
  // THE CHIP FOLLOWED. Same count — it was updated in place, not destroyed and rebuilt.
  ok('...and its chip followed to the same new price',
    fc.priceLines.some((h) => near(h.o.price, wantPrice)),
    JSON.stringify(fc.priceLines.map((h) => h.o.price)));
  ok('...without adding or losing a chip', fc.priceLines.length === drawings.length,
    `${fc.priceLines.length} chips for ${drawings.length} drawings`);

  // Releasing hands the crosshair back to the chart.
  fc.crosshair.length = 0;
  await pointer('pointerup', dropY);
  ok('releasing the drag clears the readout', fc.crosshair.includes(null));
  selectedIds = [];
  await render();
}

// ── 11. three lines, three independent chips ───────────────────────────────────────────────────
console.log('\n11. three lines, three independent chips');

activeTool = 'horizontal';
await render();
for (const y of [90, 250]) {
  await pointer('pointermove', y);
  await pointer('pointerdown', y);
  activeTool = 'horizontal';
  await render();
}
activeTool = null;
await render();

ok('three horizontal lines are stored', drawings.length === 3, `${drawings.length}`);
ok('...and each has its own chip', fc.priceLines.length === 3, `${fc.priceLines.length}`);
const chipPrices = fc.priceLines.map((h) => h.o.price).sort((a, b) => a - b);
const storedPrices = drawings.map((d) => d.points[0].price).sort((a, b) => a - b);
ok('...matching the stored prices exactly',
  chipPrices.length === storedPrices.length && chipPrices.every((p, i) => p === storedPrices[i]),
  `chips ${JSON.stringify(chipPrices)} vs stored ${JSON.stringify(storedPrices)}`);
ok('...and they are three DIFFERENT prices, not one repeated',
  new Set(chipPrices).size === 3, JSON.stringify(chipPrices));

// ⚠️ SELECTING ONE MUST NOT DISTURB THE OTHERS' CHIPS.
selectedIds = [drawings[1].id];
await render();
ok('selecting a line leaves all three chips in place', fc.priceLines.length === 3, `${fc.priceLines.length}`);
ok('...at the same prices',
  fc.priceLines.map((h) => h.o.price).sort((a, b) => a - b).every((p, i) => p === chipPrices[i]));
selectedIds = [];
await render();

// Deleting one takes exactly its chip.
{
  const keep = drawings.filter((d) => d.id !== drawings[1].id);
  drawings = keep;
  await render();
  ok('deleting a line removes exactly its chip', fc.priceLines.length === 2, `${fc.priceLines.length}`);
}

// Hiding the layer clears the chips; showing it restores them.
{
  const before = fc.priceLines.length;
  await act(async () => {
    root.render(React.createElement(DrawingLayer, {
      chart: fc.chart, series: fc.series, theme: 'light', symbol: 'NVDA', bars: BARS,
      drawings, onChange, activeTool: null, onToolUsed: () => {},
      selectedIds: [], onSelect: () => {}, visible: false,
      style: { color: 0, width: 2, dash: 'solid' }, magnet: false, clearSignal: 0, toolDefaults: null,
      onRequestText: () => {}, onOpenSettings: () => {}, onSelectionBox: () => {},
    }));
  });
  ok('hiding the drawing layer clears its chips from the axis', fc.priceLines.length === 0,
    `${fc.priceLines.length}`);
  await render();
  ok('showing it again restores them', fc.priceLines.length === before, `${fc.priceLines.length}`);
}

// ── 12. a reload rebuilds the same chips from the stored prices ────────────────────────────────
console.log('\n12. a reload rebuilds the same chips from the stored prices');

{
  // What persistence actually round-trips: the drawing objects, through JSON.
  const saved = JSON.parse(JSON.stringify(drawings));
  const reloaded = fakeChart();
  const dom2 = makeDom();
  const c2 = dom2.window.document.getElementById('root');
  const r2 = ReactDOMClient.createRoot(c2);
  await act(async () => {
    r2.render(React.createElement(DrawingLayer, {
      chart: reloaded.chart, series: reloaded.series, theme: 'light', symbol: 'NVDA', bars: BARS,
      drawings: saved, onChange: () => {}, activeTool: null, onToolUsed: () => {},
      selectedIds: [], onSelect: () => {}, visible: true,
      style: { color: 0, width: 2, dash: 'solid' }, magnet: false, clearSignal: 0, toolDefaults: null,
      onRequestText: () => {}, onOpenSettings: () => {}, onSelectionBox: () => {},
    }));
  });
  ok('a reload restores a chip per saved line', reloaded.priceLines.length === saved.length,
    `${reloaded.priceLines.length} vs ${saved.length}`);
  ok('...at exactly the saved prices',
    reloaded.priceLines.map((h) => h.o.price).sort((a, b) => a - b)
      .every((p, i) => p === saved.map((d) => d.points[0].price).sort((a, b) => a - b)[i]));
  // And a reload on a DIFFERENT view still shows the same prices — the pixels differ, the prices do not.
  reloaded.view.high = 900; reloaded.view.low = 5;
  await act(async () => {
    r2.render(React.createElement(DrawingLayer, {
      chart: reloaded.chart, series: reloaded.series, theme: 'light', symbol: 'NVDA', bars: BARS,
      drawings: saved, onChange: () => {}, activeTool: null, onToolUsed: () => {},
      selectedIds: [], onSelect: () => {}, visible: true,
      style: { color: 0, width: 2, dash: 'solid' }, magnet: false, clearSignal: 0, toolDefaults: null,
      onRequestText: () => {}, onOpenSettings: () => {}, onSelectionBox: () => {},
    }));
  });
  ok('...and a reload onto a different view keeps those prices',
    reloaded.priceLines.map((h) => h.o.price).sort((a, b) => a - b)
      .every((p, i) => p === saved.map((d) => d.points[0].price).sort((a, b) => a - b)[i]));
}

// ── 12b. no chip may outlive its drawing, its series, or the layer ────────────────────────────
console.log('\n12b. no chip may outlive its drawing, its series, or the layer');

// ⚠️ THIS IS THE INVARIANT verify-drawing-toolbar USED TO PROTECT WITH A BAN ON createPriceLine.
// Per-drawing chart objects are how an orphaned artifact happens: a level that survives the list it
// came from. The ban made that impossible by construction; using the library's own chip means it now
// has to be guaranteed, so it is guaranteed HERE, behaviourally, in every way it could be lost.
{
  const fc2 = fakeChart();
  const dom3 = makeDom();
  const c3 = dom3.window.document.getElementById('root');
  const r3 = ReactDOMClient.createRoot(c3);
  const three = [hline('x1', 210.5), hline('x2', 215.25), hline('x3', 230.125)];
  const mount = (props) => act(async () => {
    r3.render(React.createElement(DrawingLayer, {
      chart: fc2.chart, series: fc2.series, theme: 'light', symbol: 'NVDA', bars: BARS,
      drawings: three, onChange: () => {}, activeTool: null, onToolUsed: () => {},
      selectedIds: [], onSelect: () => {}, visible: true,
      style: { color: 0, width: 2, dash: 'solid' }, magnet: false, clearSignal: 0, toolDefaults: null,
      onRequestText: () => {}, onOpenSettings: () => {}, onSelectionBox: () => {}, ...props,
    }));
  });

  await mount({});
  ok('three lines, three chips', fc2.priceLines.length === 3, `${fc2.priceLines.length}`);

  // EVERY DRAWING GONE: every chip gone. The orphan case the ban existed to prevent.
  await mount({ drawings: [] });
  ok('clearing the drawing list leaves no chip behind', fc2.priceLines.length === 0,
    `${fc2.priceLines.length} orphaned`);

  // A RECREATED SERIES. CPChart destroys and re-adds the price series on a chart-type change, and
  // every price line on it dies with it — so the chips must be rebuilt on the NEW series, and the
  // stale handles must never be applied to it.
  await mount({ drawings: three });
  ok('chips are back after the list returns', fc2.priceLines.length === 3);
  const fresh = fakeChart();
  await act(async () => {
    r3.render(React.createElement(DrawingLayer, {
      chart: fresh.chart, series: fresh.series, theme: 'light', symbol: 'NVDA', bars: BARS,
      drawings: three, onChange: () => {}, activeTool: null, onToolUsed: () => {},
      selectedIds: [], onSelect: () => {}, visible: true,
      style: { color: 0, width: 2, dash: 'solid' }, magnet: false, clearSignal: 0, toolDefaults: null,
      onRequestText: () => {}, onOpenSettings: () => {}, onSelectionBox: () => {},
    }));
  });
  ok('a recreated series gets its own three chips', fresh.priceLines.length === 3,
    `${fresh.priceLines.length}`);
  ok('...at the right prices',
    fresh.priceLines.map((h) => h.o.price).sort((a, b) => a - b).join(',') === '210.5,215.25,230.125',
    fresh.priceLines.map((h) => h.o.price).join(','));

  // UNMOUNTING. The layer going away must take its chips with it, or a symbol change would leave
  // levels on the axis of the next chart.
  const solo = fakeChart();
  const dom4 = makeDom();
  const c4 = dom4.window.document.getElementById('root');
  const r4 = ReactDOMClient.createRoot(c4);
  await act(async () => {
    r4.render(React.createElement(DrawingLayer, {
      chart: solo.chart, series: solo.series, theme: 'light', symbol: 'NVDA', bars: BARS,
      drawings: three, onChange: () => {}, activeTool: null, onToolUsed: () => {},
      selectedIds: [], onSelect: () => {}, visible: true,
      style: { color: 0, width: 2, dash: 'solid' }, magnet: false, clearSignal: 0, toolDefaults: null,
      onRequestText: () => {}, onOpenSettings: () => {}, onSelectionBox: () => {},
    }));
  });
  ok('the layer mounted with three chips', solo.priceLines.length === 3);
  await act(async () => { r4.unmount(); });
  ok('unmounting removes every chip from the axis', solo.priceLines.length === 0,
    `${solo.priceLines.length} left on the axis`);
}

// ── 13. what must NOT have changed ─────────────────────────────────────────────────────────────
console.log('\n13. what must NOT have changed');

const layer = fs.readFileSync(path.join(ROOT, 'src/components/chart/DrawingLayer.jsx'), 'utf8');

/**
 * ⚠️ COMMENTS STRIPPED BEFORE ASSERTING ON CODE.
 *
 * The first version of the assertion below searched the whole file for `priceLineVisible` and failed
 * — on the comment beside the new effect, which names that option precisely to say it is NOT touched.
 * An assertion that its own explanation can break is worse than no assertion: it fails when the code
 * is right. So these read code only.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const layerCode = stripComments(layer);

// THE CURRENT-PRICE CHIP. It comes from the series' own options, which this feature must not touch.
ok('the series\' own price-line and last-value options are never written here',
  !/priceLineVisible/.test(layerCode) && !/lastValueVisible/.test(layerCode));
// The guard is only meaningful if the stripping did not simply delete everything.
ok('...and the stripped source still contains the code being checked',
  /createPriceLine/.test(layerCode) && layerCode.length > 8000, `${layerCode.length} chars`);
const cp = fs.readFileSync(path.join(ROOT, 'src/components/chart/CPChart.jsx'), 'utf8');
ok('the chart still shows the current market price on the axis',
  /priceLineVisible: true[\s\S]{0,80}lastValueVisible: true/.test(cp));
// THE COORDINATE MODEL. Anchors stay { time, price }; nothing may persist a pixel.
const model = fs.readFileSync(path.join(ROOT, 'src/lib/chart/chart-drawings.mjs'), 'utf8');
ok('stored anchors are still { time, price }',
  /points: points\.map\(\(p\) => \(\{ time: p\.time, price: Number\(p\.price\) \}\)\)/.test(model));
ok('the horizontal tool still declares its price label', typeof tool('horizontal').priceLabel === 'function');
ok('...and still locks its time so it cannot tilt', tool('horizontal').lockTime === true);
// ACCOUNT ISOLATION. Untouched by this change: no storage key is read or written here.
ok('the drawing layer still touches no storage key',
  !/localStorage/.test(layerCode) && !/chartScopeKey/.test(layerCode));
const scope = fs.readFileSync(path.join(ROOT, 'src/lib/chart/chart-scope.mjs'), 'utf8');
ok('the per-account scope module is unchanged in shape',
  /export function chartScopeKey/.test(scope) && /ANON_SCOPE/.test(scope));
// The readout uses the library's conversion, not arithmetic of ours.
ok('the live readout goes through the chart\'s own crosshair API',
  /setCrosshairPosition\(/.test(layerCode) && /clearCrosshairPosition\(/.test(layerCode));
ok('...and the price it reports comes from coordinateToPrice',
  /coordinateToPrice\(y\)/.test(layerCode));
// No manual scale arithmetic crept in.
ok('the layer derives no price from the visible high/low itself',
  !/visibleHigh|visibleLow|\(high - low\) \*/.test(layerCode));

// ── 14. a level off the top or bottom of the plot gets NO chip ─────────────────────────────────
console.log('\n14. a level off the top or bottom of the plot gets no chip');

// The pure predicate first, then the real layer.
{
  const coordOf = (price) => ((300 - price) / 100) * 400;    // 300 at y=0, 200 at y=400
  ok('a price inside the plot is in view', priceInPlot(250, coordOf, 0, 400));
  ok('the exact top edge counts as visible', priceInPlot(300, coordOf, 0, 400));
  ok('the exact bottom edge counts as visible', priceInPlot(200, coordOf, 0, 400));
  ok('⚠️ a price above the top is NOT in view', !priceInPlot(320, coordOf, 0, 400));
  ok('⚠️ a price below the bottom is NOT in view', !priceInPlot(180, coordOf, 0, 400));
  ok('a coordinate the scale cannot produce is not in view', !priceInPlot(250, () => null, 0, 400));
  ok('a scale that throws is not in view', !priceInPlot(250, () => { throw new Error('gone'); }, 0, 400));
  ok('a non-finite price is not in view', !priceInPlot(NaN, coordOf, 0, 400));
  ok('nonsense bounds are not in view', !priceInPlot(250, coordOf, 400, 0));

  // ⚠️ AND NOTHING CLAMPS. The fix is to withhold the price line, never to fold an out-of-range
  // coordinate back onto the plot edge — a clamped coordinate is precisely the lie being removed.
  const labelSrc = fs.readFileSync(path.join(ROOT, 'src/lib/chart/price-axis-labels.mjs'), 'utf8');
  const labelCode = labelSrc.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok('⚠️ the label module clamps no coordinate',
    !/Math\.max\s*\([^)]*Math\.min/.test(labelCode) && !/Math\.min\s*\([^)]*Math\.max/.test(labelCode));
  const dlCode = fs.readFileSync(path.join(ROOT, 'src/components/chart/DrawingLayer.jsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok('⚠️ nor does the layer clamp a chip coordinate',
    !/Math\.max\([^)]*priceToCoordinate/.test(dlCode) && !/priceToCoordinate[^;]*Math\.min/.test(dlCode));
}

// Now the real component, against a scale this test moves.
{
  const f = fakeChart();
  const dom5 = makeDom();
  const c5 = dom5.window.document.getElementById('root');
  const r5 = ReactDOMClient.createRoot(c5);
  // Three levels: one mid-plot, one near the top, one near the bottom of the initial view.
  const mid = (f.view.high + f.view.low) / 2;
  const lines = [hline('m', mid), hline('hi', f.view.high - 1), hline('lo', f.view.low + 1)];
  const draw = () => act(async () => {
    r5.render(React.createElement(DrawingLayer, {
      chart: f.chart, series: f.series, theme: 'light', symbol: 'GOOGL', bars: BARS,
      drawings: lines, onChange: () => {}, activeTool: null, onToolUsed: () => {},
      selectedIds: [], onSelect: () => {}, visible: true,
      style: { color: 0, width: 2, dash: 'solid' }, magnet: false, clearSignal: 0, toolDefaults: null,
      onRequestText: () => {}, onOpenSettings: () => {}, onSelectionBox: () => {},
    }));
  });
  await draw();
  ok('all three levels are in view to begin with', f.priceLines.length === 3,
    `${f.priceLines.length}`);

  // A. IN RANGE -> chip present.  B. BELOW RANGE -> chip gone, not pinned to the bottom.
  // Rescale to a window ABOVE every line, so all three fall off the bottom.
  f.view.high = 400; f.view.low = 350;
  await act(async () => { f.ranges.forEach((fn) => fn({ from: 0, to: BARS.length - 1 })); });
  await draw();
  ok('⚠️ levels below the visible range have no chip at all', f.priceLines.length === 0,
    `${f.priceLines.length} chip(s) left: ${f.priceLines.map((h) => h.o.price).join(',')}`);

  // C. ABOVE RANGE -> chip gone, not pinned to the top.
  f.view.high = 100; f.view.low = 50;
  await act(async () => { f.ranges.forEach((fn) => fn({ from: 0, to: BARS.length - 1 })); });
  await draw();
  ok('⚠️ levels above the visible range have no chip at all', f.priceLines.length === 0,
    `${f.priceLines.length}`);

  // D. ZOOM BACK -> the chips return, at their original prices, with nothing having been stored.
  f.view.high = 241.37; f.view.low = 199.11;
  await act(async () => { f.ranges.forEach((fn) => fn({ from: 0, to: BARS.length - 1 })); });
  await draw();
  ok('⚠️ the chips return when the range covers them again', f.priceLines.length === 3,
    `${f.priceLines.length}`);
  ok('...at exactly the prices the drawings still hold',
    f.priceLines.map((h) => h.o.price).sort((a, b) => a - b).join(',')
      === lines.map((d) => d.points[0].price).sort((a, b) => a - b).join(','),
    f.priceLines.map((h) => h.o.price).join(','));
  ok('...and the drawings themselves never changed', lines[0].points[0].price === mid);

  // G. PARTIAL: a window containing only the middle level.
  f.view.high = mid + 0.5; f.view.low = mid - 0.5;
  await act(async () => { f.ranges.forEach((fn) => fn({ from: 0, to: BARS.length - 1 })); });
  await draw();
  ok('⚠️ only the level actually on screen keeps its chip', f.priceLines.length === 1,
    `${f.priceLines.length}: ${f.priceLines.map((h) => h.o.price).join(',')}`);
  ok('...and it is the right one', near(f.priceLines[0]?.o?.price, mid));

  // ⚠️ THE VERTICAL PATH, WHICH HAS NO NATIVE EVENT. Change the scale WITHOUT firing the logical-range
  // subscription — that is what dragging the price axis does — and only the crosshair watcher can
  // notice. Without it the chip would keep its last in-view answer.
  f.view.high = 900; f.view.low = 800;
  await act(async () => { f.fireCrosshair(); });
  ok('⚠️ a price-scale drag alone removes an off-screen chip', f.priceLines.length === 0,
    `${f.priceLines.length} — the crosshair watcher did not fire`);
  f.view.high = 241.37; f.view.low = 199.11;
  await act(async () => { f.fireCrosshair(); });
  ok('⚠️ ...and brings them back', f.priceLines.length === 3, `${f.priceLines.length}`);
  ok('the component subscribed to the crosshair exactly once', f.crosshairSubs.length === 1,
    `${f.crosshairSubs.length}`);
}

// ── 15. the price axis is adaptive, and denser than the library default ────────────────────────
console.log('\n15. the price axis is adaptive, and denser than the library default');

{
  const { chartOptions, PRICE_TICK_DENSITY } = await import('../src/lib/chart/chart-theme.mjs');
  const opts = chartOptions('light');
  ok('the price scale sets a tick density', opts.rightPriceScale.tickMarkDensity === PRICE_TICK_DENSITY);
  // ⚠️ THE LIBRARY DEFAULT IS 2.5, and that is the whole bug: at an 11px axis font it leaves a 28px
  // floor between labels, which is what produced 220/240/260…420 on a chart that had room for twice as
  // many. Lower value, smaller floor, more labels.
  const LIBRARY_DEFAULT = 2.5;
  ok('⚠️ and it is DENSER than the library default', PRICE_TICK_DENSITY < LIBRARY_DEFAULT,
    `${PRICE_TICK_DENSITY} vs ${LIBRARY_DEFAULT}`);
  const fontSize = opts.layout.fontSize;
  const gap = (d) => Math.ceil(fontSize * d);
  ok('...by a meaningful amount, not a rounding error', gap(PRICE_TICK_DENSITY) <= gap(LIBRARY_DEFAULT) - 6,
    `${gap(PRICE_TICK_DENSITY)}px vs ${gap(LIBRARY_DEFAULT)}px at ${fontSize}px font`);
  // ...but still leaves room for the text, or the labels collide.
  ok('...while still leaving room for the label text', gap(PRICE_TICK_DENSITY) >= fontSize + 4,
    `${gap(PRICE_TICK_DENSITY)}px for ${fontSize}px text`);

  // ⚠️ IT IS A DENSITY, NOT AN INTERVAL. The library derives the step; a hard-coded dollar amount is
  // the one thing guaranteed to be wrong on the next instrument.
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src/lib/chart/chart-theme.mjs'), 'utf8');
  ok('⚠️ no fixed price interval is configured anywhere in the chart options',
    !/priceInterval|tickInterval|priceStep|minMove:\s*\d+\s*\*/.test(themeSrc));
  const cpSrc = fs.readFileSync(path.join(ROOT, 'src/components/chart/CPChart.jsx'), 'utf8');
  ok('...nor in the chart itself', !/tickInterval|priceStep|setVisiblePriceRange/.test(cpSrc));

  // THE LIBRARY'S OWN ARITHMETIC, reproduced so the adaptivity is asserted rather than assumed:
  // maxTickSpan = (high - low) * gap / scaleHeight. Same pixels, different ranges -> different steps.
  const maxSpan = (high, low, h) => (high - low) * gap(PRICE_TICK_DENSITY) / h;
  ok('a wider visible range permits a coarser step', maxSpan(400, 200, 500) > maxSpan(250, 200, 500));
  ok('zooming in permits a finer step', maxSpan(210, 200, 500) < maxSpan(400, 200, 500));
  ok('a taller chart permits a finer step', maxSpan(400, 200, 900) < maxSpan(400, 200, 400));
  // ⚠️ AND IT SCALES WITH THE INSTRUMENT. A $5 stock and a $30,000 instrument get proportionate steps
  // with nothing per-symbol anywhere.
  const rel = (mid) => maxSpan(mid * 1.1, mid * 0.9, 500) / mid;
  ok('a $5 stock and a $30,000 instrument get proportionate steps',
    Math.abs(rel(5) - rel(30000)) < 1e-9, `${rel(5)} vs ${rel(30000)}`);
  ok('...and the same range on a bigger instrument is not treated as finer',
    maxSpan(30000 * 1.1, 30000 * 0.9, 500) > maxSpan(5 * 1.1, 5 * 0.9, 500));
}

// ── 16. the time axis formats each tick class, and generates none of them ──────────────────────
console.log('\n16. the time axis formats each tick class, and generates none of them');

{
  const { tickLabel } = await import(pathToFileURL(out).href).catch(() => ({}));
  void tickLabel;
  // The formatter is exported from CPChart; bundling the whole chart is unnecessary for a pure
  // function, so it is imported from the built module used above only if present. Otherwise read it
  // from a dedicated bundle.
  // ⚠️ STUBBED, NOT EXTERNAL. Marking next/navigation and @clerk/nextjs external leaves real imports
  // in the bundle, and Node cannot resolve a bare 'next/navigation' from a cache directory — the whole
  // suite died on ERR_MODULE_NOT_FOUND rather than running. lightweight-charts is only imported
  // dynamically inside an effect, so a stub is enough for a pure function.
  const mk = (name, body) => { const f = path.join(TMP, name); fs.writeFileSync(f, body); return f; };
  const cpOut = path.join(TMP, 'CPChart.probe.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/components/chart/CPChart.jsx')],
    bundle: true, format: 'esm', platform: 'browser', outfile: cpOut, jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    logLevel: 'silent', absWorkingDir: ROOT,
    alias: {
      'next/navigation': mk('nav2.mjs', `
export const useRouter = () => ({ push() {}, replace() {}, prefetch() {}, back() {}, refresh() {} });
export const useSearchParams = () => new URLSearchParams();
export const usePathname = () => '/';
export const useParams = () => ({});
export const redirect = () => {}; export const permanentRedirect = () => {}; export const notFound = () => {};
export default {};`),
      '@clerk/nextjs': mk('clerk2.mjs', `
export const SignedIn = () => null; export const SignedOut = ({ children }) => children ?? null;
export const UserButton = () => null;
export const useAuth = () => ({ isLoaded: true, isSignedIn: false, userId: null });
export const useUser = () => ({ isLoaded: true, isSignedIn: false, user: null });
export const useClerk = () => ({ signOut: async () => {}, openUserProfile: () => {} });
export const ClerkProvider = ({ children }) => children ?? null;
export default {};`),
      'lightweight-charts': mk('lwc2.mjs', 'export default {}; export const createChart = () => ({});'),
    },
  });
  const mod = await import(pathToFileURL(cpOut).href);
  ok('the chart exports its tick formatter for verification', typeof mod.tickLabel === 'function');

  if (typeof mod.tickLabel === 'function') {
    // The library's own enum values.
    const T = { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 };
    const fmt = mod.tickLabel(T);
    // 2026-09-25 14:30:00 UTC = 10:30 ET
    const t = Math.floor(Date.parse('2026-09-25T14:30:00Z') / 1000);

    ok('a Time tick is a time of day in market time', fmt(t, T.Time) === '10:30', fmt(t, T.Time));
    ok('a TimeWithSeconds tick carries seconds', /^10:30:00$/.test(fmt(t, T.TimeWithSeconds)),
      fmt(t, T.TimeWithSeconds));
    // ⚠️ THE ONE THAT WAS BROKEN. Every tick used to come back as a time of day, so a day boundary on
    // an intraday chart read "09:30" and the axis could not say which day any of them was.
    ok('⚠️ a DayOfMonth tick is a DATE, not a time of day', /Sep\s*25/.test(fmt(t, T.DayOfMonth)),
      fmt(t, T.DayOfMonth));
    ok('...and carries no time of day at all', !/\d\d:\d\d/.test(fmt(t, T.DayOfMonth)),
      fmt(t, T.DayOfMonth));
    ok('a Month tick is a month', /Sep/.test(fmt(t, T.Month)) && !/\d\d:\d\d/.test(fmt(t, T.Month)),
      fmt(t, T.Month));
    ok('a Year tick is a year', fmt(t, T.Year) === '2026', fmt(t, T.Year));

    // ⚠️ A BUSINESS DAY FALLS THROUGH TO THE LIBRARY. Returning null is how the library is told to use
    // its own formatting, which already prints the month/year landmarks a daily chart wants — and a
    // business day has no time of day, so no timezone can shift it.
    ok('⚠️ a business-day tick returns null so the library formats it',
      fmt({ year: 2026, month: 9, day: 25 }, T.Month) === null);
    ok('...and so does a date string', fmt('2026-09-25', T.DayOfMonth) === null);
    ok('an unknown tick class also falls back rather than guessing', fmt(t, 99) === null);

    // MARKET TIME, NOT THE READER'S. A viewer in any timezone reads the same session clock.
    const midnightET = Math.floor(Date.parse('2026-09-26T03:30:00Z') / 1000);   // 23:30 ET on the 25th
    ok('⚠️ the label is in market time, not the browser\'s',
      fmt(midnightET, T.Time) === '23:30' && /Sep\s*25/.test(fmt(midnightET, T.DayOfMonth)),
      `${fmt(midnightET, T.Time)} / ${fmt(midnightET, T.DayOfMonth)}`);

    // ⚠️ AND THE FORMATTER DECIDES NOTHING ABOUT HOW MANY TICKS THERE ARE. It is handed a tick and
    // returns a string; the library generates the ticks from the range, the width and the bar spacing.
    const cpCode = fs.readFileSync(path.join(ROOT, 'src/components/chart/CPChart.jsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    ok('⚠️ nothing overrides the number of time ticks',
      !/setVisibleRange|fixLeftEdge|fixRightEdge|minBarSpacing|tickMarkMaxCharacterLength/.test(cpCode));
    ok('...and there is no per-timeframe special case in the formatter',
      !/tickLabel[\s\S]{0,400}(isIntraday|'1D'|tf ===)/.test(cpCode));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
