// INDICATOR COLOURS: THE PALETTE, THE PER-SERIES CONTROLS, AND WHAT PERSISTS.
//
//   node scripts/verify-indicator-colors.mjs
//
// ⚠️ TWO DEFECTS THIS COVERS. The whole product offered six colours, from a swatch row duplicated in
// four places. And for the indicators that draw more than one line the control did nothing at all: the
// chart applied an instance colour only when `plots.length === 1`, so Bollinger Bands and MACD could
// not be recoloured while the panel showed a picker that appeared to work.
//
// The interesting assertions are about ISOLATION — between two instances of the same indicator, between
// the series of one indicator, and between accounts — because those are the properties a colour feature
// breaks quietly. A shared-object bug makes EMA 8 and EMA 13 the same colour and nothing errors.

import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PALETTE, PALETTE_GRID, PALETTE_COLUMNS, PALETTE_ROWS, GRAYS, FAMILIES, COMMON_COLORS,
  normalizeHex, isValidHex, coerceColorValue, isExplicitColor,
} from '../src/lib/chart/color-palette.mjs';
import { indicatorColor, indicatorColors } from '../src/lib/chart/chart-theme.mjs';
import {
  INDICATORS, seriesKeys, isMultiSeries, seriesColorValue, primaryColorValue, defaultParams,
} from '../src/lib/chart/chart-indicators.mjs';
import { setChartScope, __resetChartScope } from '../src/lib/chart/chart-scope.mjs';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ── 1. the palette is substantially larger than six ────────────────────────────────────────────
console.log('\n1. the palette is substantially larger than six');

