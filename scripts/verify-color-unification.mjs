// ONE COLOUR PICKER, EVERYWHERE A CHART COLOUR IS CHOSEN.
//
//   node scripts/verify-color-unification.mjs
//
// ⚠️ WHY THIS EXISTS, AND IT IS MY MISTAKE. When the 90-swatch palette was built it was wired into the
// indicator settings ONLY — a scoping decision I made to avoid touching drawing behaviour, and then
// reported in terms ("one control, used by every indicator series") that read as broader than it was.
// Four separate six-swatch rows stayed behind: the drawing rail, the floating drawing toolbar, the
// drawing settings dialog, and a per-level colour CYCLER in the Fibonacci settings. A user selecting a
// horizontal line got seven colours while an EMA got ninety.
//
// So this suite does not check that a picker exists. It checks that no OTHER one does — because "there
// is one palette" is the property that was violated while every individual control worked fine.

import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PALETTE, PALETTE_GRID, PALETTE_COLUMNS, PALETTE_ROWS, COMMON_COLORS, normalizeHex, paletteMetrics, sizingForPointer } from '../src/lib/chart/color-palette.mjs';
import { indicatorColor, indicatorColors } from '../src/lib/chart/chart-theme.mjs';
import { sanitizeStyle, sanitizeFibLevels, coerceDrawing, createDrawing, DEFAULT_STYLE } from '../src/lib/chart/chart-drawings.mjs';
import { seriesColorValue, primaryColorValue, defaultParams } from '../src/lib/chart/chart-indicators.mjs';
import { setChartScope, __resetChartScope } from '../src/lib/chart/chart-scope.mjs';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// Every chart surface that can set a colour.
const SURFACES = [
  'src/components/chart/DrawingRail.jsx',
  'src/components/chart/DrawingToolbar.jsx',
  'src/components/chart/DrawingSettings.jsx',
  'src/components/chart/IndicatorBrowser.jsx',
];

// ── 1. no legacy palette survives on any chart colour control ──────────────────────────────────
console.log('\n1. no legacy palette survives on any chart colour control');

for (const f of SURFACES) {
  const src = code(read(f));
  // ⚠️ THE SIGNATURE OF A LEGACY ROW: mapping the six themed colours into buttons of its own.
  ok(`${path.basename(f)} does not map the themed six into its own swatches`,
    !/indicatorColors\([^)]*\)\.map/.test(src) && !/swatches\.map/.test(src),
    (src.match(/.{0,40}(?:indicatorColors\([^)]*\)|swatches)\.map.{0,40}/) || [''])[0]);
  // ⚠️ A `swatches` LOCAL IS ONLY ALLOWED FOR CHOOSING A DEFAULT INDEX, NEVER FOR RENDERING.
  // IndicatorBrowser keeps one so a newly added indicator gets an unused themed index — which is what
  // keeps a new instance theme-aware instead of frozen to a hex — and that is not a palette. Banning
  // the identifier outright failed on that legitimate use; what must not exist is a row built from it,
  // which the assertion above already covers.
  const hasLocal = /const swatches =/.test(src);
  const rendersIt = /swatches\.map|swatches\[/.test(src);
  ok(`${path.basename(f)} uses no swatches local for rendering`, !hasLocal || !rendersIt,
    hasLocal ? 'declared and rendered' : '');
  if (hasLocal) {
    ok(`${path.basename(f)}'s swatches local is only for default-index assignment`,
      /for \(let i = 0; i < swatches\.length; i \+= 1\) if \(!used\.has\(i\)\) return i;/.test(src));
  }
  // ...and the cycler, which was a palette walk wearing one button.
  ok(`${path.basename(f)} has no colour cycler`,
    !/color: nextIdx|nextIdx >= swatches/.test(src));
}
// The picker itself is the one place allowed to render the themed six — it offers them as an option.
{
  const picker = code(read('src/components/chart/ColorPicker.jsx'));
  ok('the picker is the only file that renders the themed six', /indicatorColors\(theme\)\.map/.test(picker));
  const others = SURFACES.filter((f) => /indicatorColors\([^)]*\)\.map/.test(code(read(f))));
  ok('⚠️ ...and it is the ONLY one', others.length === 0, others.join(', '));
}

// ── 2. every surface uses the shared control ───────────────────────────────────────────────────
console.log('\n2. every surface uses the shared control');

// ⚠️ "THE SHARED MODULE", NOT "THE SHARED COMPONENT NAME". ColorPicker.jsx exports two things: the
// palette itself (ColorPalettePanel) and a trigger-plus-popover wrapper around it (ColorPicker). Three
// surfaces want the wrapper — a swatch button sitting in a row of other settings. The drawing toolbar
// wants the palette on its own, because its colour square IS the trigger: putting a ColorPicker inside
// the toolbar's Popover produced a popover whose only content was another popover's trigger, and the
// ninety colours then needed a second tap. So the property is that every surface's colours come from
// this one module — which is what stops a palette being reimplemented — not that they all render the
// same wrapper.
for (const f of SURFACES) {
  const src = read(f);
  ok(`${path.basename(f)} imports from the shared colour module`,
    /import (?:ColorPicker|\{[^}]*\}) from '\.\/ColorPicker'/.test(src));
  ok(`${path.basename(f)} renders one of its controls`,
    /<(?:ColorPicker|ColorPalettePanel)[\s/>]/.test(code(src)));
}
// ⚠️ AND THE PALETTE IS BUILT IN EXACTLY ONE FILE. This is the assertion that the two exports did not
// become two palettes: whatever a surface mounts, only ColorPicker.jsx may walk PALETTE_GRID into
// swatches. A second file doing that is a second palette, however it is named.
{
  const builders = ['src/components/chart/ColorPicker.jsx', ...SURFACES]
    .filter((f) => /PALETTE_GRID\s*\.?\s*map|PALETTE\.map/.test(code(read(f))));
  ok('⚠️ exactly one file builds the swatch grid',
    builders.length === 1 && builders[0] === 'src/components/chart/ColorPicker.jsx',
    builders.join(', '));
}
// The drawing surfaces write through their own style channel, and only that.
ok('the rail sets the style for NEW drawings', /onStyle\(\{ color: v \}\)/.test(code(read('src/components/chart/DrawingRail.jsx'))));
ok('the toolbar recolours the SELECTED drawing', /onStyle\(\{ color: v \}\)/.test(code(read('src/components/chart/DrawingToolbar.jsx'))));
ok('the settings dialog patches that drawing\'s style',
  /patch\(\{ style: \{ \.\.\.drawing\.style, color: v \} \}\)/.test(code(read('src/components/chart/DrawingSettings.jsx'))));
ok('the fib level writes only that level', /setLevel\(i, \{ color: v \}\)/.test(code(read('src/components/chart/DrawingSettings.jsx'))));
ok('...and can still fall back to the drawing\'s colour',
  /setLevel\(i, \{ color: undefined \}\)/.test(code(read('src/components/chart/DrawingSettings.jsx'))));

// ── 3. a drawing colour survives persistence, in both shapes ───────────────────────────────────
console.log('\n3. a drawing colour survives persistence, in both shapes');

