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
import { PALETTE, PALETTE_GRID, PALETTE_COLUMNS, PALETTE_ROWS, COMMON_COLORS, normalizeHex } from '../src/lib/chart/color-palette.mjs';
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

for (const f of SURFACES) {
  const src = read(f);
  ok(`${path.basename(f)} imports the shared control`, /import ColorPicker from '\.\/ColorPicker'/.test(src));
  ok(`${path.basename(f)} renders it`, /<ColorPicker/.test(code(src)));
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
  ok('the palette is ten columns by nine rows', PALETTE_COLUMNS === 10 && PALETTE_ROWS === 9);
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
  ok('...arranged in nine rows of ten',
    [...panel.children].some((el) => el.children.length >= 9)
    || [...panel.querySelectorAll('div')].filter((d) => d.children.length === 10).length === 9,
    `${[...panel.querySelectorAll('div')].filter((d) => d.children.length === 10).length} rows of ten`);

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
  const w = /width:\s*(\d+)px/.exec(styleOf(panel));
  ok('⚠️ the popover is compact, 220-260px wide', w && Number(w[1]) >= 220 && Number(w[1]) <= 260,
    w ? `${w[1]}px` : styleOf(panel).slice(0, 90));

  // The custom controls stay, below the grid.
  ok('the hex field is still offered', !!panel.querySelector('input[aria-label="Hex color"]'));
  ok('the native picker is still offered', !!panel.querySelector('input[type="color"]'));
  ok('...and both sit BELOW the preset grid',
    styleOf(panel).includes('column')
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
