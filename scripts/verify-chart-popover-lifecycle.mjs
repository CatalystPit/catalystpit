// CHART-OWNED FLOATING CONTROLS BELONG TO THE CHART.
//
//   node scripts/verify-chart-popover-lifecycle.mjs
//
// ⚠️ THE BUG. The drawing toolbar is absolutely positioned inside the chart's box, so page-scrolling the
// ticker page carried it up the screen while the chart slid away — it ended up floating over Key
// Statistics and Pit Consensus, describing a drawing nobody could see. Its colour popover went with it,
// and the popover made it worse by RE-MEASURING on scroll: it actively followed the reader.
//
// ⚠️ AND IT IS AN OWNERSHIP PROBLEM. position:fixed, sticky, a bigger z-index or an overflow clip each
// move the symptom somewhere else — the control would still be open, still orphaned. So the rule is that
// these close when the chart stops being the context, and the thing this suite defends is the DISTINCTION
// that makes that rule usable: a page scroll closes them, an internal pan or zoom does not.

import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PALETTE } from '../src/lib/chart/color-palette.mjs';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ── 1. the picker closes on a page scroll instead of following it ──────────────────────────────
console.log('\n1. the picker closes on a page scroll instead of following it');

{
  const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-lifecycle');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, 'ColorPicker.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/components/chart/ColorPicker.jsx')],
    bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    logLevel: 'silent', absWorkingDir: ROOT,
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="page"></div></body></html>',
    { url: 'https://catalystpit.test/ticker/NVDA', pretendToBeVisual: true });
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'Event']) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { act } = await import('react');
  const ReactDOMClient = await import('react-dom/client');
  const ColorPicker = (await import(pathToFileURL(out).href)).default;

  dom.window.Element.prototype.getBoundingClientRect = () => ({
    top: 300, bottom: 322, left: 500, right: 590, width: 90, height: 22, x: 500, y: 300,
    toJSON() { return this; },
  });

  const host = dom.window.document.getElementById('page');
  const root = ReactDOMClient.createRoot(host);
  const openIt = async () => {
    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((b) => /more colors/.test(b.getAttribute('aria-label') || '')).click();
    });
  };
  const panel = () => host.querySelector('[data-cp-color-panel]');

  await act(async () => {
    root.render(React.createElement(ColorPicker, { theme: 'light', value: 2, compact: true, onChange: () => {} }));
  });
  await openIt();
  ok('the palette opens', !!panel());
  ok('...with all 90 swatches, unchanged by any of this',
    [...panel().querySelectorAll('button')].filter((b) => PALETTE.includes(b.getAttribute('aria-label'))).length === 90);

  // ⚠️ THE PAGE SCROLLS. Not the chart — the document.
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event('scroll')); });
  ok('⚠️ a page scroll closes the palette', panel() === null);

  // It reopens correctly afterwards, which is the other half of "closed, not broken".
  await openIt();
  ok('⚠️ ...and it reopens correctly after the scroll', !!panel());
  ok('...still with the full palette',
    [...panel().querySelectorAll('button')].filter((b) => PALETTE.includes(b.getAttribute('aria-label'))).length === 90);

  // A scroll in an ANCESTOR counts too — the chart lives inside scrollable page containers.
  await act(async () => {
    host.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }));
  });
  ok('⚠️ a scroll in an ancestor container also closes it', panel() === null);

  // A RESIZE must reposition rather than close: the chart has not gone anywhere.
  await openIt();
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event('resize')); });
  ok('a window resize repositions rather than closing', !!panel());
  await act(async () => { root.unmount(); });
}

// ── 2. the picker no longer chases the viewport ────────────────────────────────────────────────
console.log('\n2. the picker no longer chases the viewport');

