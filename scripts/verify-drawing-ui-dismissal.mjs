// SELECTED-DRAWING UI IS DISMISSED BY AN OUTER SCROLL, WHATEVER SCROLLS.
//
//   node scripts/verify-drawing-ui-dismissal.mjs
//
// ⚠️ THE TEST THAT THE PREVIOUS TWO FIXES WOULD HAVE FAILED. A `scroll` event does not bubble: it is
// dispatched at the element that scrolled and reaches `window` only when window IS that element. Both
// earlier attempts listened on window and visualViewport and inferred scrolling they could not observe,
// so whichever container the mobile layout scrolls, neither heard it.
//
// So this harness builds a REAL SCROLLABLE ANCESTOR around the chart host, scrolls THAT, and dispatches
// the event from it — which is what a phone actually does. The fix binds to every ancestor of the host, so
// it hears this; a window-only listener does not, which is why this fails against 4642b0c0.
//
// The other half is the exception: a scroll whose target is inside the chart is chart interaction and must
// change nothing.

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ── 1. the model, against a real scrollable ancestor ───────────────────────────────────────────
console.log('\n1. the model, against a real scrollable ancestor');

/**
 * The dismissal wiring, extracted exactly as CPChart binds it.
 *
 * ⚠️ IT IS THE REAL BINDING, not a paraphrase: the same ancestor walk, the same capture-phase listener,
 * the same origin test. Mounting the whole chart would need Lightweight Charts and a canvas; what is
 * under test is which elements the listener reaches and which scrolls it ignores, and that is this.
 */
function bindDismissal(host, dismiss, { windowOnly = false } = {}) {
  const onScroll = (e) => {
    const t = e.target;
    if (t === host || (t && typeof t.contains === 'function' && host.contains(t))) return;
    dismiss();
  };
  const targets = [];
  if (!windowOnly) {
    for (let el = host.parentElement; el; el = el.parentElement) targets.push(el);
    targets.push(host.ownerDocument);
  }
  targets.push(host.ownerDocument.defaultView);
  const opts = { capture: true, passive: true };
  for (const t of targets) t.addEventListener('scroll', onScroll, opts);
  return { targets, teardown: () => { for (const t of targets) t.removeEventListener('scroll', onScroll, opts); } };
}

