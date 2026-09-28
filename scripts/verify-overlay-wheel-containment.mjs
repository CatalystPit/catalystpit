// A WHEEL INSIDE A CHART OVERLAY CANNOT REACH THE CHART.
//
//   node scripts/verify-overlay-wheel-containment.mjs
//
// ⚠️ THERE ARE TWO WAYS A WHEEL CAN GET FROM AN OPEN DROPDOWN TO THE CHART, and they need different
// evidence, so this suite checks both rather than one twice.
//
//   1. EVENT PROPAGATION. If the menu were rendered inside the chart's own box, a wheel over it would
//      bubble to the chart's handlers. It is not — every chart overlay is portalled to document.body —
//      and that is a DOM fact jsdom can prove by dispatching a real event and watching a listener on
//      the chart host that must never fire.
//
//   2. SCROLL CHAINING. This is the one that actually bit. When a scrollable box reaches its end, the
//      browser hands the remaining delta to the next scrollable ancestor — the page — and the chart
//      moves out from under the cursor. jsdom implements no scrolling and no chaining whatsoever, so
//      it cannot observe this at all; what it CAN check is that the boundary declares containment.
//      The behaviour itself is measured in a real browser by verify-overlay-wheel.mjs.
//
// Naming which half each assertion covers is the point: a suite that only dispatched an event would
// have passed against the broken build, because propagation was never the problem.

import { JSDOM } from 'jsdom';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

// ── 1. every scrollable chart overlay declares containment ─────────────────────────────────────
console.log('\n1. every scrollable chart overlay declares containment');

// ⚠️ FOUND BY SCANNING, NOT BY LISTING. A hand-written list of overlays is a list that goes stale the
// first time someone adds one — and the whole point of fixing this at the boundary was that it should
// hold for overlays nobody has written yet.
{
  const FILES = fs.readdirSync(path.join(ROOT, 'src/components/chart'))
    .filter((f) => f.endsWith('.jsx'))
    .map((f) => `src/components/chart/${f}`);
  const offenders = [];
  let scrollers = 0;
  for (const f of FILES) {
    const src = read(f);
    // Each style object that turns on scrolling, with the rest of that object for company.
    const re = /overflow(?:Y|X)?:\s*'(?:auto|scroll)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      scrollers += 1;
      // The enclosing style object: back to the nearest '{' that opens it, forward to its close.
      const start = src.lastIndexOf('{', m.index);
      const end = src.indexOf('}}', m.index);
      const obj = src.slice(start, end === -1 ? m.index + 200 : end);
      if (!/overscrollBehavior/.test(obj)) offenders.push(`${path.basename(f)}: ${m[0]}`);
    }
  }
  ok('the scan actually found the scroll containers', scrollers >= 3, `${scrollers} found`);
  ok('⚠️ every scrollable chart surface contains its own scrolling',
    offenders.length === 0, offenders.join(' | '));
  // ⚠️ THE SLICE HAS TO START AT THE POPOVER AND END AFTER IT. The first version ended at
  // indexOf('document.body,'), which matched that string in a COMMENT near the top of the file — before
  // the Popover — so the slice was empty and the assertion failed against a source that was correct.
  // An end searched from the start index cannot land behind it.
  const ui = read('src/components/chart/ChartUI.jsx');
  const popStart = ui.indexOf('role="menu"');
  const popEnd = ui.indexOf('document.body,', popStart);
  ok('the Popover block was located', popStart > 0 && popEnd > popStart, `${popStart}..${popEnd}`);
  ok('⚠️ ...including the shared Popover, which is what makes it true for every menu at once',
    /overscrollBehavior: 'contain'/.test(ui.slice(popStart, popEnd)));
}

