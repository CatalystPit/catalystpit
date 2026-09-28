// TEXT ATTACHED TO A DRAWING.
//
//   node scripts/verify-drawing-text.mjs
//
// ⚠️ WHAT THIS IS AND IS NOT. The standalone Text NOTE tool — the "T" in the left rail — makes a
// drawing whose body IS a string. This is the other thing: a caption belonging to a line, reached from
// the selected drawing's floating toolbar, that moves with the line and is deleted with it.
//
// ⚠️ AND IT IS THE `label` FIELD GROWN UP, NOT A SECOND ONE. Drawings have carried an attached label
// since they were built — stored, painted, editable. Adding a parallel `text` string to labelable
// drawings would have given one line two captions, two toolbar buttons that look interchangeable, and
// two things to keep in step when the line is dragged. So the assertions here are about one field with
// a style, and the suite checks that no second one appeared.

import { JSDOM } from 'jsdom';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import {
  createDrawing, coerceDrawing, LABEL_MAX, TOOLS,
} from '../src/lib/chart/chart-drawings.mjs';
import {
  sanitizeLabelStyle, labelBox, labelFont, labelHeight,
  LABEL_ALIGNS, LABEL_PLACES, LABEL_SIZES, DEFAULT_LABEL_STYLE, LABEL_GAP, LABEL_PAD,
} from '../src/lib/chart/drawing-label.mjs';
import { CONTROL, controlsFor } from '../src/lib/chart/drawing-toolbar.mjs';
import { PALETTE, paletteMetrics, normalizeHex } from '../src/lib/chart/color-palette.mjs';
import { setChartScope, __resetChartScope } from '../src/lib/chart/chart-scope.mjs';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const LABELABLE = Object.values(TOOLS).filter((t) => t.labelable).map((t) => t.id);
const ptsFor = (id) => Array.from({ length: TOOLS[id].points },
  (_, i) => ({ time: 1700000000 + i * 3600, price: 220.71 + i }));

// ── 1. the caption belongs to the drawing ──────────────────────────────────────────────────────
console.log('\n1. the caption belongs to the drawing');

ok('there are several labelable tools to cover', LABELABLE.length >= 4, LABELABLE.join(', '));
ok('⚠️ horizontal and trend are among them — the two the brief names',
  LABELABLE.includes('horizontal') && LABELABLE.includes('trend'), LABELABLE.join(', '));

for (const id of LABELABLE) {
  const d = createDrawing(id, ptsFor(id), {}, [], { label: 'Previous Resistance' });
  ok(`${id}: carries the caption it was made with`, d?.label === 'Previous Resistance', `${d?.label}`);
  ok(`${id}: ...and a style for it`, !!d?.labelStyle && LABEL_SIZES.includes(d.labelStyle.size));
  // ⚠️ IT IS ONE OBJECT. The caption is a field, so there is no second drawing to select, move or
  // delete — which is the whole reason it cannot drift away from its line.
  ok(`${id}: the caption is a field, not a second drawing`,
    typeof d.label === 'string' && d.points.length === TOOLS[id].points);
}

// ⚠️ THE TEXT NOTE TOOL IS UNTOUCHED, and carries no caption of its own: its string IS the drawing.
{
  const note = createDrawing('text', [{ time: 1, price: 2 }], {}, [], { text: 'hi' });
  ok('⚠️ a text note has no caption field', !('label' in note) && !('labelStyle' in note));
  ok('...and still has its own body', note.text === 'hi');
  ok('...and the rail still offers it as its own tool', TOOLS.text.hasText === true);
}

// ⚠️ AND NO SECOND CAPTION FIELD APPEARED. This is the assertion that the feature was built by growing
// the existing field rather than adding one beside it.
{
  const d = createDrawing('horizontal', ptsFor('horizontal'), {}, [], { label: 'x' });
  const textish = Object.keys(d).filter((k) => /^(text|caption|note|annotation)$/i.test(k));
  ok('⚠️ a labelable drawing has exactly one caption field', textish.length === 0,
    `also found: ${textish.join(', ')}`);
}

// ── 2. an existing drawing keeps loading ───────────────────────────────────────────────────────
console.log('\n2. an existing drawing keeps loading');