// ⚠️ THE BUG THAT WOULD HAVE MADE THE WHOLE FEATURE USELESS FOR DRAWINGS. sanitizeStyle forced the
// colour through Number(), and Number('#4A80F0') is NaN — so a colour picked from the palette became
// the DEFAULT on the next reload. Silently, and only on reload. Identical to the indicator-store bug.
ok('⚠️ an explicit hex survives sanitizeStyle', sanitizeStyle({ color: '#4a80f0', width: 2, dash: 'solid' }).color === '#4A80F0');
ok('a legacy index still survives it', sanitizeStyle({ color: 3, width: 2, dash: 'solid' }).color === 3);
ok('an unparseable colour falls back to the default', sanitizeStyle({ color: 'chartreuse' }).color === DEFAULT_STYLE.color);
ok('a missing colour falls back to the default', sanitizeStyle({}).color === DEFAULT_STYLE.color);
// A whole drawing, through the storage coercion.
{
  const hex = coerceDrawing({ type: 'horizontal', points: [{ time: 1700000000, price: 220.37 }],
    style: { color: '#DC3226', width: 2, dash: 'solid' } });
  ok('⚠️ a stored horizontal line keeps its hex', hex.style.color === '#DC3226');
  const idx = coerceDrawing({ type: 'trend', points: [{ time: 1, price: 1 }, { time: 2, price: 2 }],
    style: { color: 4, width: 1, dash: 'dashed' } });
  ok('a stored trend line keeps its legacy index', idx.style.color === 4);
  ok('...and its other style fields are untouched', idx.style.width === 1 && idx.style.dash === 'dashed');
}
// Fibonacci per-level colours, which are optional.
ok('⚠️ a fib level keeps an explicit hex', sanitizeFibLevels([{ ratio: 0.5, color: '#2A9E5B' }])[0].color === '#2A9E5B');
ok('a fib level keeps a legacy index', sanitizeFibLevels([{ ratio: 0.5, color: 2 }])[0].color === 2);
ok('⚠️ a fib level with no colour stays inheriting, not set to something',
  sanitizeFibLevels([{ ratio: 0.5 }])[0].color === undefined);
ok('...and an unparseable one also falls back to inheriting',
  sanitizeFibLevels([{ ratio: 0.5, color: 'nope' }])[0].color === undefined);

// ── 4. both shapes render, in both themes ──────────────────────────────────────────────────────
console.log('\n4. both shapes render, in both themes');

ok('a drawing hex renders verbatim in both themes',
  indicatorColor('light', '#DC3226') === '#DC3226' && indicatorColor('dark', '#DC3226') === '#DC3226');
ok('⚠️ a legacy drawing index still follows the theme',
  indicatorColor('light', 2) !== indicatorColor('dark', 2));
for (const theme of ['light', 'dark']) {
  ok(`every palette swatch is a usable colour in ${theme}`,
    PALETTE.every((c) => indicatorColor(theme, c) === c));
}

// ── 5. one drawing, one colour: nothing bleeds ─────────────────────────────────────────────────
console.log('\n5. one drawing, one colour: nothing bleeds');

{
  const a = createDrawing('horizontal', [{ time: 1700000000, price: 220 }], { color: '#DC3226', width: 2, dash: 'solid' });
  const b = createDrawing('horizontal', [{ time: 1700000000, price: 230 }], { color: '#4A80F0', width: 2, dash: 'solid' }, [a]);
  const t = createDrawing('trend', [{ time: 1, price: 1 }, { time: 2, price: 2 }], { color: '#2A9E5B', width: 2, dash: 'solid' }, [a, b]);
  ok('three drawings hold three colours',
    new Set([a.style.color, b.style.color, t.style.color]).size === 3);
  ok('...and they are the three chosen',
    a.style.color === '#DC3226' && b.style.color === '#4A80F0' && t.style.color === '#2A9E5B');
  a.style.color = '#000000';
  ok('⚠️ recolouring one drawing does not touch another',
    b.style.color === '#4A80F0' && t.style.color === '#2A9E5B');
  ok('...and ids are distinct, so a patch cannot hit two', new Set([a.id, b.id, t.id]).size === 3);

  // ⚠️ NO SHARED STYLE OBJECT, TESTED THE WAY IT COULD ACTUALLY HAPPEN. Three drawings built from three
  // separate literals cannot share anything, so mutating one proved nothing — the real risk is that
  // DrawingRail holds ONE `style` object and every new drawing is created from it. If createDrawing kept
  // that reference, recolouring any one line would recolour every line drawn with the current defaults.
  const railDefaults = { color: '#4A80F0', width: 2, dash: 'solid' };
  const one = createDrawing('horizontal', [{ time: 1700000000, price: 10 }], railDefaults);
  const two = createDrawing('horizontal', [{ time: 1700000000, price: 20 }], railDefaults, [one]);
  ok('two drawings made from ONE defaults object do not share it',
    one.style !== two.style && one.style !== railDefaults && two.style !== railDefaults);
  one.style.color = '#DC3226';
  ok('⚠️ ...so recolouring one leaves the other, and the defaults, alone',
    two.style.color === '#4A80F0' && railDefaults.color === '#4A80F0');
}

// ── 6. indicators are still independent, per instance and per series ───────────────────────────
console.log('\n6. indicators are still independent, per instance and per series');

{
  const ema8 = { id: 'ema', key: 'ema-1', params: { length: 8 }, color: '#F2B824' };
  const ema13 = { id: 'ema', key: 'ema-2', params: { length: 13 }, color: '#4A80F0' };
  const sma200 = { id: 'sma', key: 'sma-1', params: { length: 200 }, color: '#F5872E' };
  ok('EMA 8, EMA 13 and SMA 200 hold three colours',
    new Set([seriesColorValue('ema', ema8, 'ema'), seriesColorValue('ema', ema13, 'ema'),
      seriesColorValue('sma', sma200, 'sma')]).size === 3);
  ema8.color = '#DC3226';
  ok('⚠️ recolouring EMA 8 leaves EMA 13 alone', seriesColorValue('ema', ema13, 'ema') === '#4A80F0');

  const bb = { id: 'bollinger', key: 'b-1', colors: { upper: '#2A9E5B', lower: '#DC3226' } };
  ok('Bollinger bands carry independent colours',
    seriesColorValue('bollinger', bb, 'upper') === '#2A9E5B'
    && seriesColorValue('bollinger', bb, 'lower') === '#DC3226'
    && seriesColorValue('bollinger', bb, 'basis') !== '#2A9E5B');
  const macd = { id: 'macd', key: 'm-1', colors: { signal: '#8C48B4' } };
  ok('MACD series carry independent colours',
    seriesColorValue('macd', macd, 'signal') === '#8C48B4'
    && seriesColorValue('macd', macd, 'macd') !== '#8C48B4');
  void primaryColorValue; void defaultParams;
}

// ── 7. drawing colours persist per account ─────────────────────────────────────────────────────
console.log('\n7. drawing colours persist per account');