ok('the palette carries 60-100 swatches', PALETTE.length >= 60 && PALETTE.length <= 120, `${PALETTE.length}`);
ok('...which is far more than the six it replaces', PALETTE.length > 6 * 8);
ok('there is a grayscale ramp', GRAYS.length >= 8 && GRAYS.includes('#FFFFFF') && GRAYS.includes('#000000'));
// The families the brief asked for, by hue rather than by name alone.
// ⚠️ THE NINE COLUMNS ARE GRAYSCALE PLUS THESE EIGHT. cyan, amber and indigo were folded away when the
// grid went to nine columns of ten shades: ten families of eight could not be nine columns, and a hue with
// ten levels is more useful than three near-neighbours with eight. yellow replaced amber by name.
for (const key of ['red', 'pink', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple']) {
  ok(`the ${key} family exists`, FAMILIES.some((f) => f.key === key));
}
ok('eight families plus grayscale make the nine columns', FAMILIES.length === 8 && PALETTE_COLUMNS === 9);
ok('every family has multiple shades', FAMILIES.every((f) => f.shades.length >= 6));
ok('every swatch is a canonical hex', PALETTE.every((c) => normalizeHex(c) === c));
// ⚠️ NO DUPLICATES. A repeated swatch makes "which one is selected" ambiguous in the grid.
ok('no swatch appears twice', new Set(PALETTE).size === PALETTE.length,
  `${PALETTE.length - new Set(PALETTE).size} duplicates`);
// ⚠️ THE GRID IS TRANSPOSED NOW. It used to be one row per family — eleven rows, tall and narrow, tall
// enough that the popover needed a scrollbar. Families are COLUMNS, so the grid is 9 x 10 and the whole
// palette is visible at once. PALETTE_GRID is the render order; PALETTE_ROWS is now its row COUNT.
ok('the grid covers the whole palette, with nothing left out or repeated',
  PALETTE_GRID.flat().length === PALETTE.length
  && new Set(PALETTE_GRID.flat()).size === PALETTE.length);
// ⚠️ NINE COLUMNS BY TEN ROWS NOW, which is what fits nine families at a tap-sized swatch on a 390px
// phone. A column is one hue through ten brightness levels; a row is the same level across every hue.
ok('...laid out as nine columns by ten rows',
  PALETTE_COLUMNS === 9 && PALETTE_ROWS === 10 && PALETTE_GRID.every((r) => r.length === 9));
ok('...grayscale is the first column, not a row of its own',
  PALETTE_GRID.every((r, i) => r[0] === GRAYS[i]));
ok('...and every family has ten levels, so a row means the same thing across the palette',
  GRAYS.length === 10 && FAMILIES.every((f) => f.shades.length === 10));
ok('the collapsed row offers one shade per family', COMMON_COLORS.length === FAMILIES.length);
ok('...and each is drawn from the middle of its ramp, so it reads on both canvases',
  COMMON_COLORS.every((c, i) => FAMILIES[i].shades.includes(c)));
ok('...specifically the mid level of a ten-step ramp', COMMON_COLORS.every((c, i) => c === FAMILIES[i].shades[5]));

// ── 2. hex handling ───────────────────────────────────────────────────────────────────────────
console.log('\n2. hex handling');

ok('a full hex is accepted', normalizeHex('#4a80f0') === '#4A80F0');
ok('a hex without the hash is accepted', normalizeHex('4a80f0') === '#4A80F0');
ok('a short hex expands', normalizeHex('#abc') === '#AABBCC');
ok('surrounding space is ignored', normalizeHex('  #4A80F0 ') === '#4A80F0');
// ⚠️ CANONICALISED, so the same colour cannot be stored three ways and then fail its own selected test.
ok('⚠️ case and length variants canonicalise to one value',
  new Set(['#4a80f0', '#4A80F0', '4A80F0'].map(normalizeHex)).size === 1);
for (const bad of ['', '#12', '#1234', 'blue', '#GGGGGG', null, undefined, 42, {}]) {
  ok(`${JSON.stringify(bad)} is rejected`, normalizeHex(bad) === null);
}
ok('isValidHex agrees with normalizeHex',
  ['#abc', '#4A80F0', 'abc123'].every(isValidHex) && !['#12', 'nope', ''].some(isValidHex));

// coerceColorValue keeps both storable shapes and rejects everything else.
ok('an index stays a number', coerceColorValue(3) === 3);
ok('a numeric string becomes a number', coerceColorValue('3') === 3);
ok('a hex becomes canonical hex', coerceColorValue('#4a80f0') === '#4A80F0');
ok('null stays null', coerceColorValue(null) === null && coerceColorValue('') === null);
ok('rubbish becomes null rather than a colour', coerceColorValue('not-a-color') === null);
ok('a negative index is clamped, not stored', coerceColorValue(-4) === 0);
ok('isExplicitColor distinguishes the two shapes',
  isExplicitColor('#4A80F0') && !isExplicitColor(2) && !isExplicitColor(null));

// ── 3. both shapes render, and a legacy index still follows the theme ──────────────────────────
console.log('\n3. both shapes render, and a legacy index still follows the theme');

ok('an explicit hex renders verbatim in both themes',
  indicatorColor('light', '#FF7F76') === '#FF7F76' && indicatorColor('dark', '#FF7F76') === '#FF7F76');
// ⚠️ THE MIGRATION PROPERTY. Every setting saved before the palette existed is an index, and must keep
// swapping between the two ramps rather than freezing on one.
ok('⚠️ a legacy index still resolves through the theme',
  indicatorColor('light', 0) !== indicatorColor('dark', 0)
  && indicatorColor('light', 0) === indicatorColors('light')[0]
  && indicatorColor('dark', 0) === indicatorColors('dark')[0]);
ok('an out-of-range index wraps rather than returning undefined',
  typeof indicatorColor('light', 99) === 'string' && indicatorColor('light', 99).startsWith('#'));
ok('a corrupt value falls back to a real colour, never to undefined',
  indicatorColor('light', 'garbage') === indicatorColors('light')[0]
  && indicatorColor('light', null) === indicatorColors('light')[0]);

// ── 4. per-series resolution ───────────────────────────────────────────────────────────────────
console.log('\n4. per-series resolution');

ok('Bollinger declares three series', seriesKeys('bollinger').join(',') === 'upper,basis,lower');
ok('MACD declares three series', seriesKeys('macd').join(',') === 'macd,signal,hist');
ok('single-series indicators declare one',
  ['sma', 'ema', 'rsi', 'atr', 'vwap'].every((id) => seriesKeys(id).length === 1));
ok('isMultiSeries agrees', isMultiSeries('bollinger') && isMultiSeries('macd') && !isMultiSeries('sma'));

{
  // The registry's own colours, with nothing chosen.
  const bare = { id: 'bollinger', key: 'b-1' };
  ok('with nothing chosen, each series takes the registry colour',
    seriesColorValue('bollinger', bare, 'upper') === INDICATORS.bollinger.colors.upper
    && seriesColorValue('bollinger', bare, 'basis') === INDICATORS.bollinger.colors.basis);

  // ⚠️ AN INSTANCE-WIDE COLOUR MUST NOT FLATTEN A MULTI-SERIES INDICATOR. Letting entry.color win for
  // all three would turn Bollinger into three identical lines, which is worse than ignoring it.
  const flat = { id: 'bollinger', key: 'b-1', color: '#FF0000' };
  ok('⚠️ an instance-wide colour does not flatten Bollinger to one hue',
    seriesColorValue('bollinger', flat, 'upper') !== '#FF0000'
    && seriesColorValue('bollinger', flat, 'basis') !== '#FF0000');
  ok('...but it DOES apply to a single-series indicator',
    seriesColorValue('sma', { id: 'sma', color: '#FF0000' }, 'sma') === '#FF0000');

  // Per-series wins, and only for the series named.
  const perSeries = { id: 'bollinger', key: 'b-1', colors: { upper: '#2A9E5B' } };
  ok('a per-series colour wins for that series',
    seriesColorValue('bollinger', perSeries, 'upper') === '#2A9E5B');
  ok('...and leaves the others on the registry\'s',
    seriesColorValue('bollinger', perSeries, 'basis') === INDICATORS.bollinger.colors.basis
    && seriesColorValue('bollinger', perSeries, 'lower') === INDICATORS.bollinger.colors.lower);
  // Precedence: per-series beats instance-wide even on a single-series indicator.
  ok('per-series beats instance-wide',
    seriesColorValue('sma', { id: 'sma', color: '#FF0000', colors: { sma: '#00FF00' } }, 'sma') === '#00FF00');
  // An unknown plot key falls back rather than returning undefined.
  ok('an unknown series key falls back to a real value',
    seriesColorValue('bollinger', bare, 'nope') !== undefined);
  ok('primaryColorValue is the first declared series',
    primaryColorValue('bollinger', perSeries) === '#2A9E5B');
}

// ── 5. two instances of the same indicator are independent ─────────────────────────────────────
console.log('\n5. two instances of the same indicator are independent');

{
  // The owner's exact case.
  const ema8 = { id: 'ema', key: 'ema-1', params: { length: 8 }, color: '#F2B824' };    // gold
  const ema13 = { id: 'ema', key: 'ema-2', params: { length: 13 }, color: '#4A80F0' };  // blue
  const sma200 = { id: 'sma', key: 'sma-1', params: { length: 200 }, color: '#F5872E' }; // orange
  ok('EMA 8 is gold', seriesColorValue('ema', ema8, 'ema') === '#F2B824');
  ok('EMA 13 is blue', seriesColorValue('ema', ema13, 'ema') === '#4A80F0');
  ok('SMA 200 is orange', seriesColorValue('sma', sma200, 'sma') === '#F5872E');
  ok('⚠️ the three remain three independent colours',
    new Set([seriesColorValue('ema', ema8, 'ema'), seriesColorValue('ema', ema13, 'ema'),
      seriesColorValue('sma', sma200, 'sma')]).size === 3);

  // ⚠️ AND THE RESOLVER READS ONLY THE INSTANCE IT IS GIVEN. A shared-object bug is the quiet way two
  // EMAs become one colour, so changing one object must not be visible through the other.
  ema8.color = '#DC3226';
  ok('⚠️ recolouring EMA 8 does not change EMA 13',
    seriesColorValue('ema', ema13, 'ema') === '#4A80F0');
  ok('...and the per-series maps are not shared either', (() => {
    const a = { id: 'bollinger', key: 'b-1', colors: { upper: '#2A9E5B' } };
    const b = { id: 'bollinger', key: 'b-2', colors: { upper: '#4A80F0' } };
    return seriesColorValue('bollinger', a, 'upper') === '#2A9E5B'
      && seriesColorValue('bollinger', b, 'upper') === '#4A80F0';
  })());
}

// ── 6. persistence, per account ────────────────────────────────────────────────────────────────
console.log('\n6. persistence, per account');

{
  // A DOM with localStorage, so the real store runs.
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://catalystpit.test/' });
  for (const k of ['window', 'document', 'localStorage']) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); }
  }
  const settings = await import(`${pathToFileURL(path.join(ROOT, 'src/lib/chart/chart-settings.mjs')).href}?t=${Date.now()}`);
  const { loadIndicators, saveIndicators } = settings;

  __resetChartScope();
  setChartScope('user_alice', { resolved: true });

  const mine = [
    { key: 'ema-1', id: 'ema', params: { length: 8 }, color: '#F2B824', visible: true },
    { key: 'ema-2', id: 'ema', params: { length: 13 }, color: '#4A80F0', visible: true },
    { key: 'b-1', id: 'bollinger', params: defaultParams('bollinger'),
      colors: { upper: '#2A9E5B', lower: '#DC3226' }, visible: true },
  ];
  saveIndicators(mine);
  const back = loadIndicators();

  ok('every instance round-trips', back.length === 3, `${back.length}`);
  // ⚠️ THE BUG THIS CATCHES. coerceInstance forced the colour through Number(), and Number('#4A80F0')
  // is NaN — so every hex became null and the series reverted on the next load.
  ok('⚠️ a hex colour survives a reload', back.find((e) => e.key === 'ema-1').color === '#F2B824');
  ok('...for each instance independently',
    back.find((e) => e.key === 'ema-2').color === '#4A80F0');
  ok('⚠️ per-series colours survive a reload', (() => {
    const b = back.find((e) => e.key === 'b-1');
    return b.colors?.upper === '#2A9E5B' && b.colors?.lower === '#DC3226';
  })(), JSON.stringify(back.find((e) => e.key === 'b-1')?.colors));
  ok('...and a series that was never set is absent rather than null',
    back.find((e) => e.key === 'b-1').colors.basis === undefined);
  ok('params are unaffected',
    back.find((e) => e.key === 'ema-1').params.length === 8
    && back.find((e) => e.key === 'ema-2').params.length === 13);
  // A legacy index payload still loads.
  saveIndicators([{ key: 'sma-1', id: 'sma', params: { length: 50 }, color: 2, visible: true }]);
  ok('a legacy index colour still round-trips', loadIndicators()[0].color === 2);
  // Junk is dropped rather than stored as a colour.
  saveIndicators([{ key: 'sma-1', id: 'sma', params: { length: 50 }, color: 'chartreuse', visible: true }]);
  ok('an unparseable colour becomes null, not a broken series', loadIndicators()[0].color === null);
  // An unknown per-series key cannot be smuggled in.
  saveIndicators([{ key: 'b-2', id: 'bollinger', params: defaultParams('bollinger'),
    colors: { upper: '#2A9E5B', nonsense: '#000000' }, visible: true }]);
  ok('an unknown series key is dropped from the stored colours', (() => {
    const c = loadIndicators()[0].colors;
    return c.upper === '#2A9E5B' && c.nonsense === undefined;
  })());

  // ⚠️ ACCOUNT ISOLATION, WHICH THIS FEATURE MUST NOT REOPEN.
  saveIndicators(mine);
  setChartScope('user_bob', { resolved: true });
  const bobs = loadIndicators();
  ok('⚠️ a second account does not see the first account\'s colours',
    !bobs.some((e) => e.color === '#F2B824' || e.colors?.upper === '#2A9E5B'),
    JSON.stringify(bobs));
  saveIndicators([{ key: 'rsi-1', id: 'rsi', params: defaultParams('rsi'), color: '#8C48B4', visible: true }]);
  setChartScope('user_alice', { resolved: true });
  const aliceAgain = loadIndicators();
  ok('⚠️ ...and the first account\'s colours are intact after the second saved',
    aliceAgain.find((e) => e.key === 'ema-1')?.color === '#F2B824');
  ok('...and Bob\'s choice did not leak in', !aliceAgain.some((e) => e.color === '#8C48B4'));
  // An unresolved identity writes nowhere, exactly as before this change.
  __resetChartScope();
  const before = dom.window.localStorage.length;
  saveIndicators([{ key: 'sma-9', id: 'sma', params: {}, color: '#000000', visible: true }]);
  ok('⚠️ an unresolved account still writes nothing', dom.window.localStorage.length === before);

  __resetChartScope();
  setChartScope('user_alice', { resolved: true });
}