{
  // Exactly what a record stored before any of this looks like: a label, no style at all.
  const legacy = coerceDrawing({
    type: 'horizontal', points: [{ time: 1700000000, price: 220.71 }], label: 'Old resistance',
  });
  ok('⚠️ a drawing stored before captions had styling still loads', !!legacy);
  ok('...keeping its text', legacy.label === 'Old resistance');
  ok('⚠️ ...and gains the default style rather than an undefined one',
    legacy.labelStyle.size === DEFAULT_LABEL_STYLE.size
    && legacy.labelStyle.align === DEFAULT_LABEL_STYLE.align
    && legacy.labelStyle.place === DEFAULT_LABEL_STYLE.place,
    JSON.stringify(legacy.labelStyle));
  // ⚠️ THE FAILURE THIS PREVENTS IS SILENT. An undefined size reaches canvas as 'undefinedpx', which
  // is not an error — the text simply never appears, on exactly the drawings that existed already.
  ok('⚠️ ...so the font it asks for is a real font', /\d+px/.test(labelFont(legacy.labelStyle)),
    labelFont(legacy.labelStyle));

  const none = coerceDrawing({ type: 'horizontal', points: [{ time: 1700000000, price: 220.71 }] });
  ok('a drawing with no caption at all loads, with an empty one', none.label === '');
  ok('...and still gets a usable style', LABEL_SIZES.includes(none.labelStyle.size));
}

// ── 3. the style survives a round trip, and junk does not ──────────────────────────────────────
console.log('\n3. the style survives a round trip, and junk does not');

{
  const chosen = { color: PALETTE[55], size: 18, bold: false, align: 'left', place: 'below' };
  const made = createDrawing('trend', ptsFor('trend'), {}, [], { label: 'Break', labelStyle: chosen });
  const back = coerceDrawing(JSON.parse(JSON.stringify(made)));
  for (const k of ['size', 'bold', 'align', 'place']) {
    ok(`⚠️ ${k} survives the round trip`, back.labelStyle[k] === chosen[k],
      `${back.labelStyle[k]} vs ${chosen[k]}`);
  }
  ok('⚠️ the caption colour survives it too', back.labelStyle.color === normalizeHex(PALETTE[55]),
    `${back.labelStyle.color}`);

  // A legacy themed INDEX is still a colour, the same as everywhere else in the chart.
  const idx = coerceDrawing({ type: 'trend', points: ptsFor('trend'), label: 'x', labelStyle: { color: 2 } });
  ok('a themed index is kept as an index', idx.labelStyle.color === 2);

  // ⚠️ AND AN ABSENT COLOUR MEANS INHERIT, not black. Same convention as the Fibonacci levels: the
  // key is missing rather than null, so the renderer can tell "no choice made" from "chose a colour".
  const inherit = sanitizeLabelStyle({ color: null });
  ok('⚠️ an absent caption colour is absent, not null', !('color' in inherit), JSON.stringify(inherit));
  ok('...and clearing one returns it to inheriting',
    !('color' in sanitizeLabelStyle({ ...chosen, color: '' })));

  // Junk cannot reach the renderer.
  const junk = sanitizeLabelStyle({ size: 999, bold: 'yes', align: 'diagonal', place: 'sideways', color: {} });
  ok('an impossible size falls back to the default', junk.size === DEFAULT_LABEL_STYLE.size);
  ok('an impossible alignment falls back', LABEL_ALIGNS.includes(junk.align));
  ok('an impossible placement falls back', LABEL_PLACES.includes(junk.place));
  ok('a non-boolean weight becomes a boolean', typeof junk.bold === 'boolean');
  ok('an object colour is dropped rather than painted', !('color' in junk));
  ok('no style at all is the default style',
    JSON.stringify(sanitizeLabelStyle(undefined)) === JSON.stringify(sanitizeLabelStyle({})));
}

// ── 4. two drawings are independent ────────────────────────────────────────────────────────────
console.log('\n4. two drawings are independent');

{
  const a = createDrawing('horizontal', ptsFor('horizontal'), {}, [],
    { label: 'Resistance', labelStyle: { color: PALETTE[15], size: 10, align: 'left', place: 'below', bold: false } });
  const b = createDrawing('horizontal', ptsFor('horizontal'), {}, [a],
    { label: 'Support', labelStyle: { color: PALETTE[85], size: 18, align: 'center', place: 'above', bold: true } });
  ok('two lines get different ids', a.id !== b.id);
  ok('⚠️ ...and completely independent captions', a.label !== b.label);
  for (const k of ['color', 'size', 'align', 'place', 'bold']) {
    ok(`⚠️ ...and independent ${k}`, a.labelStyle[k] !== b.labelStyle[k],
      `${a.labelStyle[k]} vs ${b.labelStyle[k]}`);
  }
  // Editing one must not reach the other — the shape a shared-object bug would take.
  const edited = { ...a, labelStyle: { ...a.labelStyle, align: 'right' } };
  ok('⚠️ editing one leaves the other alone', b.labelStyle.align === 'center' && edited.labelStyle.align === 'right');
}