{
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://catalystpit.test/' });
  for (const k of ['window', 'document', 'localStorage']) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); }
  }
  const store = await import(`${pathToFileURL(path.join(ROOT, 'src/lib/chart/chart-drawing-store.mjs')).href}?t=${Date.now()}`);
  const { loadDrawings, saveDrawings } = store;

  __resetChartScope();
  setChartScope('user_alice', { resolved: true });
  const mine = [
    createDrawing('horizontal', [{ time: 1700000000, price: 220.37 }], { color: '#DC3226', width: 2, dash: 'solid' }),
    createDrawing('trend', [{ time: 1700000000, price: 1 }, { time: 1700000600, price: 2 }], { color: '#4A80F0', width: 2, dash: 'solid' }),
  ];
  saveDrawings('NVDA', mine);
  const back = loadDrawings('NVDA');
  ok('both drawings round-trip', back.length === 2, `${back.length}`);
  ok('⚠️ a horizontal line keeps its hex across a reload',
    back.find((d) => d.type === 'horizontal')?.style.color === '#DC3226');
  ok('⚠️ a trend line keeps its own, different hex',
    back.find((d) => d.type === 'trend')?.style.color === '#4A80F0');
  ok('...and the prices are untouched by any of this',
    back.find((d) => d.type === 'horizontal')?.points[0].price === 220.37);

  // ⚠️ ACCOUNT ISOLATION, WHICH THIS MUST NOT REOPEN.
  setChartScope('user_bob', { resolved: true });
  const bobs = loadDrawings('NVDA');
  ok('⚠️ a second account sees none of the first account\'s drawings', bobs.length === 0, `${bobs.length}`);
  saveDrawings('NVDA', [createDrawing('horizontal', [{ time: 1700000000, price: 999 }], { color: '#2A9E5B', width: 2, dash: 'solid' })]);
  setChartScope('user_alice', { resolved: true });
  const aliceAgain = loadDrawings('NVDA');
  ok('⚠️ ...and the first account\'s colours are intact afterwards',
    aliceAgain.find((d) => d.type === 'horizontal')?.style.color === '#DC3226');
  ok('...with no bleed from the other account',
    !aliceAgain.some((d) => d.style.color === '#2A9E5B'));
  __resetChartScope();
  const before = dom.window.localStorage.length;
  saveDrawings('NVDA', mine);
  ok('⚠️ an unresolved account still writes nothing', dom.window.localStorage.length === before);
  setChartScope('user_alice', { resolved: true });
}

// ── 8. the control, mounted, and it stays on screen ────────────────────────────────────────────
console.log('\n8. the control, mounted, and it stays on screen');

{
  const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-unify');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, 'ColorPicker.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/components/chart/ColorPicker.jsx')],
    bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    logLevel: 'silent', absWorkingDir: ROOT,
  });

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'https://catalystpit.test/', pretendToBeVisual: true });
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'Event']) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { act } = await import('react');
  const ReactDOMClient = await import('react-dom/client');
  const ColorPicker = (await import(pathToFileURL(out).href)).default;

  // ⚠️ THE PANEL MUST NOT OPEN OFF-SCREEN. The drawing rail runs down the LEFT edge and the floating
  // toolbar follows the selected drawing to any edge, so a popover pinned below-and-right is clipped to
  // nothing exactly where these controls actually live. The anchor is placed at each corner in turn.
  const CORNERS = [
    ['top-left', { top: 4, left: 4 }],
    ['top-right', { top: 4, left: 1180 }],
    ['bottom-left', { top: 760, left: 4 }],
    ['bottom-right', { top: 760, left: 1180 }],
  ];
  for (const theme of ['light', 'dark']) {
    for (const [where, pos] of CORNERS) {
      const host = dom.window.document.createElement('div');
      Object.assign(host.style, { position: 'absolute', top: `${pos.top}px`, left: `${pos.left}px` });
      dom.window.document.body.appendChild(host);
      // ⚠️ THE OVERRIDE HAS TO BE ON THE PROTOTYPE, not on this wrapper. The component measures its OWN
      // root element, which is a child of the wrapper — so a rect stubbed on the wrapper was never read
      // and every case saw jsdom's default all-zeros box, which placed the panel as if the anchor were at
      // the top-left corner. That looked exactly like the flip logic not working.
      dom.window.Element.prototype.getBoundingClientRect = () => ({
        top: pos.top, bottom: pos.top + 22, left: pos.left, right: pos.left + 90,
        width: 90, height: 22, x: pos.left, y: pos.top, toJSON() { return this; },
      });
      const picked = [];
      let mountError = null;
      const root = ReactDOMClient.createRoot(host, { onUncaughtError: (e) => { mountError = mountError || e; } });
      await act(async () => {
        root.render(React.createElement(ColorPicker, {
          theme, value: 2, compact: true, label: 'Drawing color', onChange: (v) => picked.push(v),
        }));
      });
      ok(`${theme}/${where}: the control mounts`, !mountError,
        mountError ? `${mountError.name}: ${mountError.message}` : '');
      const trigger = [...host.querySelectorAll('button')]
        .find((b) => /more colors/.test(b.getAttribute('aria-label') || ''));
      await act(async () => { trigger.click(); });
      const panel = host.querySelector('[data-cp-color-panel]');
      ok(`${theme}/${where}: the palette opens`, !!panel);
      if (!panel) continue;
      ok(`${theme}/${where}: the full palette is present`,
        [...panel.querySelectorAll('button')].filter((b) => PALETTE.includes(b.getAttribute('aria-label'))).length === PALETTE.length);
      // ⚠️ THE PLACEMENT ITSELF. Near the bottom it must open upward; near the left it must align left.
      const st = panel.getAttribute('style') || '';
      if (pos.top > 400) {
        ok(`⚠️ ${theme}/${where}: opens upward rather than off the bottom`, /bottom:\s*100%/.test(st), st.slice(0, 90));
      } else {
        ok(`${theme}/${where}: opens downward`, /top:\s*100%/.test(st), st.slice(0, 90));
      }
      if (pos.left < 200) {
        ok(`⚠️ ${theme}/${where}: aligns left rather than off the left edge`, /left:\s*0/.test(st), st.slice(0, 90));
      }
      await act(async () => { root.unmount(); });
      host.remove();
    }
  }
  // And a preset still reports a canonical hex, which is what every surface writes.
  const host2 = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host2);
  host2.getBoundingClientRect = () => ({ top: 300, bottom: 322, left: 500, right: 590, width: 90, height: 22, x: 500, y: 300 });
  const picked2 = [];
  const root2 = ReactDOMClient.createRoot(host2);
  await act(async () => {
    root2.render(React.createElement(ColorPicker, { theme: 'light', value: 0, onChange: (v) => picked2.push(v) }));
  });
  await act(async () => {
    [...host2.querySelectorAll('button')].find((b) => /more colors/.test(b.getAttribute('aria-label') || '')).click();
  });
  const target = PALETTE[25];
  await act(async () => {
    [...host2.querySelector('[data-cp-color-panel]').querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === target).click();
  });
  ok('picking a preset reports a canonical hex', picked2.at(-1) === normalizeHex(target), `${picked2.at(-1)}`);
  ok('the common row is offered when not compact',
    COMMON_COLORS.length > 0 && indicatorColors('light').length === 6);
}

// ── 8b. all 90 at once, with no scroll container ───────────────────────────────────────────────
console.log('\n8b. all 90 at once, with no scroll container');

