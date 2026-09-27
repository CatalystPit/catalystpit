// CHART POPOVERS ON A PHONE — 390px wide, real scroll paths.
//
//   node scripts/verify-chart-popover-mobile.mjs
//
// ⚠️ WHY THE DESKTOP FIX DID NOT REACH MOBILE. Two reasons, both about which event actually fires:
//
//   1. `scroll` DOES NOT BUBBLE. A listener on window WITHOUT capture only hears the document itself
//      scrolling — any scrollable ancestor between the chart and the document is silent.
//   2. iOS reports page panning through `visualViewport`, not always through window scroll. A phone could
//      scroll the chart clean off the screen without the handler firing once.
//
// And the popovers themselves had NO scroll lifecycle at all: ChartUI's Popover is a position:fixed
// portal in document.body that closed only on `mousedown` and Escape. A touch scroll fires neither, so on
// a phone nothing dismissed them — which is the bug as reported.
//
// Proportional on purpose: this covers the mobile event paths and the chart-gesture distinction, and
// nothing else.

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

const MOBILE = { width: 390, height: 844 };   // iPhone 14/15 logical viewport

/** A phone-sized DOM with a visualViewport, which jsdom does not provide. */
function mobileDom(html = '<!doctype html><html><body><div id="page"></div></body></html>') {
  const dom = new JSDOM(html, { url: 'https://catalystpit.test/ticker/NVDA', pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: MOBILE.width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: MOBILE.height, configurable: true });
  // A minimal visualViewport with a real event target, so the mobile path can actually be exercised.
  const vvTarget = new window.EventTarget();
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      width: MOBILE.width, height: MOBILE.height, offsetTop: 0, offsetLeft: 0, scale: 1,
      addEventListener: vvTarget.addEventListener.bind(vvTarget),
      removeEventListener: vvTarget.removeEventListener.bind(vvTarget),
      dispatchEvent: vvTarget.dispatchEvent.bind(vvTarget),
    },
  });
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver',
    'Event', 'EventTarget']) {
    try { globalThis[k] = window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-mobile');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const bundle = async (name) => {
  const out = path.join(TMP, `${name}.mjs`);
  await build({
    entryPoints: [path.join(ROOT, `src/components/chart/${name}.jsx`)],
    bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    logLevel: 'silent', absWorkingDir: ROOT,
  });
  return out;
};

// ── 1. the colour picker on a phone ────────────────────────────────────────────────────────────
console.log(`\n1. the colour picker at ${MOBILE.width}x${MOBILE.height}`);

{
  const out = await bundle('ColorPicker');
  const dom = mobileDom();
  const { act } = await import('react');
  const ReactDOMClient = await import('react-dom/client');
  const ColorPicker = (await import(pathToFileURL(out).href)).default;

  dom.window.Element.prototype.getBoundingClientRect = () => ({
    top: 300, bottom: 322, left: 40, right: 130, width: 90, height: 22, x: 40, y: 300,
    toJSON() { return this; },
  });
  const host = dom.window.document.getElementById('page');
  const root = ReactDOMClient.createRoot(host);
  const panel = () => host.querySelector('[data-cp-color-panel]');
  const openIt = async () => act(async () => {
    [...host.querySelectorAll('button')].find((b) => /more colors/.test(b.getAttribute('aria-label') || '')).click();
  });

  await act(async () => {
    root.render(React.createElement(ColorPicker, { theme: 'light', value: 2, compact: true, onChange: () => {} }));
  });
  await openIt();
  ok('the palette opens on a phone viewport', !!panel());
  ok('...with all 90 swatches, and it fits the 390px width',
    [...panel().querySelectorAll('button')].filter((b) => PALETTE.includes(b.getAttribute('aria-label'))).length === 90);
  const w = /width:\s*(\d+)px/.exec(panel().getAttribute('style') || '');
  ok('...the popover is narrower than the phone', w && Number(w[1]) < MOBILE.width, w ? `${w[1]}px` : 'no width');

  // ⚠️ THE MOBILE PATH: visualViewport scroll, which is how iOS reports a page pan.
  await act(async () => { dom.window.visualViewport.dispatchEvent(new dom.window.Event('scroll')); });
  ok('⚠️ a visualViewport scroll closes the palette', panel() === null);

  // ...and the document path still works.
  await openIt();
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event('scroll')); });
  ok('a window scroll still closes it', panel() === null);

  // Case E: it reopens normally after scrolling.
  await openIt();
  ok('⚠️ it reopens normally after a scroll', !!panel()
    && [...panel().querySelectorAll('button')].filter((b) => PALETTE.includes(b.getAttribute('aria-label'))).length === 90);
  await act(async () => { root.unmount(); });
}

// ── 2. the Popover portal — every chart menu goes through it ────────────────────────────────────
console.log('\n2. the Popover portal, which every chart menu uses');