// ── 5. it persists, per account ────────────────────────────────────────────────────────────────
console.log('\n5. it persists, per account');

{
  const store = new Map();
  // ⚠️ THE STORE READS `window.localStorage`, NOT THE BARE GLOBAL. Stubbing only globalThis.localStorage
  // left isBrowser() false, so saveDrawings returned without writing and every assertion below read an
  // empty list — which looks exactly like "the caption did not persist".
  const shim = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.window = { localStorage: shim };
  globalThis.localStorage = shim;
  const { loadDrawings, saveDrawings } = await import('../src/lib/chart/chart-drawing-store.mjs');

  __resetChartScope();
  setChartScope('user-a');
  const mine = createDrawing('horizontal', ptsFor('horizontal'), {}, [],
    { label: 'Previous Resistance', labelStyle: { color: PALETTE[85], size: 14, align: 'center', place: 'below', bold: false } });
  saveDrawings('AAPL', [mine]);

  const reloaded = loadDrawings('AAPL');
  ok('⚠️ the caption survives a reload', reloaded[0]?.label === 'Previous Resistance', `${reloaded[0]?.label}`);
  ok('⚠️ ...with its style', reloaded[0]?.labelStyle.size === 14
    && reloaded[0]?.labelStyle.align === 'center' && reloaded[0]?.labelStyle.place === 'below'
    && reloaded[0]?.labelStyle.bold === false, JSON.stringify(reloaded[0]?.labelStyle));
  ok('⚠️ ...and its colour', reloaded[0]?.labelStyle.color === normalizeHex(PALETTE[85]));

  // ⚠️ ACCOUNT ISOLATION. A caption is stored with the drawing, so it is scoped with the drawing —
  // and a second account must not see it.
  setChartScope('user-b');
  ok('⚠️ another account sees none of it', loadDrawings('AAPL').length === 0);
  setChartScope('user-a');
  ok('⚠️ ...and the first account still does', loadDrawings('AAPL')[0]?.label === 'Previous Resistance');
  __resetChartScope();
  delete globalThis.localStorage;
  delete globalThis.window;
}

// ── 6. where the caption lands ─────────────────────────────────────────────────────────────────
console.log('\n6. where the caption lands');