{
  const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-unify2');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, 'ColorPicker.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/components/chart/ColorPicker.jsx')],
    bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    logLevel: 'silent', absWorkingDir: ROOT,
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'https://catalystpit.test/', pretendToBeVisual: true });
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'Event']) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { act } = await import('react');
  const ReactDOMClient = await import('react-dom/client');
  const ColorPicker = (await import(`${pathToFileURL(out).href}?t=${Date.now()}`)).default;

  // The grid's shape is arithmetic, so it can be asserted without a layout engine.
  ok('the palette is nine columns by ten rows', PALETTE_COLUMNS === 9 && PALETTE_ROWS === 10);
  ok('...which is exactly ninety swatches', PALETTE_COLUMNS * PALETTE_ROWS === 90
    && PALETTE_GRID.flat().length === 90);

  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    top: 200, bottom: 222, left: 500, right: 590, width: 90, height: 22, x: 500, y: 200,
    toJSON() { return this; },
  });
  const picked = [];
  const root = ReactDOMClient.createRoot(host);
  await act(async () => {
    root.render(React.createElement(ColorPicker, {
      theme: 'light', value: 2, compact: true, label: 'Drawing color', onChange: (v) => picked.push(v),
    }));
  });
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => /more colors/.test(b.getAttribute('aria-label') || '')).click();
  });
  const panel = host.querySelector('[data-cp-color-panel]');
  ok('the palette opens', !!panel);

  // ⚠️ EVERY SWATCH RENDERED, SIMULTANEOUSLY. Not "reachable after scrolling" — present in the DOM in
  // one open panel, which is what the 9x10 shape is for.
  const rendered = [...panel.querySelectorAll('button')]
    .map((b) => b.getAttribute('aria-label')).filter((l) => PALETTE.includes(l));
  ok('⚠️ all 90 swatches are rendered at once', rendered.length === 90, `${rendered.length}`);
  ok('...and they are the 90 distinct palette colours',
    new Set(rendered).size === 90 && PALETTE.every((c) => rendered.includes(c)));
  // ⚠️ IN THE SHAPE THE PALETTE DECLARES, read from the palette rather than written as a literal — the
  // grid has been 10x9 and is now 9x10, and an assertion spelling either out goes stale silently.
  const rows = [...panel.querySelectorAll('div')].filter((d) => d.children.length === PALETTE_COLUMNS);
  ok(`...arranged in ${PALETTE_ROWS} rows of ${PALETTE_COLUMNS}`,
    rows.length === PALETTE_ROWS, `${rows.length} rows of ${PALETTE_COLUMNS}`);

  // ⚠️ NO SCROLL CONTAINER, ANYWHERE IN THE PANEL. A scrollbar is exactly what the brief rules out, and
  // it is the kind of thing that creeps back in as a defensive maxHeight on a later change.
  const styleOf = (el) => (el.getAttribute('style') || '');
  const scrollers = [panel, ...panel.querySelectorAll('*')]
    .filter((el) => /overflow(?:-y|-x)?:\s*(?:auto|scroll)/i.test(styleOf(el)));
  ok('⚠️ nothing in the panel is a scroll container', scrollers.length === 0,
    scrollers.map((el) => styleOf(el).slice(0, 60)).join(' | '));
  ok('⚠️ ...and nothing caps its height', !/max-height/i.test(styleOf(panel)), styleOf(panel).slice(0, 90));
  const src = code(read('src/components/chart/ColorPicker.jsx'));
  ok('...in the source either', !/overflowY|maxHeight/.test(src));

  // Compact: a popover, not a modal.
  // ⚠️ THE SIZE IS PER POINTER KIND, AND THIS jsdom HAS NO matchMedia — so what renders here is the
  // DESKTOP palette, and that is what these two assertions describe. The touch sizing is checked from
  // paletteMetrics below and rendered for real in 8g.
  //
  // ⚠️ WHAT CHANGED AND WHY. This used to assert 280-360px, because desktop and touch shared one 32px
  // grid: 336px, "fits a phone with room to spare". On a desktop chart that is a panel rather than a
  // menu — it covers the drawing being recoloured, and the far column sat flush against the clipping
  // edge. Desktop is now 16px on a 2px gap, which is the density a charting palette wants.
  const fineM = paletteMetrics('fine');
  const coarseM = paletteMetrics('coarse');
  // `panel` is the picker's own positioned BOX; the palette content sits inside its padding, so the two
  // have different widths and an assertion has to say which one it means.
  const paletteBox = panel.querySelector('[data-cp-palette]');
  const w = /width:\s*(\d+)px/.exec(styleOf(panel));
  const pw = /width:\s*(\d+)px/.exec(styleOf(paletteBox));
  ok('⚠️ the desktop palette content is exactly the width the metrics describe',
    pw && Number(pw[1]) === fineM.contentWidth, `${pw ? pw[1] : '?'}px vs ${fineM.contentWidth}px`);
  ok('⚠️ ...and the box around it adds only its own padding and border',
    w && Number(w[1]) === fineM.contentWidth + fineM.hostPad * 2 + 2,
    `${w ? w[1] : '?'}px vs ${fineM.contentWidth + fineM.hostPad * 2 + 2}px`);
  ok('⚠️ ...which is materially smaller than the 336px grid it replaces',
    fineM.contentWidth <= 200, `${fineM.contentWidth}px`);
  ok('⚠️ ...and the touch sizing is NOT shrunk with it',
    coarseM.swatch >= 28 && coarseM.swatch > fineM.swatch,
    `touch ${coarseM.swatch}px, desktop ${fineM.swatch}px`);
  ok('⚠️ ...while the touch palette still fits a 390px phone',
    coarseM.contentWidth + coarseM.hostPad * 2 + 2 <= 390 - 8,
    `${coarseM.contentWidth + coarseM.hostPad * 2 + 2}px in 390px`);
  ok('⚠️ the rendered swatch is the metric swatch', (() => {
    const first = [...panel.querySelectorAll('button')]
      .find((b) => PALETTE.includes(b.getAttribute('aria-label')));
    const m = /width:\s*(\d+)px/.exec(first?.getAttribute('style') || '');
    return m && Number(m[1]) === fineM.swatch;
  })(), `expected ${fineM.swatch}px`);
  // ⚠️ AND THE GRID IS INSET FROM ITS OWN EDGES. This is the fix for the clipped purple column: the grid
  // used to be exactly as wide as the box holding it, measured in a real browser as 0.00px of padding on
  // both sides, so the 2px selection ring on an edge column fell outside and was cut off by the
  // popover's overflow. The inset is symmetrical by construction — one number used on both sides.
  ok('⚠️ the grid is inset from both edges by the selection ring',
    fineM.contentWidth === fineM.gridWidth + fineM.ring * 2
    && coarseM.contentWidth === coarseM.gridWidth + coarseM.ring * 2,
    `${fineM.contentWidth} vs ${fineM.gridWidth} + 2x${fineM.ring}`);
  const padStyle = styleOf(paletteBox);
  ok('⚠️ ...and the panel actually applies it on both sides',
    new RegExp(`padding-left:\\s*${fineM.ring}px`).test(padStyle)
    && new RegExp(`padding-right:\\s*${fineM.ring}px`).test(padStyle), padStyle.slice(0, 120));
  // The custom controls stay, below the grid.
  ok('the hex field is still offered', !!panel.querySelector('input[aria-label="Hex color"]'));
  ok('the native picker is still offered', !!panel.querySelector('input[type="color"]'));
  // Null-safe deliberately: a missing palette element must FAIL this assertion, not crash the suite
  // before the sections below it have run.
  const paletteEl = panel.querySelector('[data-cp-palette]');
  ok('...and both sit BELOW the preset grid',
    !!paletteEl && styleOf(paletteEl).includes('column')
    && panel.innerHTML.indexOf(PALETTE[0]) < panel.innerHTML.indexOf('Hex color'));

  // Selecting a preset applies immediately and closes.
  const target = PALETTE[47];
  await act(async () => {
    [...panel.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === target).click();
  });
  ok('⚠️ picking a preset applies it immediately', picked.at(-1) === normalizeHex(target), `${picked.at(-1)}`);
  ok('⚠️ ...and closes the palette', host.querySelector('[data-cp-color-panel]') === null);
  await act(async () => { root.unmount(); });
}