{
  const src = code(read('src/components/chart/ColorPicker.jsx'));
  // ⚠️ THE OLD BEHAVIOUR, NAMED. `scroll` used to re-run the measurement, which is what glued the panel
  // to the reader while the chart left.
  ok('⚠️ scroll closes the panel', /addEventListener\('scroll', onScroll, true\)/.test(src));
  ok('⚠️ ...and does not re-measure it', !/addEventListener\('scroll', measure/.test(src));
  ok('the handler really closes rather than repositioning', /const onScroll = \(\) => setOpen\(false\)/.test(src));
  ok('resize still re-measures', /addEventListener\('resize', measure\)/.test(src));
  ok('both listeners are removed on close', /removeEventListener\('scroll', onScroll, true\)/.test(src)
    && /removeEventListener\('resize', measure\)/.test(src));
  // ⚠️ AND IT IS NOT "FIXED" INTO PLACE, which is the fix that hides the problem instead of solving it.
  ok('⚠️ the panel is not position:fixed or sticky',
    !/position:\s*'fixed'/.test(src) && !/position:\s*'sticky'/.test(src));
  ok('...and is still absolutely positioned inside its own box', /position:\s*'absolute'/.test(src));
}

// ── 3. the chart closes its floating controls when it stops being the context ───────────────────
console.log('\n3. the chart closes its floating controls when it stops being the context');

{
  const cp = code(read('src/components/chart/CPChart.jsx'));
  ok('a page scroll closes the floating controls',
    /window\.addEventListener\('scroll', onPageScroll/.test(cp));
  ok('...by clearing the selection box and the selection',
    /const closeFloating = \(\) => \{ setSelBox\(null\); setSelectedIds\(\[\]\); \};/.test(cp));
  // ⚠️ THE CHART LEAVING THE VIEWPORT BY ANY ROUTE, not only a scroll: a resize, a dock, a drawer.
  ok('⚠️ the chart leaving the viewport also closes them',
    /new IntersectionObserver/.test(cp) && /if \(!e\.isIntersecting\) closeFloating\(\)/.test(cp));
  ok('...watching the chart host itself', /io\.observe\(host\)/.test(cp));
  ok('...and the observer is disconnected on teardown', /io\?\.disconnect\(\)/.test(cp));
  ok('the scroll listener is removed on teardown',
    /removeEventListener\('scroll', onPageScroll\)/.test(cp));

  // ⚠️ AN INTERNAL PAN OR ZOOM MUST NOT COUNT. Those are pointer gestures on a canvas and fire no window
  // scroll — so what this asserts is that nothing wired the chart's OWN range events to the close path,
  // which is the mistake that would make the toolbar unusable while panning.
  ok('⚠️ a chart range change is not treated as a page scroll',
    !/subscribeVisibleLogicalRangeChange\([^)]*closeFloating/.test(cp)
    && !/closeFloating[\s\S]{0,60}subscribeVisibleLogicalRangeChange/.test(cp));
  ok('...and the crosshair is not either', !/subscribeCrosshairMove\([^)]*closeFloating/.test(cp));

  // Symbol and timeframe changes take them too.
  ok('a symbol or timeframe change closes the floating controls',
    /useEffect\(\(\) => \{ setSelBox\(null\); \}, \[sym, tf\]\)/.test(cp));

  // The lifecycle that already existed must still hold: deselect and delete close the toolbar, because
  // the toolbar only renders while something is selected.
  ok('the toolbar renders only while a drawing is selected',
    /selBox && selectedIds\.length > 0 &&/.test(cp));
  ok('deleting clears the selection, so the toolbar goes with it',
    /updateDrawings\(\(ds\) => ds\.filter\(\(d\) => !ids\.has\(d\.id\)\)\);\s*\n\s*setSelectedIds\(\[\]\);/.test(cp));
  ok('clearing all drawings clears the selection too',
    /updateDrawings\(\[\]\);\s*\n\s*setSelectedIds\(\[\]\);/.test(cp));

  // ⚠️ NOT SOLVED BY POSITIONING TRICKS.
  ok('⚠️ the toolbar is not pinned to the viewport',
    !/position:\s*'fixed'/.test(code(read('src/components/chart/DrawingToolbar.jsx'))));
}

// ── 4. nothing about colour behaviour moved ────────────────────────────────────────────────────
console.log('\n4. nothing about colour behaviour moved');

{
  const picker = code(read('src/components/chart/ColorPicker.jsx'));
  ok('the 90-swatch grid is intact', /PALETTE_GRID\.map/.test(picker));
  ok('the hex field is intact', /aria-label="Hex color"/.test(picker));
  ok('the native picker is intact', /type="color"/.test(picker));
  ok('no scroll container came back', !/overflowY|maxHeight/.test(picker));
  ok('the edge flipping is intact',
    /place\.vertical === 'above'/.test(picker) && /place\.horizontal === 'left'/.test(picker));
  for (const f of ['DrawingRail', 'DrawingToolbar', 'DrawingSettings', 'IndicatorBrowser']) {
    ok(`${f} still uses the shared picker`, /<ColorPicker/.test(code(read(`src/components/chart/${f}.jsx`))));
  }
  const model = read('src/lib/chart/chart-drawings.mjs');
  ok('drawing colour persistence is intact', /coerceColorValue\(raw\?\.color\)/.test(model));
  const settings = read('src/lib/chart/chart-settings.mjs');
  ok('indicator colour persistence is intact', /coerceColorValue\(raw\?\.color\)/.test(settings));
  ok('account scoping is intact', /chartScopeKey/.test(settings));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