{
  const PLOT = { w: 600, h: 400 };
  // A horizontal line: its segment spans the visible plot, which is why "right" pins to the edge.
  const flat = [{ x: 0, y: 200 }, { x: 600, y: 200 }];
  const W = 80;
  const box = (style) => labelBox(flat, sanitizeLabelStyle(style), W, PLOT);

  const left = box({ align: 'left' }), mid = box({ align: 'center' }), right = box({ align: 'right' });
  ok('⚠️ left, centre and right are three different places',
    left.x < mid.x && mid.x < right.x, `${left.x} ${mid.x} ${right.x}`);
  ok('⚠️ centre really is centred on the segment',
    Math.abs((mid.x + mid.w / 2) - 300) <= 0.51, `${mid.x + mid.w / 2}`);
  ok('left sits just after the start', left.x === 0 + LABEL_GAP);
  ok('right sits just before the end', Math.abs((right.x + right.w) - (600 - LABEL_GAP)) <= 0.01);

  const above = box({ place: 'above' }), on = box({ place: 'middle' }), below = box({ place: 'below' });
  ok('⚠️ above, on and below are three different places',
    above.y < on.y && on.y < below.y, `${above.y} ${on.y} ${below.y}`);
  ok('⚠️ above is clear of the line', above.y + above.h <= 200 - LABEL_GAP + 0.01);
  ok('⚠️ below is clear of the line', below.y >= 200 + LABEL_GAP - 0.01);
  ok('on the line straddles it', on.y < 200 && on.y + on.h > 200);

  // The defaults the brief asks for.
  ok('⚠️ the default is right-aligned and above', DEFAULT_LABEL_STYLE.align === 'right'
    && DEFAULT_LABEL_STYLE.place === 'above');

  // ⚠️ INSIDE THE PLOT, WHATEVER IS ASKED FOR. A caption drawn over the price scale reads as a
  // rendering fault; this is the assertion that no combination of style and geometry can produce one.
  let outside = 0, cases = 0;
  for (const align of LABEL_ALIGNS) {
    for (const place of LABEL_PLACES) {
      for (const size of LABEL_SIZES) {
        for (const seg of [
          flat,
          [{ x: -400, y: 5 }, { x: 1200, y: 5 }],          // a line off both edges, at the very top
          [{ x: 590, y: 395 }, { x: 600, y: 400 }],        // a stub in the bottom-right corner
          [{ x: 10, y: 10 }, { x: 12, y: 390 }],           // near-vertical
          [{ x: 300, y: 0 }, { x: 300, y: 400 }],          // exactly vertical
          [{ x: 0, y: 400 }, { x: 600, y: 0 }],            // a steep diagonal
        ]) {
          for (const tw of [4, 80, 400]) {
            const r = labelBox(seg, sanitizeLabelStyle({ align, place, size }), tw, PLOT);
            cases += 1;
            if (!r) { outside += 1; continue; }
            if (r.x < -0.01 || r.y < -0.01 || r.x + r.w > PLOT.w + 0.01 || r.y + r.h > PLOT.h + 0.01) {
              // A caption wider than the plot cannot fit; it is pinned to the left edge, not centred
              // off it, and that is the only tolerated overflow.
              if (!(r.w > PLOT.w && Math.abs(r.x - LABEL_PAD) < 0.01)) outside += 1;
            }
          }
        }
      }
    }
  }
  ok('the containment sweep actually ran', cases >= 300, `${cases}`);
  ok('⚠️ every caption lands inside the plot', outside === 0, `${outside} of ${cases} escaped`);

  // ⚠️ A NEAR-VERTICAL LINE OFFSETS SIDEWAYS. "Above" on a vertical line would put the caption on top
  // of the line it is naming, so above/below become left/right — the same before/after relationship,
  // rotated with the line.
  const vert = [{ x: 300, y: 40 }, { x: 300, y: 360 }];
  const vAbove = labelBox(vert, sanitizeLabelStyle({ place: 'above', align: 'center' }), W, PLOT);
  const vBelow = labelBox(vert, sanitizeLabelStyle({ place: 'below', align: 'center' }), W, PLOT);
  ok('⚠️ on a vertical line the two sides differ horizontally', vAbove.x < vBelow.x,
    `${vAbove.x} vs ${vBelow.x}`);
  ok('⚠️ ...and neither sits on top of the line',
    vAbove.x + vAbove.w <= 300 + 0.01 && vBelow.x >= 300 - 0.01);

  // Nonsense in, nothing out — never a NaN reaching canvas.
  ok('a missing segment yields no box', labelBox(null, DEFAULT_LABEL_STYLE, W, PLOT) === null);
  ok('a NaN coordinate yields no box',
    labelBox([{ x: NaN, y: 1 }, { x: 2, y: 3 }], DEFAULT_LABEL_STYLE, W, PLOT) === null);
  ok('a missing plot yields no box', labelBox(flat, DEFAULT_LABEL_STYLE, W, null) === null);
}

// ── 7. it follows the drawing ──────────────────────────────────────────────────────────────────
console.log('\n7. it follows the drawing');