// ── 8c. edge placement keeps the COMPLETE palette on screen ────────────────────────────────────
console.log('\n8c. edge placement keeps the complete palette on screen');

{
  const out = path.join(ROOT, 'node_modules', '.cache', 'cp-unify2', 'ColorPicker.mjs');
  const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { url: 'https://catalystpit.test/', pretendToBeVisual: true });
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'Event']) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { act } = await import('react');
  const ReactDOMClient = await import('react-dom/client');
  const ColorPicker = (await import(`${pathToFileURL(out).href}?t=${Date.now()}b`)).default;

  const VW = dom.window.innerWidth, VH = dom.window.innerHeight;
  // The panel's size is arithmetic, so the expected geometry is known exactly.
  const PANEL_W = PALETTE_COLUMNS * 18 + (PALETTE_COLUMNS - 1) * 4 + 16;
  const PANEL_H = PALETTE_ROWS * 18 + (PALETTE_ROWS - 1) * 4 + 34 + 36 + 26 + 16;

  const CASES = [
    ['top-left', 4, 4], ['top-right', 4, VW - 94],
    ['bottom-left', VH - 30, 4], ['bottom-right', VH - 30, VW - 94],
    ['middle', Math.round(VH / 2), Math.round(VW / 2)],
    // ⚠️ THE CASE THAT ACTUALLY TESTS THE SIZE ESTIMATE. At the extreme edges there is almost no room
    // below, so even a wildly wrong estimate still flips upward and the geometry works out — a mutation
    // that shrank the estimate to 40px passed every corner. Here there is SOME room below (about 110px)
    // but not enough for the 306px panel: only a correct estimate chooses to open upward, and a panel
    // that thinks it is small opens downward and runs off the bottom.
    ['near-bottom-partial-room', VH - 140, Math.round(VW / 2)],
    ['near-left-partial-room', Math.round(VH / 2), 40],
  ];
  for (const theme of ['light', 'dark']) {
    for (const [where, top, left] of CASES) {
      const host = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(host);
      dom.window.Element.prototype.getBoundingClientRect = () => ({
        top, bottom: top + 22, left, right: left + 90, width: 90, height: 22, x: left, y: top,
        toJSON() { return this; },
      });
      const root = ReactDOMClient.createRoot(host);
      await act(async () => {
        root.render(React.createElement(ColorPicker, { theme, value: 0, compact: true, onChange: () => {} }));
      });
      await act(async () => {
        [...host.querySelectorAll('button')].find((b) => /more colors/.test(b.getAttribute('aria-label') || '')).click();
      });
      const panel = host.querySelector('[data-cp-color-panel]');
      ok(`${theme}/${where}: the palette opens`, !!panel);
      if (!panel) { await act(async () => { root.unmount(); }); host.remove(); continue; }

      // Still all ninety, whatever the placement.
      const n = [...panel.querySelectorAll('button')]
        .filter((b) => PALETTE.includes(b.getAttribute('aria-label'))).length;
      ok(`⚠️ ${theme}/${where}: all 90 swatches are still rendered`, n === 90, `${n}`);

      // ⚠️ AND THE WHOLE PANEL LANDS INSIDE THE VIEWPORT. Computed from the anchor rect and the side the
      // component chose, which is the only thing jsdom can tell us — but it is the actual decision.
      const st = panel.getAttribute('style') || '';
      const openedUp = /bottom:\s*100%/.test(st);
      const alignedLeft = /left:\s*0/.test(st);
      const panelTop = openedUp ? top - 4 - PANEL_H : top + 22 + 4;
      const panelLeft = alignedLeft ? left : left + 90 - PANEL_W;
      ok(`⚠️ ${theme}/${where}: the whole palette fits vertically on screen`,
        panelTop >= -1 && panelTop + PANEL_H <= VH + 1,
        `top ${panelTop}, bottom ${panelTop + PANEL_H}, viewport ${VH}, openedUp=${openedUp}`);
      ok(`⚠️ ${theme}/${where}: ...and horizontally`,
        panelLeft >= -1 && panelLeft + PANEL_W <= VW + 1,
        `left ${panelLeft}, right ${panelLeft + PANEL_W}, viewport ${VW}, alignedLeft=${alignedLeft}`);
      await act(async () => { root.unmount(); });
      host.remove();
    }
  }
}

// ── 8d. both sizings fit their target, and neither is a literal ────────────────────────────────
console.log('\n8d. both sizings fit their target, and neither is a literal');