// ── 7. the control itself, mounted ─────────────────────────────────────────────────────────────
console.log('\n7. the control itself, mounted');

{
  const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-colors');
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

  for (const theme of ['light', 'dark']) {
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const picked = [];
    let mountError = null;
    const root = ReactDOMClient.createRoot(container, { onUncaughtError: (e) => { mountError = mountError || e; } });
    await act(async () => {
      root.render(React.createElement(ColorPicker, {
        theme, value: 2, label: 'EMA color', onChange: (v) => picked.push(v),
      }));
    });
    ok(`the control mounts in ${theme} mode`, !mountError,
      mountError ? `${mountError.name}: ${mountError.message}` : '');

    const buttons = () => [...container.querySelectorAll('button')];
    const dialog = () => container.querySelector('[role="dialog"]');
    ok(`${theme}: the palette is closed to begin with`, dialog() === null);
    // The collapsed row offers the common colours without opening anything.
    ok(`${theme}: the collapsed row shows the common colours`,
      buttons().filter((b) => /^Color #/.test(b.getAttribute('aria-label') || '')).length === COMMON_COLORS.length);

    const trigger = buttons().find((b) => /more colors/.test(b.getAttribute('aria-label') || ''));
    ok(`${theme}: there is a trigger for the full palette`, !!trigger);
    await act(async () => { trigger.click(); });
    ok(`⚠️ ${theme}: clicking the swatch opens the palette`, dialog() !== null);

    // Every swatch in the palette is reachable.
    const swatches = [...dialog().querySelectorAll('button')]
      .map((b) => b.getAttribute('aria-label')).filter(Boolean);
    ok(`${theme}: the whole palette is rendered`,
      PALETTE.every((c) => swatches.includes(c)), `${swatches.length} buttons`);
    ok(`${theme}: the theme-aware six are still offered`,
      swatches.filter((l) => /^Theme color/.test(l)).length === indicatorColors(theme).length);

    // Picking a preset reports a canonical hex.
    const target = FAMILIES[6].shades[4];   // a blue
    const swatch = [...dialog().querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === target);
    await act(async () => { swatch.click(); });
    ok(`⚠️ ${theme}: picking a preset reports that colour`, picked.at(-1) === normalizeHex(target),
      `${picked.at(-1)}`);
    ok(`${theme}: ...and the palette closes`, dialog() === null);

    // ⚠️ REACT IGNORES A PLAIN `el.value = x`. It tracks the last value it rendered on the node, so a
    // direct assignment followed by an 'input' event looks like no change at all and onChange never
    // runs — my first version of this typed a hex, saw the previous PRESET still reported, and read as
    // "the hex field does not work" when the field was fine and the test was not. Going through the
    // prototype's setter is what a real keystroke does.
    const type = async (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      await act(async () => {
        setter.call(el, value);
        el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    };

    // ⚠️ focusout, NOT blur. React binds onBlur to the FOCUSOUT event because blur does not bubble, so
    // a dispatched 'blur' reached nothing: the commit never ran, the popover therefore never closed, and
    // the next 'reopen' click closed it instead — which showed up as a missing hex field two assertions
    // later. One wrong event name, two misleading failures.
    // A custom hex, typed.
    await act(async () => { buttons().find((b) => /more colors/.test(b.getAttribute('aria-label') || '')).click(); });
    const hexField = dialog().querySelector('input[aria-label="Hex color"]');
    ok(`${theme}: there is a hex field`, !!hexField);
    // ⚠️ CHECKED WHILE THE POPOVER IS OPEN. The native input lives inside it, so looking after a pick
    // closed the popover found nothing and reported a missing control that was there all along.
    ok(`${theme}: a native colour input is offered alongside it`,
      !!dialog().querySelector('input[type="color"]'));
    await type(hexField, '#1a2b3c');
    await act(async () => { hexField.dispatchEvent(new dom.window.Event('focusout', { bubbles: true })); });
    ok(`⚠️ ${theme}: a typed hex is accepted and canonicalised`, picked.at(-1) === '#1A2B3C',
      `${picked.at(-1)}`);

    // An invalid hex must not become a colour.
    //
    // ⚠️ COMMITTING A HEX LEAVES THE POPOVER OPEN, and that is deliberate: picking a swatch is a
    // decision, typing a hex is often an adjustment you want to see before moving on. My first version
    // clicked the trigger again regardless, which CLOSED the open popover and then reported a missing
    // hex field. Reopen only when it is actually shut.
    const n = picked.length;
    if (!dialog()) {
      await act(async () => { buttons().find((b) => /more colors/.test(b.getAttribute('aria-label') || ''))?.click(); });
    }
    ok(`${theme}: committing a hex leaves the palette open for further adjustment`, !!dialog());
    const field2 = dialog()?.querySelector('input[aria-label="Hex color"]');
    ok(`${theme}: the hex field is still there after reopening`, !!field2);
    if (field2) {
      await type(field2, '#12');
      await act(async () => { field2.dispatchEvent(new dom.window.Event('focusout', { bubbles: true })); });
      ok(`⚠️ ${theme}: a half-typed hex is not stored`, picked.length === n, `${picked.at(-1)}`);
      // ...and the field reverts to the real colour rather than keeping the invalid text.
      ok(`${theme}: ...and the field reverts to the current colour`, field2.value !== '#12', field2.value);
    }
    await act(async () => { root.unmount(); });
  }
}

// ── 8. the panel wires one control per series, and reset clears colours ────────────────────────
console.log('\n8. the panel wires one control per series, and reset clears colours');

{
  const browser = stripComments(read('src/components/chart/IndicatorBrowser.jsx'));
  ok('the panel renders the shared control', /<ColorPicker/.test(browser));
  // ⚠️ ONE COMPONENT. A second inline swatch grid is how the six-colour row came to exist in four files.
  ok('⚠️ the panel has no swatch grid of its own',
    !/indicatorColors\(theme\)\.map/.test(browser) && !/swatches\.map/.test(browser));
  ok('a multi-series indicator gets one control per series',
    /seriesKeys\(inst\.id\)\.length > 1/.test(browser) && /seriesKeys\(inst\.id\)\.map/.test(browser));
  ok('...writing to that series only',
    /colors: \{ \.\.\.\(inst\.colors \|\| \{\}\), \[plotKey\]: v \}/.test(browser));
  ok('a single-series indicator writes the instance colour',
    /onChange=\{\(v\) => patch\(inst\.key, \{ color: v \}\)\}/.test(browser));
  // ⚠️ RESET MEANS RESET. It restored the periods and left a recoloured line recoloured.
  ok('⚠️ reset restores the periods AND both colour fields',
    /patch\(inst\.key, \{ params: defaultParams\(inst\.id\), color: null, colors: \{\} \}\)/.test(browser));
  ok('...through patch, so it touches only this instance', /const patch = \(key, next\) => onChange\(active\.map/.test(browser));

  const cp = stripComments(read('src/components/chart/CPChart.jsx'));
  ok('the chart resolves every plot through the shared resolver',
    /seriesColorValue\(entry\.id, entry, plot\.key\)/.test(cp));
  // ⚠️ THE ONE-PLOT CONDITION IS GONE. That expression is why Bollinger and MACD ignored the setting.
  ok('⚠️ the plots.length === 1 condition is gone',
    !/plots\.length === 1 && entry\.color/.test(cp));
  ok('the legend shows the instance\'s own primary colour', /primaryColorValue\(entry\.id, entry\)/.test(cp));
}

// ── 9. user-facing copy is U.S. English ────────────────────────────────────────────────────────
console.log('\n9. user-facing copy is U.S. English');

{
  // ⚠️ COPY, NOT IDENTIFIERS. A `segColours` local reaches no reader; a title attribute does.
  const FILES = ['src/components/chart/IndicatorBrowser.jsx', 'src/components/chart/ColorPicker.jsx',
    'src/components/chart/DrawingRail.jsx', 'src/components/chart/DrawingSettings.jsx',
    'src/components/chart/DrawingToolbar.jsx', 'src/app/heatmap/MarketHeatmapClient.jsx',
    'src/app/insiders/InsidersClient.jsx'];
  const COPY_ATTR = /(?:title|aria-label|placeholder)=\{?["'`]([^"'`]*)["'`]/g;
  for (const f of FILES) {
    const src = read(f);
    const attrs = [...src.matchAll(COPY_ATTR)].map((m) => m[1]);
    ok(`${path.basename(f)} has no "Colour" in a title or label`,
      !attrs.some((a) => /colour/i.test(a)), attrs.filter((a) => /colour/i.test(a)).join(' | '));
    // Body text in JSX, between tags.
    const text = [...src.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map((m) => m[1]);
    ok(`${path.basename(f)} has no "Colour" in visible text`,
      !text.some((t) => /\bcolour/i.test(t)), text.filter((t) => /\bcolour/i.test(t)).join(' | '));
  }
  ok('the indicator panel says "Color"', /Color</.test(read('src/components/chart/IndicatorBrowser.jsx')));
  ok('and "Favorites", not "Favourites"',
    /label: 'Favorites'/.test(read('src/components/chart/IndicatorBrowser.jsx')));
}

// ── 10. nothing else moved ─────────────────────────────────────────────────────────────────────
console.log('\n10. nothing else moved');

{
  const ind = read('src/lib/chart/chart-indicators.mjs');
  // Calculations untouched: the maths functions take bars and params, never a colour.
  ok('no indicator calculation reads a colour',
    !/function (sma|ema|rsi|macd|atr|bollinger|vwap|volume)\([^)]*colou?r/i.test(ind));
  ok('the registry still declares its default colours',
    /colors: \{ upper: 3, basis: 0, lower: 3 \}/.test(ind) && /colors: \{ macd: 1, signal: 3, hist: 0 \}/.test(ind));
  // The historical-depth work is untouched.
  const src = read('src/lib/chart/chart-source.mjs');
  ok('the intraday depth formula is untouched',
    /export function intradayHistory/.test(src) && /export const TARGET_BARS = 1000;/.test(src));
  // Account scoping is untouched.
  const settings = read('src/lib/chart/chart-settings.mjs');
  ok('every stored key still goes through the account scope', /chartScopeKey/.test(settings));
  ok('the indicator key is not read unscoped', !/localStorage\.getItem\('cp_chart_indicators'/.test(settings));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