{
  const PLOT = { w: 600, h: 400 };
  const style = sanitizeLabelStyle({ align: 'center', place: 'above' });
  const at = (seg) => labelBox(seg, style, 80, PLOT);

  // ⚠️ PAN AND ZOOM ARE NOT SPECIAL CASES. The caption is placed from the segment the renderer just
  // projected, so anything that moves the line moves the caption by the same amount, and nothing that
  // leaves the line alone moves the caption. These are the three ways that gets tested: shift the
  // segment (a pan), stretch it (a zoom), and move its price (a drag).
  const base = [{ x: 100, y: 200 }, { x: 500, y: 200 }];
  const panned = base.map((q) => ({ x: q.x - 120, y: q.y }));
  const zoomed = [{ x: 0, y: 200 }, { x: 600, y: 200 }];
  const dragged = base.map((q) => ({ x: q.x, y: q.y - 60 }));

  const b0 = at(base), bp = at(panned), bz = at(zoomed), bd = at(dragged);
  ok('⚠️ a pan moves the caption with the line', Math.abs((b0.x - bp.x) - 120) <= 0.51,
    `${b0.x} -> ${bp.x}`);
  ok('⚠️ ...and does not move it vertically', b0.y === bp.y);
  ok('⚠️ a zoom keeps it centred on the line',
    Math.abs((bz.x + bz.w / 2) - 300) <= 0.51 && Math.abs((b0.x + b0.w / 2) - 300) <= 0.51);
  ok('⚠️ changing the line price moves the caption with it', Math.abs((b0.y - bd.y) - 60) <= 0.51,
    `${b0.y} -> ${bd.y}`);
  ok('⚠️ ...and the gap to the line is unchanged by any of it',
    [[b0, 200], [bp, 200], [bz, 200], [bd, 140]]
      .every(([b, lineY]) => Math.abs((lineY - (b.y + b.h)) - LABEL_GAP) <= 0.51));

  // ⚠️ AND IT DOES NOT MOVE ON ITS OWN. Same segment, same style, same answer — the property that
  // makes "the label must not randomly move when zooming or panning" checkable rather than a feeling.
  ok('⚠️ the same line and style always give the same place',
    JSON.stringify(at(base)) === JSON.stringify(at(base)));
  // Resizing the plot is the one thing that legitimately moves a right-aligned caption on a
  // horizontal line, because that line has no right-hand end of its own to sit at.
  const wide = labelBox([{ x: 0, y: 200 }, { x: 900, y: 200 }],
    sanitizeLabelStyle({ align: 'right' }), 80, { w: 900, h: 400 });
  const narrow = labelBox([{ x: 0, y: 200 }, { x: 600, y: 200 }],
    sanitizeLabelStyle({ align: 'right' }), 80, PLOT);
  ok('a right-aligned caption tracks the right edge when the plot resizes',
    Math.abs((900 - (wide.x + wide.w)) - (600 - (narrow.x + narrow.w))) <= 0.51);
}

// ── 8. the toolbar offers it beside the colour ─────────────────────────────────────────────────
console.log('\n8. the toolbar offers it beside the colour');

for (const id of LABELABLE) {
  const list = controlsFor(id);
  const ci = list.indexOf(CONTROL.COLOR);
  const li = list.indexOf(CONTROL.LABEL);
  ok(`${id}: the toolbar offers a caption control`, li !== -1);
  ok(`⚠️ ${id}: it sits IMMEDIATELY after the colour`, li === ci + 1,
    `${list.join(' > ')}`);
  const wi = list.indexOf(CONTROL.WIDTH);
  if (wi !== -1) {
    ok(`⚠️ ${id}: and before the stroke controls`, li < wi, `${list.join(' > ')}`);
  }
}
ok('⚠️ a text note still leads with its own body, not a caption',
  controlsFor('text')[0] === CONTROL.TEXT && !controlsFor('text').includes(CONTROL.LABEL));

// ── 9. the editor, rendered ────────────────────────────────────────────────────────────────────
console.log('\n9. the editor, rendered');