{
  // ⚠️ ARITHMETIC IMPORTED, NOT RESTATED. This block used to open `const SW = 32, GAP = 4, PAD = 8` and
  // recompute the panel from those — a copy of the component's constants living in the test, which is
  // exactly how a suite ends up describing a palette that has since changed shape. The numbers now come
  // from paletteMetrics, the one place that owns them.
  for (const [kind, vw, vh] of [['fine', 1440, 900], ['coarse', 390, 844]]) {
    const m = paletteMetrics(kind);
    const boxW = m.contentWidth + m.hostPad * 2 + 2;
    const boxH = m.contentHeight + m.hostPad * 2 + 2;
    ok(`⚠️ ${kind}: no horizontal scrolling at ${vw}px`, boxW <= vw - 16, `${boxW}px in ${vw}px`);
    ok(`⚠️ ${kind}: no vertical scrolling at ${vh}px`, boxH <= vh - 16, `${boxH}px in ${vh}px`);
    ok(`${kind}: all 90 are in that one panel`, PALETTE_COLUMNS * PALETTE_ROWS === 90);
    ok(`${kind}: the grid is inset by the ring on both sides`,
      m.contentWidth === m.gridWidth + m.ring * 2);
  }
  const fineM = paletteMetrics('fine');
  const coarseM = paletteMetrics('coarse');
  // ⚠️ THE TWO REQUIREMENTS THAT PULL IN OPPOSITE DIRECTIONS, stated as the assertions they are: dense
  // enough to scan on a desktop, big enough to hit with a thumb. One number cannot do both, which is
  // why there are two sizings rather than one compromise.
  ok('⚠️ desktop is dense enough to scan', fineM.swatch <= 20, `${fineM.swatch}px`);
  ok('⚠️ ...and still large enough to read as a colour', fineM.swatch >= 12, `${fineM.swatch}px`);
  ok('⚠️ touch stays a comfortable tap target', coarseM.swatch >= 28, `${coarseM.swatch}px`);
  ok('⚠️ ...and was not shrunk to match the desktop', coarseM.swatch > fineM.swatch);
  ok('⚠️ the desktop popover is materially smaller than the 336px one it replaces',
    fineM.contentWidth + fineM.hostPad * 2 + 2 <= 200,
    `${fineM.contentWidth + fineM.hostPad * 2 + 2}px`);

  // The palette module must actually derive those numbers rather than carry them as literals.
  const psrc = read('src/lib/chart/color-palette.mjs');
  ok('the grid width is derived from the palette shape',
    /gridWidth = PALETTE_COLUMNS \* s\.swatch \+ \(PALETTE_COLUMNS - 1\) \* s\.gap/.test(psrc));
  ok('...and the grid height likewise',
    /gridHeight = PALETTE_ROWS \* s\.swatch \+ \(PALETTE_ROWS - 1\) \* s\.gap/.test(psrc));
  ok('...and the content width adds the selection ring on both sides',
    /contentWidth: gridWidth \+ SELECTION_RING \* 2/.test(psrc));

  // The component must take them from there rather than declaring its own.
  const src = read('src/components/chart/ColorPicker.jsx');
  ok('⚠️ the picker declares no swatch size of its own',
    !/const GRID_SWATCH|const GRID_GAP/.test(code(src)),
    'a local swatch constant is how the desktop and the phone ended up sharing one grid');
  ok('...and sizes every box from the metrics it was given',
    /size=\{m\.swatch\}/.test(src) && /width: m\.contentWidth/.test(src));
  // ⚠️ AND THE SWATCHES ARE BORDER-BOX, so the arithmetic above describes the boxes the browser lays
  // out. They were content-box with a 1px border, making every 32px swatch 34px and every row 18px
  // wider than the panel sized to hold it — nine columns overflowing a nine-column panel.
  ok('⚠️ the swatch box is the size the arithmetic assumes', /boxSizing: 'border-box'/.test(
    (/function Swatch\(\{[\s\S]*?\n\}/.exec(src) || [''])[0],
  ));
  ok('...and still has no scroll container', !/overflowY|maxHeight/.test(code(src)));
}
// ── 8e. every drawing type gets the expanded palette ───────────────────────────────────────────
console.log('\n8e. every drawing type gets the expanded palette');

{
  // ⚠️ ONE COLOUR PATH FOR EVERY TOOL. Each drawing stores its colour in `style.color` and the layer
  // resolves it the same way, so a tool cannot end up on a different palette — which is what makes
  // "verify horizontal line, trend line and rectangle" a property rather than three separate checks.
  const { TOOLS } = await import('../src/lib/chart/chart-drawings.mjs');
  const styled = Object.values(TOOLS).filter((t) => !t.transient);
  ok('there are several drawing tools to cover', styled.length >= 5, `${styled.length}`);
  for (const t of ['horizontal', 'trend', 'rectangle', 'ray', 'vertical', 'fib', 'text']) {
    if (!TOOLS[t]) continue;
    const pts = Array.from({ length: TOOLS[t].points }, (_, i) => ({ time: 1700000000 + i * 60, price: 100 + i }));
    const made = createDrawing(t, pts, { color: PALETTE[55], width: 2, dash: 'solid' });
    ok(`a ${t} accepts a colour from the expanded palette`, made?.style.color === PALETTE[55],
      `${made?.style.color}`);
    const back = coerceDrawing({ type: t, points: pts, style: { color: PALETTE[55], width: 2, dash: 'solid' } });
    ok(`...and keeps it across a reload`, back?.style.color === PALETTE[55]);
  }
  // The layer paints every drawing through one resolver, so none can be on a different palette.
  const layer = code(read('src/components/chart/DrawingLayer.jsx'));
  ok('the layer resolves every drawing colour through one call',
    (layer.match(/indicatorColor\(stateRef\.current\.theme, d\.style\.color\)/g) || []).length >= 1);

  // The default drawing colour is preserved: still the themed index, not a palette hex.
  ok('⚠️ the default drawing colour is unchanged', DEFAULT_STYLE.color === 0);
  ok('...so a new drawing still follows the theme',
    indicatorColor('light', DEFAULT_STYLE.color) !== indicatorColor('dark', DEFAULT_STYLE.color));
  const picker = read('src/components/chart/ColorPicker.jsx');
  ok('...and the themed defaults are still offered in the picker', /THEME-AWARE/.test(picker));
}

// ── 8f. the drawing toolbar's colour square opens the palette in ONE tap ────────────────────────
console.log('\n8f. the drawing toolbar colour square opens the palette in one tap');

// ⚠️ THE BUG THIS SECTION EXISTS FOR, AND IT WAS MINE. The toolbar's colour button opened a Popover
// whose only content was a COMPACT ColorPicker — and a compact ColorPicker is a trigger plus its own
// popover. So tapping the colour square produced a small box containing one blue swatch and a caret,
// and the ninety colours needed a SECOND tap on that caret. Every unit test passed: the palette
// existed, the toolbar used the shared control, the swatches were all there once you got to them. What
// no test asserted was the number of taps between selecting a drawing and seeing a colour.
//
// So this renders the real toolbar, clicks the real button ONCE, and counts swatches.
{
  const { build: esbuild } = await import('esbuild');
  const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-unify-toolbar');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, 'DrawingToolbar.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/components/chart/DrawingToolbar.jsx')],
    bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    logLevel: 'silent', absWorkingDir: ROOT,
  });
  void esbuild;

  // Both viewports the brief names. The phone is the one that mattered: a caret is not a tap target.
  const VIEWPORTS = [['phone', 390, 844], ['desktop', 1440, 900]];
  for (const [where, vw, vh] of VIEWPORTS) {
    const dom = new JSDOM('<!doctype html><html><body><div id="page"></div></body></html>',
      { url: 'https://catalystpit.test/ticker/NVDA', pretendToBeVisual: true });
    Object.defineProperty(dom.window, 'innerWidth', { value: vw, configurable: true });
    Object.defineProperty(dom.window, 'innerHeight', { value: vh, configurable: true });
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
      'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver',
      'Event', 'ResizeObserver']) {
      try { globalThis[k] = dom.window[k]; }
      catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); }
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // ⚠️ placeFor reads globalThis.innerWidth/innerHeight when no viewport is passed, and the loop above
    // copies `window` rather than its dimensions — so without these the placement arithmetic is NaN, and
    // every geometry assertion below reads a MISSING style rather than a wrong one.
    for (const [k, v] of [['innerWidth', vw], ['innerHeight', vh]]) {
      Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    }
    // The colour square, roughly where a toolbar floating mid-chart puts it.
    const ANCHOR = { top: 300, bottom: 322, left: 60, right: 82, width: 22, height: 22, x: 60, y: 300 };
    dom.window.Element.prototype.getBoundingClientRect = () => ({ ...ANCHOR, toJSON() { return this; } });

    const { act } = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const DrawingToolbar = (await import(`${pathToFileURL(out).href}?v=${where}`)).default;

    const applied = [];
    const drawing = {
      id: 'd1', type: 'horizontal', locked: false,
      points: [{ time: 1700000000, price: 101.5 }],
      style: { color: PALETTE[55], width: 2, dash: 'solid' },
    };
    const host = dom.window.document.getElementById('page');
    const root = ReactDOMClient.createRoot(host);
    const render = (d) => act(async () => {
      root.render(React.createElement(DrawingToolbar, {
        theme: 'dark', drawing: d, box: { x: 40, y: 280, w: 200, h: 2 }, plot: { w: vw, h: 500 },
        onStyle: (s) => applied.push(s), onPatch: () => {}, onDelete: () => {}, onOpenSettings: () => {},
      }));
    });
    await render(drawing);

    const colourBtn = [...host.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'Color');
    ok(`${where}: the toolbar has a colour square`, !!colourBtn);

    // ── ONE TAP ──
    await act(async () => { colourBtn.click(); });
    // The Popover is a portal in document.body, so look at the whole document.
    const doc = dom.window.document;
    const swatchesOf = (rootEl) => [...rootEl.querySelectorAll('button')]
      .map((b) => b.getAttribute('aria-label')).filter((l) => PALETTE.includes(l));
    const opened = swatchesOf(doc.body);
    ok(`⚠️ ${where}: ONE tap on the colour square shows all 90 swatches`,
      opened.length === 90, `${opened.length} swatches after one tap`);
    ok(`⚠️ ${where}: ...and they are the 90 distinct palette colours`,
      new Set(opened).size === 90 && PALETTE.every((c) => opened.includes(c)));

    // ── AND NO INTERMEDIATE CONTROL ──
    // ⚠️ THE POSITIVE CONTROL FOR THIS MATCHER is the picker's own trigger, which still exists and
    // still carries this label on the rail and settings surfaces — so a pattern that could never match
    // anything would be caught there rather than passing silently here.
    const nested = [...doc.body.querySelectorAll('button')]
      .filter((b) => /more colors/.test(b.getAttribute('aria-label') || ''));
    ok(`⚠️ ${where}: no second colour control stands between the square and the palette`,
      nested.length === 0, `${nested.length} nested trigger(s)`);

    const paletteEl = doc.body.querySelector('[data-cp-palette]');
    ok(`${where}: the palette mounted is the shared one`, !!paletteEl);
    ok(`${where}: the custom hex field came with it`,
      !!doc.body.querySelector('input[aria-label="Hex color"]'));
    ok(`${where}: ...and the native colour input`,
      !!doc.body.querySelector('input[type="color"]'));

    // ── THE CURRENT COLOUR READS AS SELECTED ──
    const selected = [...doc.body.querySelectorAll('button')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.getAttribute('aria-label'));
    ok(`⚠️ ${where}: the drawing's current colour is shown as selected`,
      selected.length === 1 && selected[0] === PALETTE[55], selected.join(', '));

    // ── THE WHOLE PALETTE IS INSIDE THE VIEWPORT ──
    // The portal is placed by placeFor in viewport coordinates, so its own inline style is the answer.
    const portal = paletteEl?.closest('[role="menu"]');
    ok(`${where}: the palette is in the portalled popover`, !!portal);
    // Null-safe on purpose: without the fix there is no palette and no portal, and the geometry
    // assertions below must report that as failures rather than crash the suite mid-section.
    const num = (prop) => {
      const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`).exec(portal?.getAttribute('style') || '');
      return m ? Number(m[1]) : null;
    };
    const boxW = num('width'), boxMaxH = num('max-height');
    const boxTop = num('top') != null ? num('top') : vh - num('bottom') - boxMaxH;
    const boxLeft = num('left');
    ok(`⚠️ ${where}: ...and the popover's box is inside the viewport horizontally`,
      boxLeft >= 0 && boxLeft + boxW <= vw, `left ${boxLeft}, width ${boxW}, viewport ${vw}`);
    ok(`⚠️ ${where}: ...and vertically`,
      boxTop >= 0 && boxTop + boxMaxH <= vh, `top ${boxTop}, maxHeight ${boxMaxH}, viewport ${vh}`);
    // ⚠️ AND IT IS TALL ENOUGH FOR THE WHOLE PANEL, which is the point of passing a height rather than a
    // maxHeight: a box clamped to the 360px list default would scroll the palette it has room for.
    //
    // ⚠️ THE WHOLE PANEL, NOT JUST THE GRID — and that distinction is why this is written out. Checking
    // only the swatch rows (356px) passed against a box capped at the 360px default, so every mutation
    // that dropped the height on the floor went unnoticed here. The theme-aware row and the custom
    // controls are part of what must be visible without scrolling, so they are part of the number.
    // ⚠️ THE METRICS, NOT LITERALS. jsdom has no matchMedia, so the toolbar resolves the DESKTOP sizing
    // here; the touch sizing is exercised in 8g with matchMedia stubbed, and both are measured for real
    // in verify-picker-layout.
    const jm = paletteMetrics('fine');
    ok(`⚠️ ${where}: ...and tall enough to show the whole panel without scrolling`,
      boxMaxH >= jm.contentHeight, `maxHeight ${boxMaxH} for a ${jm.contentHeight}px panel`);
    ok(`${where}: ...and wide enough for every column plus its inset`,
      boxW >= jm.contentWidth, `width ${boxW} vs ${jm.contentWidth}`);

    // ── PICKING APPLIES IMMEDIATELY AND DISMISSES ──
    const target = PALETTE[12];
    // Guarded so a missing swatch fails the assertion below rather than throwing here.
    await act(async () => {
      [...doc.body.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === target)?.click();
    });
    ok(`⚠️ ${where}: picking a swatch recolours the drawing immediately`,
      applied.at(-1)?.color === normalizeHex(target), JSON.stringify(applied.at(-1)));
    ok(`⚠️ ${where}: ...and the palette closes`, !doc.body.querySelector('[data-cp-palette]'));

    // ── REOPENING SHOWS THE NEW COLOUR AS SELECTED ──
    await render({ ...drawing, style: { ...drawing.style, color: normalizeHex(target) } });
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Color').click();
    });
    const reSelected = [...doc.body.querySelectorAll('button')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.getAttribute('aria-label'));
    ok(`⚠️ ${where}: reopening shows the newly picked colour as selected`,
      reSelected.length === 1 && reSelected[0] === target, reSelected.join(', '));
    // Still one tap the second time — the palette, not a control that opens one.
    ok(`⚠️ ${where}: ...and it is still one tap to the palette`,
      swatchesOf(doc.body).length === 90);

    await act(async () => { root.unmount(); });
  }

  // The source says the same thing: the toolbar mounts the palette, not a picker.
  const bar = code(read('src/components/chart/DrawingToolbar.jsx'));
  ok('⚠️ the toolbar no longer wraps a ColorPicker in a Popover', !/<ColorPicker/.test(bar));
  ok('...it mounts the shared palette directly', /<ColorPalettePanel/.test(bar));
  ok('...inside the portalled Popover, so the chart cannot clip it',
    /<Popover[^>]*anchorRef=\{refs\.color\}[\s\S]{0,300}<ColorPalettePanel/.test(bar));
  ok('...placed by a known height rather than capped and scrolled',
    /height=\{cm\.contentHeight\}/.test(bar));
  ok('...sized from the metrics the host resolved, so panel and placement agree',
    /const cm = usePaletteMetrics\(\);/.test(bar) && /metrics=\{cm\}/.test(bar));
  ok('...and it still writes through the drawing style channel',
    /onStyle\(\{ color: v \}\)/.test(bar));
}