{
  const out = await bundle('ChartUI');
  const dom = mobileDom();
  const { act } = await import('react');
  const ReactDOMClient = await import('react-dom/client');
  const mod = await import(pathToFileURL(out).href);
  const { Popover } = mod;
  ok('ChartUI exports the shared Popover', typeof Popover === 'function');

  dom.window.Element.prototype.getBoundingClientRect = () => ({
    top: 200, bottom: 222, left: 40, right: 130, width: 90, height: 22, x: 40, y: 200,
    toJSON() { return this; },
  });

  const host = dom.window.document.getElementById('page');
  const root = ReactDOMClient.createRoot(host);
  let open = true;
  const closes = [];
  const anchor = { current: dom.window.document.createElement('button') };
  dom.window.document.body.appendChild(anchor.current);
  // ⚠️ REOPENS EACH TIME. onClose sets open=false, so re-rendering without resetting it renders a CLOSED
  // popover — the next scroll then closes nothing and the count reads one short. That is bookkeeping in
  // this harness, not behaviour in the component, and it cost two false failures.
  const render = async () => act(async () => {
    open = true;
    root.render(React.createElement(Popover, {
      anchorRef: anchor, open, onClose: () => { closes.push(1); open = false; },
      theme: 'light', label: 'Drawing style',
    }, React.createElement('div', null, 'menu body')));
  });
  await render();
  const portal = () => dom.window.document.querySelector('[role="menu"][aria-label="Drawing style"]');
  ok('the popover renders into a body portal', !!portal());
  ok('...and is position:fixed, which is why a scroll orphans it',
    /position:\s*fixed/.test(portal()?.getAttribute('style') || ''));

  // ⚠️ THE REPORTED BUG: a page scroll used to leave this floating over unrelated sections.
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event('scroll')); });
  ok('⚠️ a page scroll closes the popover', closes.length === 1, `${closes.length} closes`);
  await render();
  await act(async () => { dom.window.visualViewport.dispatchEvent(new dom.window.Event('scroll')); });
  ok('⚠️ a visualViewport scroll closes it too (the iOS path)', closes.length === 2, `${closes.length}`);

  // A touch tap outside must dismiss it — mobile fires no mousedown.
  await render();
  await act(async () => {
    dom.window.document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  });
  ok('⚠️ a pointerdown outside closes it (touch fires no mousedown)', closes.length === 3, `${closes.length}`);
  await act(async () => { root.unmount(); });
}

// ── 3. page scroll vs chart gesture, at the source ─────────────────────────────────────────────
console.log('\n3. page scroll vs chart gesture');

{
  const cp = code(read('src/components/chart/CPChart.jsx'));
  const ui = code(read('src/components/chart/ChartUI.jsx'));
  const pick = code(read('src/components/chart/ColorPicker.jsx'));

  // ⚠️ CAPTURE. Without it a scroll in any ancestor between the chart and the document is unheard —
  // `scroll` does not bubble. This was the first half of why mobile still floated.
  ok('⚠️ the chart listens for scroll in the capture phase',
    /addEventListener\('scroll', onPageScroll, \{ passive: true, capture: true \}\)/.test(cp));
  ok('⚠️ ...and on visualViewport, which is how iOS reports a page pan',
    /vv\?\.addEventListener\('scroll', onPageScroll\)/.test(cp));
  ok('the popover does both as well',
    /addEventListener\('scroll', onScroll, true\)/.test(ui) && /vv\?\.addEventListener\('scroll', onScroll\)/.test(ui));
  ok('the picker does both as well',
    /addEventListener\('scroll', onScroll, true\)/.test(pick) && /vvPick\?\.addEventListener\('scroll', onScroll\)/.test(pick));
  ok('the popover also closes on a pointerdown outside', /addEventListener\('pointerdown', onDown\)/.test(ui));

  // ⚠️ CASE D. visualViewport `resize` fires for the keyboard, the URL bar AND a page pinch — closing on
  // it would dismiss the toolbar mid-pinch while someone zooms the chart.
  ok('⚠️ nothing closes on a visualViewport resize, so a pinch is not mistaken for leaving',
    !/visualViewport[\s\S]{0,200}addEventListener\('resize'/.test(cp)
    && !/vv\?\.addEventListener\('resize'/.test(cp) && !/vv\?\.addEventListener\('resize'/.test(ui));
  // ⚠️ CASE C. A chart pan is a pointer gesture on a canvas; it must not be wired to the close path.
  ok('⚠️ a chart range change is not treated as a page scroll',
    !/subscribeVisibleLogicalRangeChange\([^)]*closeFloating/.test(cp));
  ok('...nor is the crosshair', !/subscribeCrosshairMove\([^)]*closeFloating/.test(cp));
  // Every listener is removed, including the visualViewport ones.
  for (const [name, src] of [['CPChart', cp], ['ChartUI', ui], ['ColorPicker', pick]]) {
    ok(`${name} removes its visualViewport listener`, /removeEventListener\('scroll'/.test(src)
      && /vv(?:Pick)?\?\.removeEventListener\('scroll'/.test(src));
  }

  // ⚠️ AND NONE OF THE FORBIDDEN FIXES.
  ok('⚠️ the toolbar is not position:fixed or sticky',
    !/position:\s*'(?:fixed|sticky)'/.test(code(read('src/components/chart/DrawingToolbar.jsx'))));
  ok('⚠️ no arbitrary timeout dismisses anything',
    !/setTimeout\([^)]*closeFloating/.test(cp) && !/setTimeout\([^)]*onClose/.test(ui));
  ok('⚠️ no mobile-only CSS hides the toolbar',
    !/display:\s*'none'/.test(code(read('src/components/chart/DrawingToolbar.jsx'))));
  // Case F: symbol/timeframe changes still clear it.
  ok('a symbol or timeframe change still clears the toolbar',
    /useEffect\(\(\) => \{ setSelBox\(null\); \}, \[sym, tf\]\)/.test(cp));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