{
  const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-drawtext');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, 'DrawingToolbar.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/components/chart/DrawingToolbar.jsx')],
    bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    logLevel: 'silent', absWorkingDir: ROOT,
  });

  const dom = new JSDOM('<!doctype html><html><body><div id="page"></div></body></html>',
    { url: 'https://catalystpit.test/ticker/NVDA', pretendToBeVisual: true });
  const VW = 1440, VH = 900;
  Object.defineProperty(dom.window, 'innerWidth', { value: VW, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: VH, configurable: true });
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element',
    'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver',
    'Event', 'KeyboardEvent', 'FocusEvent', 'ResizeObserver']) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); }
  }
  for (const [k, v] of [['innerWidth', VW], ['innerHeight', VH]]) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    top: 300, bottom: 322, left: 400, right: 422, width: 22, height: 22, x: 400, y: 300,
    toJSON() { return this; },
  });

  const { act } = await import('react');
  const ReactDOMClient = await import('react-dom/client');
  const DrawingToolbar = (await import(pathToFileURL(out).href)).default;
  const doc = dom.window.document;
  const host = doc.getElementById('page');
  const root = ReactDOMClient.createRoot(host);

  const patches = [];
  let drawing = {
    id: 'h1', type: 'horizontal', locked: false,
    points: [{ time: 1700000000, price: 220.71 }],
    style: { color: PALETTE[55], width: 2, dash: 'solid' },
    label: '', labelStyle: sanitizeLabelStyle(undefined),
  };
  const render = () => act(async () => {
    root.render(React.createElement(DrawingToolbar, {
      theme: 'dark', drawing, box: { x: 40, y: 280, w: 200, h: 2 }, plot: { w: VW, h: 500 },
      onStyle: () => {}, onDelete: () => {}, onOpenSettings: () => {},
      onPatch: (patch) => { patches.push(patch); drawing = { ...drawing, ...patch }; },
    }));
  });
  const byLabel = (l) => [...doc.body.querySelectorAll('button,input,select')]
    .find((b) => b.getAttribute('aria-label') === l);
  await render();

  // ── THE BUTTON ──
  const bar = host.querySelector('[role="toolbar"]');
  ok('the toolbar rendered', !!bar);
  const names = [...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
  const ci = names.findIndex((n) => n === 'Color');
  ok('⚠️ the colour square is there', ci !== -1, names.join(' | '));
  ok('⚠️ a T button sits immediately beside it',
    /^(Add text to this drawing|Text: )/.test(names[ci + 1] || ''), names.join(' | '));
  const tBtn = [...bar.querySelectorAll('button')][ci + 1];
  ok('⚠️ ...and it is a compact "T", not the caption itself', tBtn.textContent.trim() === 'T',
    JSON.stringify(tBtn.textContent));
  const tw = /min-width:\s*(\d+)px/.exec(tBtn.getAttribute('style') || '');
  ok('⚠️ ...at the same size as the other toolbar buttons', tw && Number(tw[1]) === 22,
    tBtn.getAttribute('style'));

  // ── ADDING TEXT ──
  await act(async () => { tBtn.click(); });
  const field = byLabel('Drawing text');
  ok('⚠️ one tap opens the editor', !!field);
  // Guarded: when a mutation breaks the button order, the control this reaches for is simply absent.
  // Throwing there turns a clean failure into a stack trace that hides every assertion after it.
  const setValue = (el, v) => {
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    return true;
  };
  const clickLabel = async (l) => {
    const el = byLabel(l);
    ok(`the "${l}" control exists`, !!el);
    if (el) await act(async () => { el.click(); });
    return !!el;
  };
  const fire = (el, ev) => { if (el) el.dispatchEvent(ev); };
  await act(async () => { setValue(field, 'Previous Resistance'); });
  await act(async () => { fire(field, new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  ok('⚠️ typing and pressing Enter attaches the text',
    patches.at(-1)?.label === 'Previous Resistance', JSON.stringify(patches.at(-1)));
  ok('⚠️ ...and it does NOT create a second drawing', !('points' in (patches.at(-1) || {})));

  // ⚠️ ONE UNDO STEP PER EDIT, NOT ONE PER KEYSTROKE. Every patch goes through the undo stack, so a
  // per-character commit would make "undo" mean "delete one letter" nineteen times over.
  ok('⚠️ typing did not write once per character', patches.length === 1, `${patches.length} patches`);

  // ── EDITING IT ──
  await render();
  const field2 = byLabel('Drawing text');
  ok('reopening shows the current text', field2?.value === 'Previous Resistance', `${field2?.value}`);
  await act(async () => { setValue(field2, 'Prior High'); });
  await act(async () => { fire(field2, new dom.window.FocusEvent('focusout', { bubbles: true })); });
  ok('⚠️ editing and blurring updates it', drawing.label === 'Prior High', drawing.label);

  // ── STYLING IT ──
  await render();
  const before = { ...drawing.labelStyle };
  await clickLabel('Bold');
  ok('⚠️ bold toggles', drawing.labelStyle.bold === !before.bold);
  ok('⚠️ ...and changes nothing else', drawing.labelStyle.align === before.align
    && drawing.labelStyle.size === before.size && drawing.labelStyle.place === before.place);
  await render();
  await clickLabel('Align left');
  ok('⚠️ alignment changes', drawing.labelStyle.align === 'left');
  await render();
  await clickLabel('Below the line');
  ok('⚠️ placement changes', drawing.labelStyle.place === 'below');
  await render();
  const size = byLabel('Font size');
  ok('a font size control is offered', !!size);
  await act(async () => {
    if (size) {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
      setter.call(size, '18');
      size.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  ok('⚠️ font size changes', drawing.labelStyle.size === 18, `${drawing.labelStyle.size}`);
  ok('⚠️ ...and the line itself was never restyled',
    JSON.stringify(drawing.style) === JSON.stringify({ color: PALETTE[55], width: 2, dash: 'solid' }),
    JSON.stringify(drawing.style));

  // ── ITS COLOUR IS THE SHARED PALETTE ──
  await render();
  await clickLabel('Text color');
  const paletteEl = doc.body.querySelector('[data-cp-palette]');
  ok('⚠️ one tap on the text colour opens the shared palette', !!paletteEl);
  const swatches = paletteEl ? [...paletteEl.querySelectorAll('button')]
    .filter((b) => PALETTE.includes(b.getAttribute('aria-label'))) : [];
  ok('⚠️ ...with the whole palette in it, not a second colour system',
    swatches.length === paletteMetrics('fine').swatchCount, `${swatches.length}`);
  const want = PALETTE[85];
  await act(async () => { swatches.find((b) => b.getAttribute('aria-label') === want)?.click(); });
  ok('⚠️ picking a colour sets the CAPTION colour', drawing.labelStyle.color === normalizeHex(want),
    `${drawing.labelStyle.color}`);
  ok('⚠️ ...and not the line colour', drawing.style.color === PALETTE[55]);
  await render();
  await clickLabel('Match line color');
  ok('⚠️ and it can go back to inheriting the line colour', !('color' in drawing.labelStyle),
    JSON.stringify(drawing.labelStyle));

  // ── REMOVING IT ──
  await render();
  await clickLabel('Remove text');
  ok('⚠️ the text can be removed', drawing.label === '');
  ok('⚠️ ...without deleting the drawing', drawing.points.length === 1 && drawing.type === 'horizontal');
  ok('⚠️ ...and without touching its style', drawing.style.width === 2);

  // ── LIFECYCLE ──
  // ⚠️ THE EDITOR IS A Popover, which is what makes the lifecycle already correct: a page scroll, an
  // outside click and Escape all close it, and it unmounts with the toolbar when the selection is
  // cleared by CPChart's single dismissal path. This asserts it IS one rather than re-testing that.
  const barSrc = code(read('src/components/chart/DrawingToolbar.jsx'));
  ok('⚠️ the editor is a chart Popover, so it inherits the dismissal lifecycle',
    /<Popover[^>]*anchorRef=\{refs\.label\}[\s\S]{0,200}\{captionEditor\}/.test(barSrc));
  ok('⚠️ ...and the nested colour panel cannot outlive it',
    /open=\{open === CONTROL\.LABEL && colorOpen\}/.test(barSrc));
  ok('⚠️ ...nor survive a new selection',
    /setOpen\(null\); setColorOpen\(false\);/.test(barSrc));
  ok('the toolbar is still not position:fixed or sticky', !/position:\s*'(?:fixed|sticky)'/.test(barSrc));

  await act(async () => { root.unmount(); });
  ok('⚠️ unmounting the chart takes the editor with it',
    doc.body.querySelector('[data-cp-palette]') === null
    && [...doc.body.querySelectorAll('[role="menu"]')].length === 0);
}

// ── 10. the renderer asks, it does not decide ──────────────────────────────────────────────────
console.log('\n10. the renderer asks, it does not decide');

{
  const layer = code(read('src/components/chart/DrawingLayer.jsx'));
  ok('the layer places the caption with the shared geometry', /labelBox\(seg, lstyle,/.test(layer));
  ok('...measuring the real string rather than guessing a width',
    /ctx\.measureText\(tag\)\.width/.test(layer));
  ok('...using the font the style asks for', /ctx\.font = labelFont\(lstyle\)/.test(layer));
  ok('...through the sanitizer, so a legacy drawing cannot paint undefined',
    /sanitizeLabelStyle\(d\.source\.labelStyle\)/.test(layer));
  ok('⚠️ ...and it does no placement arithmetic of its own',
    !/start\.x \+ 4|Math\.max\(12, start\.y/.test(layer),
    'inlined placement in a paint loop is placement no test can reach');
  ok('⚠️ an absent caption colour still inherits the line colour',
    /lstyle\.color === undefined\s*\?\s*colour/.test(layer));
  // The caption is painted from the projection, which is the same one the strokes came from.
  ok('the caption is painted from the drawing\'s own segment',
    /const seg = d\.segments\[0\]/.test(layer));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