// ── 8g. the sizing follows the POINTER, and the component honours it ───────────────────────────
console.log('\n8g. the sizing follows the pointer, and the component honours it');

// ⚠️ THE AXIS IS POINTER KIND, NOT SCREEN WIDTH. A narrow desktop window is still a mouse and wants the
// dense grid; a wide tablet is still a thumb and wants the big one. Sizing off viewport width gets both
// of those wrong, and a user-agent branch gets them wrong differently — and is banned outright in this
// codebase. So the decision is `(pointer: coarse)`, and this section drives the real component with that
// query stubbed both ways.
{
  ok('the pure decision maps a coarse pointer to the large sizing',
    sizingForPointer(true) === 'coarse' && sizingForPointer(false) === 'fine');

  const { build: esbuild } = await import('esbuild');
  const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-unify-pointer');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, 'DrawingToolbar.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/components/chart/DrawingToolbar.jsx')],
    bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    logLevel: 'silent', absWorkingDir: ROOT,
  });
  void esbuild;

  for (const [kind, coarse, vw, vh] of [['fine', false, 1440, 900], ['coarse', true, 390, 844]]) {
    const m = paletteMetrics(kind);
    const dom = new JSDOM('<!doctype html><html><body><div id="page"></div></body></html>',
      { url: 'https://catalystpit.test/ticker/NVDA', pretendToBeVisual: true });
    Object.defineProperty(dom.window, 'innerWidth', { value: vw, configurable: true });
    Object.defineProperty(dom.window, 'innerHeight', { value: vh, configurable: true });
    // ⚠️ THE STUB IS THE POINT OF THIS SECTION. jsdom has no matchMedia at all, which is why every other
    // jsdom section here renders the desktop sizing — that is the component's SSR-safe default, not a
    // measurement of a phone.
    dom.window.matchMedia = (q) => ({
      matches: /pointer:\s*coarse/.test(q) ? coarse : false,
      media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
      'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver',
      'Event', 'ResizeObserver']) {
      try { globalThis[k] = dom.window[k]; }
      catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); }
    }
    globalThis.matchMedia = dom.window.matchMedia;
    for (const [k, v] of [['innerWidth', vw], ['innerHeight', vh]]) {
      Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    dom.window.Element.prototype.getBoundingClientRect = () => ({
      top: 300, bottom: 322, left: 60, right: 82, width: 22, height: 22, x: 60, y: 300,
      toJSON() { return this; },
    });

    const { act } = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const DrawingToolbar = (await import(`${pathToFileURL(out).href}?p=${kind}`)).default;
    const host = dom.window.document.getElementById('page');
    const root = ReactDOMClient.createRoot(host);
    await act(async () => {
      root.render(React.createElement(DrawingToolbar, {
        theme: 'dark',
        drawing: { id: 'd1', type: 'horizontal', locked: false,
          points: [{ time: 1700000000, price: 101.5 }],
          style: { color: PALETTE[85], width: 2, dash: 'solid' } },
        box: { x: 40, y: 280, w: 200, h: 2 }, plot: { w: vw, h: 500 },
        onStyle: () => {}, onPatch: () => {}, onDelete: () => {}, onOpenSettings: () => {},
      }));
    });
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Color').click();
    });
    const doc = dom.window.document;
    const paletteEl = doc.body.querySelector('[data-cp-palette]');
    ok(`${kind}: the palette opened`, !!paletteEl);
    if (!paletteEl) continue;
    const styleOf = (el) => (el?.getAttribute('style') || '');
    const swatch = [...paletteEl.querySelectorAll('button')]
      .find((b) => PALETTE.includes(b.getAttribute('aria-label')));
    const sw = /width:\s*(\d+)px/.exec(styleOf(swatch));
    ok(`⚠️ ${kind}: the swatch is the ${kind} size`, sw && Number(sw[1]) === m.swatch,
      `${sw ? sw[1] : '?'}px, expected ${m.swatch}px`);
    const pwm = /width:\s*(\d+)px/.exec(styleOf(paletteEl));
    ok(`⚠️ ${kind}: the panel is the ${kind} width`, pwm && Number(pwm[1]) === m.contentWidth,
      `${pwm ? pwm[1] : '?'}px, expected ${m.contentWidth}px`);
    ok(`⚠️ ${kind}: the grid is inset on BOTH sides by the selection ring`,
      new RegExp(`padding-left:\\s*${m.ring}px`).test(styleOf(paletteEl))
      && new RegExp(`padding-right:\\s*${m.ring}px`).test(styleOf(paletteEl)), styleOf(paletteEl).slice(0, 120));
    // All ninety, whichever sizing: density is not achieved by dropping colours.
    const n = [...paletteEl.querySelectorAll('button')]
      .filter((b) => PALETTE.includes(b.getAttribute('aria-label'))).length;
    ok(`⚠️ ${kind}: all 90 colours are still there`, n === 90, `${n}`);
    // The custom controls survive the compaction.
    ok(`${kind}: the hex field is still offered`, !!doc.body.querySelector('input[aria-label="Hex color"]'));
    ok(`${kind}: the native picker is still offered`, !!doc.body.querySelector('input[type="color"]'));
    ok(`${kind}: the theme-aware row is still offered`,
      !!doc.body.querySelector('button[aria-label="Theme color 1"]'));
    // And the popover it is placed in is sized for THIS sizing, not the other one.
    const portal = paletteEl.closest('[role="menu"]');
    const bw = /width:\s*(\d+)px/.exec(styleOf(portal));
    ok(`⚠️ ${kind}: the popover was placed for the ${kind} palette`,
      bw && Number(bw[1]) === m.contentWidth, `${bw ? bw[1] : '?'}px, expected ${m.contentWidth}px`);
    await act(async () => { root.unmount(); });
  }
  // ⚠️ POSITIVE CONTROL: the two sizings must actually differ, or every assertion above passes against a
  // component that ignores the pointer entirely.
  ok('⚠️ the two sizings are genuinely different',
    paletteMetrics('fine').swatch !== paletteMetrics('coarse').swatch
    && paletteMetrics('fine').contentWidth !== paletteMetrics('coarse').contentWidth);
}

// ── 9. nothing else about drawings moved ───────────────────────────────────────────────────────
console.log('\n9. nothing else about drawings moved');

{
  const model = read('src/lib/chart/chart-drawings.mjs');
  ok('anchors are still { time, price }',
    /points: points\.map\(\(p\) => \(\{ time: p\.time, price: Number\(p\.price\) \}\)\)/.test(model));
  ok('the horizontal tool still declares its price label and time lock',
    /priceLabel: \(p\) => p\[0\]\.price/.test(model) && /lockTime: true/.test(model));
  ok('line widths and dashes are unchanged',
    /export const LINE_WIDTHS = \[1, 2, 3, 4\]/.test(model)
    && /export const LINE_DASHES = \['solid', 'dashed', 'dotted'\]/.test(model));
  const layer = code(read('src/components/chart/DrawingLayer.jsx'));
  ok('the drawing layer still resolves a colour through the theme',
    /indicatorColor\(stateRef\.current\.theme, d\.style\.color\)/.test(layer));
  ok('the price-axis chips are untouched', /reconcileAxisLabels/.test(layer));
  ok('the coordinate conversion is untouched', /coordinateToPrice\(y\)/.test(layer));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