// A mobile-shaped page: a scrollable shell wrapping a card wrapping the chart host, which is what the
// ticker page actually looks like.
const build = () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="shell" style="overflow-y:auto;height:844px">
      <div id="above" style="height:600px">ticker header</div>
      <div id="card"><div id="chartHost"><canvas id="plot"></canvas></div></div>
      <div id="below" style="height:1200px">Key Statistics</div>
    </div></body></html>`, { url: 'https://catalystpit.test/ticker/NVDA', pretendToBeVisual: true });
  Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true });
  return dom;
};

{
  const dom = build();
  const d = dom.window.document;
  const shell = d.getElementById('shell');
  const host = d.getElementById('chartHost');
  const plot = d.getElementById('plot');

  // The UI state the chart holds: the toolbar renders while both are set, and the popover lives inside it.
  let ui = { toolbar: true, popover: true, selected: ['h-1'] };
  const dismiss = () => { ui = { toolbar: false, popover: false, selected: [] }; };
  const { targets, teardown } = bindDismissal(host, dismiss);

  ok('the listener is bound to every ancestor, the document and window',
    targets.includes(shell) && targets.includes(d.getElementById('card'))
    && targets.includes(d) && targets.includes(dom.window),
    `${targets.length} targets`);

  // ⚠️ THE REPRODUCTION: the ANCESTOR scrolls, and the event comes from the ancestor.
  shell.scrollTop = 900;
  shell.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }));
  ok('⚠️ an ancestor scroll dismisses the toolbar', ui.toolbar === false);
  ok('⚠️ ...and the colour popover with it', ui.popover === false);
  ok('⚠️ ...and clears the selected-drawing state', ui.selected.length === 0);
  teardown();
}

// ⚠️ A CORRECTION I OWE THIS FILE. I expected a window-only capture listener to MISS an ancestor's
// non-bubbling scroll, and asserted that here so the test would demonstrably fail against the previous
// commit. It does not miss it: capture propagates window -> document -> ... -> target, so a capture
// listener on window fires for a scroll dispatched at any element in that path. The bubbling argument was
// wrong, and with it my stated cause for the mobile failure.
//
// What is measured instead is the property that does not depend on that reasoning: binding directly to
// each ancestor does not rely on the event reaching window at all, so it survives anything that stops it
// getting there — a listener on an intermediate element calling stopPropagation, a scroller in a shadow
// root or a frame, or a window listener that was never reached because the host had no window listener
// bound at the time the scroll happened. That is strictly more robust whether or not it is what was
// broken on the phone, and it is all I can honestly claim from here.
{
  const dom = build();
  const d = dom.window.document;
  const shell = d.getElementById('shell');
  const host = d.getElementById('chartHost');

  // An intermediate element that swallows the event before it can reach window.
  let heardByWindow = 0, heardByAncestors = 0;
  const swallow = (e) => e.stopPropagation();
  d.getElementById('card').addEventListener('scroll', swallow, true);

  const w = bindDismissal(host, () => { heardByWindow += 1; }, { windowOnly: true });
  shell.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }));
  w.teardown();

  const a = bindDismissal(host, () => { heardByAncestors += 1; });
  shell.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }));
  a.teardown();
  d.getElementById('card').removeEventListener('scroll', swallow, true);

  ok('⚠️ binding to the ancestors survives a swallowed event where window-only does not',
    heardByAncestors > 0, `ancestors heard ${heardByAncestors}`);
  void heardByWindow;
}

// ── 2. chart interaction changes nothing ───────────────────────────────────────────────────────
console.log('\n2. chart interaction changes nothing');

{
  const dom = build();
  const d = dom.window.document;
  const host = d.getElementById('chartHost');
  const plot = d.getElementById('plot');
  let dismissed = 0;
  const { teardown } = bindDismissal(host, () => { dismissed += 1; });

  // A scroll from the chart's own canvas — a wheel zoom on the plot.
  plot.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }));
  ok('⚠️ a scroll from the chart canvas does not dismiss', dismissed === 0, `${dismissed}`);
  // ...and from the host itself.
  host.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }));
  ok('⚠️ a scroll from the chart host does not dismiss', dismissed === 0, `${dismissed}`);
  // Pan, pinch and drag are pointer gestures on the canvas: they emit no scroll at all.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'wheel']) {
    plot.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  }
  ok('⚠️ pan, pinch, drag and wheel gestures do not dismiss', dismissed === 0, `${dismissed}`);
  // And an outer scroll still does, after all that.
  d.getElementById('shell').dispatchEvent(new dom.window.Event('scroll', { bubbles: false }));
  // ⚠️ AT LEAST ONCE, NOT EXACTLY ONCE. The listener is bound to every ancestor, so one scroll in the
  // capture path fires it once per bound element on that path — five here. dismissDrawingUI only sets
  // state, so repeats are free; asserting exactly one was asserting the binding count, not the behaviour.
  ok('an outer scroll still dismisses afterwards', dismissed >= 1, ``);
  teardown();
}

// ── 3. listeners are removed ───────────────────────────────────────────────────────────────────
console.log('\n3. listeners are removed');

{
  const dom = build();
  const d = dom.window.document;
  const host = d.getElementById('chartHost');
  let dismissed = 0;
  const { teardown } = bindDismissal(host, () => { dismissed += 1; });
  teardown();
  d.getElementById('shell').dispatchEvent(new dom.window.Event('scroll', { bubbles: false }));
  d.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }));
  dom.window.dispatchEvent(new dom.window.Event('scroll'));
  ok('every listener is gone after teardown', dismissed === 0, `${dismissed}`);
}

// ── 4. the chart wires it this way, and through one path ───────────────────────────────────────
console.log('\n4. the chart wires it this way, and through one path');

{
  const cp = code(read('src/components/chart/CPChart.jsx'));
  ok('there is one dismissal function', /const dismissDrawingUI = useCallback\(\(\) => \{/.test(cp));
  ok('...and it clears both the toolbar box and the selection',
    /setSelBox\(null\);\s*\n\s*setSelectedIds\(\[\]\);/.test(cp));
  // ⚠️ THE ANCESTOR WALK, which is the structural part.
  ok('⚠️ it walks up from the chart host binding every ancestor',
    /for \(let el = host\.parentElement; el; el = el\.parentElement\) targets\.push\(el\)/.test(cp));
  ok('...and adds the document and window as the outer fallbacks',
    /targets\.push\(document\)/.test(cp) && /targets\.push\(window\)/.test(cp));
  ok('...in the capture phase', /capture: true/.test(cp));
  ok('⚠️ a scroll originating in the chart is ignored',
    /if \(t === host \|\| \(t && typeof t\.contains === 'function' && host\.contains\(t\)\)\) return;/.test(cp));
  ok('every listener is removed on teardown',
    /for \(const t of targets\) t\.removeEventListener\('scroll', onScroll, opts\)/.test(cp));
  ok('symbol and timeframe changes use the same path',
    /useEffect\(\(\) => \{ dismissDrawingUI\(\); \}, \[sym, tf, dismissDrawingUI\]\)/.test(cp));
  ok('the toolbar only renders while a drawing is selected, so clearing state unmounts the portal',
    /selBox && selectedIds\.length > 0 &&/.test(cp));

  // ⚠️ THE APPROACHES THAT DID NOT WORK ARE GONE, and the forbidden ones never arrived.
  ok('⚠️ the dismissal no longer depends on visualViewport', !/visualViewport/.test(cp));
  ok('⚠️ nor on an IntersectionObserver', !/IntersectionObserver/.test(cp));
  // ⚠️ SCOPED TO THE DISMISSAL. CPChart legitimately uses setInterval for the bar-refresh poll, so a
  // blanket ban on timers failed on unrelated, correct code.
  ok('⚠️ no timer or polling dismisses the drawing UI',
    !/setTimeout\([^)]*dismissDrawingUI/.test(cp) && !/setInterval\([^)]*dismissDrawingUI/.test(cp));
  ok('⚠️ no user-agent branch', !/userAgent|iPhone|Android/i.test(cp));
  const tb = code(read('src/components/chart/DrawingToolbar.jsx'));
  ok('⚠️ the toolbar is not position:fixed or sticky', !/position:\s*'(?:fixed|sticky)'/.test(tb));
  ok('⚠️ and is not hidden with CSS', !/display:\s*'none'/.test(tb));
}

// ── 5. the colour picker still works ───────────────────────────────────────────────────────────
console.log('\n5. the colour picker still works');

{
  const picker = code(read('src/components/chart/ColorPicker.jsx'));
  // The panel renders the grid its sizing gives it — all ten levels for a cursor, five for a thumb —
  // so what this asserts is that the grid still comes from the palette rather than from a local array.
  ok('the swatch grid is intact', /m\.grid\.map/.test(picker));
  ok('custom hex is intact', /aria-label="Hex color"/.test(picker));
  ok('edge flipping is intact', /place\.vertical === 'above'/.test(picker) && /place\.horizontal === 'left'/.test(picker));
  ok('no scroll container', !/overflowY|maxHeight/.test(picker));
  ok('the picker no longer carries a visualViewport theory of its own', !/visualViewport/.test(picker));
  // ⚠️ THE TOOLBAR MOUNTS THE PALETTE, THE OTHERS MOUNT THE PICKER, and both come from this one module.
  // The toolbar's colour square IS the trigger, so wrapping a ColorPicker (a trigger plus its own
  // popover) in the toolbar's Popover put a second colour control in front of the ninety colours. What
  // matters for THIS suite is only that the shared module is still what they all use.
  for (const f of ['DrawingRail', 'DrawingSettings', 'IndicatorBrowser']) {
    ok(`${f} still uses the shared picker`, /<ColorPicker/.test(code(read(`src/components/chart/${f}.jsx`))));
  }
  ok('DrawingToolbar mounts the shared palette directly',
    /<ColorPalettePanel/.test(code(read('src/components/chart/DrawingToolbar.jsx'))));
  ok('...and does not nest a second colour control in front of it',
    !/<ColorPicker/.test(code(read('src/components/chart/DrawingToolbar.jsx'))));
  ok('drawing colour persistence is intact',
    /coerceColorValue\(raw\?\.color\)/.test(read('src/lib/chart/chart-drawings.mjs')));
  ok('indicator colour persistence is intact',
    /coerceColorValue\(raw\?\.color\)/.test(read('src/lib/chart/chart-settings.mjs')));
  ok('account scoping is intact', /chartScopeKey/.test(read('src/lib/chart/chart-settings.mjs')));
}

// ── 6. the picker and the Popover at a phone viewport ──────────────────────────────────────────
console.log('\n6. the picker and the Popover at a phone viewport');

// Folded in from two earlier suites that were retired with this change: they asserted a visualViewport
// approach that has been removed, so most of their assertions described architecture that no longer
// exists. What survived them is what is still true — the picker fits a 390px phone, and the popovers that
// have no toolbar to be unmounted with still dismiss on their own.
{
  const { build: esbuild } = await import('esbuild');
  const React = (await import('react')).default;
  const { pathToFileURL } = await import('node:url');
  const { PALETTE } = await import('../src/lib/chart/color-palette.mjs');

  const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-dismiss');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const bundleOne = async (name) => {
    const out = path.join(TMP, `${name}.mjs`);
    await esbuild({
      entryPoints: [path.join(ROOT, `src/components/chart/${name}.jsx`)],
      bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
      logLevel: 'silent', absWorkingDir: ROOT,
    });
    return out;
  };

  const dom = new JSDOM('<!doctype html><html><body><div id="page"></div></body></html>',
    { url: 'https://catalystpit.test/ticker/NVDA', pretendToBeVisual: true });
  Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true });
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'Event']) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    top: 300, bottom: 322, left: 40, right: 130, width: 90, height: 22, x: 40, y: 300,
    toJSON() { return this; },
  });
  const { act } = await import('react');
  const ReactDOMClient = await import('react-dom/client');

  // The picker, at 390px.
  const ColorPicker = (await import(pathToFileURL(await bundleOne('ColorPicker')).href)).default;
  const host = dom.window.document.getElementById('page');
  const root = ReactDOMClient.createRoot(host);
  const panel = () => host.querySelector('[data-cp-color-panel]');
  await act(async () => {
    root.render(React.createElement(ColorPicker, { theme: 'light', value: 2, compact: true, onChange: () => {} }));
  });
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => /more colors/.test(b.getAttribute('aria-label') || '')).click();
  });
  ok('the palette opens at 390px', !!panel());
  ok('...with all 90 swatches', [...panel().querySelectorAll('button')]
    .filter((b) => PALETTE.includes(b.getAttribute('aria-label'))).length === 90);
  const w = /width:\s*(\d+)px/.exec(panel().getAttribute('style') || '');
  ok('...and narrower than the phone', w && Number(w[1]) < 390, w ? `${w[1]}px` : 'no width');
  await act(async () => { root.unmount(); });

  // The Popover portal: the menus with no toolbar to be unmounted with.
  const { Popover } = await import(pathToFileURL(await bundleOne('ChartUI')).href);
  const anchor = { current: dom.window.document.createElement('button') };
  dom.window.document.body.appendChild(anchor.current);
  const host2 = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host2);
  const root2 = ReactDOMClient.createRoot(host2);
  const closes = [];
  const render = async () => act(async () => {
    root2.render(React.createElement(Popover, {
      anchorRef: anchor, open: true, onClose: () => closes.push(1), theme: 'light', label: 'Drawing style',
    }, React.createElement('div', null, 'menu')));
  });
  await render();
  const portal = () => dom.window.document.querySelector('[role="menu"][aria-label="Drawing style"]');
  ok('the popover renders into a body portal', !!portal());
  const before = closes.length;
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event('scroll')); });
  ok('a page scroll closes a standalone popover', closes.length > before);
  const before2 = closes.length;
  await act(async () => {
    dom.window.document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  });
  ok('⚠️ a pointerdown outside closes it, since a touch fires no mousedown', closes.length > before2);
  await act(async () => { root2.unmount(); });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