// ⚠️ AND THE CHART'S OWN WHEEL HANDLING IS UNTOUCHED. The brief rules out fixing this by disabling the
// chart's wheel input, which would trade a scoped bug for an unscoped one.
{
  const cp = read('src/components/chart/CPChart.jsx');
  ok('⚠️ the chart does not globally suppress the wheel',
    !/handleScroll:\s*false/.test(cp) && !/mouseWheel:\s*false/.test(cp)
    && !/addEventListener\('wheel'/.test(cp),
    'containment belongs at the overlay boundary, not in the chart');
  const ui = read('src/components/chart/ChartUI.jsx');
  ok('⚠️ ...and no overlay hand-rolls a wheel policy of its own',
    !/onWheel=/.test(ui) && !/addEventListener\('wheel'/.test(ui),
    'a preventDefault-on-wheel handler is a second scrolling policy beside the browser\'s');
}

// ── 2. a wheel in an open menu never reaches the chart's subtree ───────────────────────────────
console.log('\n2. a wheel in an open menu never reaches the chart\'s subtree');

{
  const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-wheel');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, 'ChartUI.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/components/chart/ChartUI.jsx')],
    bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    logLevel: 'silent', absWorkingDir: ROOT,
  });

  const dom = new JSDOM(
    '<!doctype html><html><body><div id="chart"><div id="plot"></div><div id="anchor"></div></div></body></html>',
    { url: 'https://catalystpit.test/ticker/NVDA', pretendToBeVisual: true },
  );
  const VW = 1440, VH = 900;
  Object.defineProperty(dom.window, 'innerWidth', { value: VW, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: VH, configurable: true });
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver',
    'Event', 'WheelEvent', 'ResizeObserver']) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); }
  }
  for (const [k, v] of [['innerWidth', VW], ['innerHeight', VH]]) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    top: 200, bottom: 222, left: 300, right: 360, width: 60, height: 22, x: 300, y: 200,
    toJSON() { return this; },
  });

  const { act } = await import('react');
  const ReactDOMClient = await import('react-dom/client');
  const { Popover } = await import(pathToFileURL(out).href);
  const doc = dom.window.document;
  const chartHost = doc.getElementById('chart');
  const anchorEl = doc.getElementById('anchor');

  // ⚠️ THE CHART'S HANDLER, STANDING IN FOR THE REAL ONE. The charting library binds its wheel-to-zoom
  // on its own container; what matters here is whether an event raised inside the menu can ever be
  // seen by a listener on that container. A count of zero is the whole assertion.
  let chartWheels = 0;
  chartHost.addEventListener('wheel', () => { chartWheels += 1; });

  const mount = doc.createElement('div');
  doc.body.appendChild(mount);
  const root = ReactDOMClient.createRoot(mount);
  const anchorRef = { current: anchorEl };
  await act(async () => {
    root.render(React.createElement(Popover, {
      anchorRef, open: true, onClose: () => {}, theme: 'dark', label: 'Timeframe',
      width: 200, maxHeight: 240,
    }, React.createElement('div', { style: { height: 900 } }, 'intervals')));
  });

  const menu = doc.querySelector('[role="menu"]');
  ok('the menu rendered', !!menu);
  ok('⚠️ it is portalled OUT of the chart, so a wheel in it cannot bubble to the chart',
    !!menu && !chartHost.contains(menu) && menu.parentElement === doc.body,
    'a menu rendered inside the chart box would deliver every wheel to the chart by propagation alone');

  // A wheel raised on the deepest node inside the menu, exactly as the pointer would.
  const inner = menu.firstElementChild || menu;
  await act(async () => {
    inner.dispatchEvent(new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
  });
  ok('⚠️ the chart saw nothing', chartWheels === 0, `${chartWheels} wheel events reached the chart host`);

  // ⚠️ THE POSITIVE CONTROL. Without it, "the chart saw nothing" would also pass if the listener were
  // never wired, if wheel events did not exist in this DOM, or if the dispatch silently did nothing.
  await act(async () => {
    doc.getElementById('plot').dispatchEvent(
      new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }),
    );
  });
  ok('⚠️ ...but a wheel over the plot DOES reach it', chartWheels === 1,
    `${chartWheels} — the chart must keep its own wheel behaviour`);

  // And the boundary the browser needs, on the element that actually scrolls.
  const style = menu.getAttribute('style') || '';
  ok('⚠️ the rendered menu declares scroll containment',
    /overscroll-behavior:\s*contain/.test(style), style.slice(0, 160));
  ok('...and is still the thing that scrolls', /overflow-y:\s*auto/.test(style), style.slice(0, 160));

  await act(async () => { root.unmount(); });
  ok('⚠️ closing the menu leaves nothing behind to swallow a wheel',
    doc.querySelectorAll('[role="menu"]').length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
