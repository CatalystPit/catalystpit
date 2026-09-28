// DOES THE COLOUR PICKER ACTUALLY LAY OUT, IN A REAL BROWSER?
//
//   node scripts/verify-picker-layout.mjs
//
// ⚠️ WHY THIS EXISTS AND WHY IT IS NOT jsdom. The palette's size is arithmetic — nine swatches plus
// eight gaps — and every other suite checks that arithmetic. jsdom cannot check the thing the
// arithmetic is FOR: it performs no layout, so `width: 320` holding exactly 320px of swatches looks
// identical to one holding 330px of them. The reported bug was the far-right purple column being cut
// off, which is precisely a layout fact, so it needs a layout engine.
//
// ⚠️ ZERO SLACK IS THE BUG CLASS. A row of nine 32px swatches with four 4px gaps is 320px in a 320px
// box: correct to the pixel, and therefore wrong. Sub-pixel rounding under fractional display scaling
// (125%, 150% — the Windows default on many laptops) turns "exactly fits" into "last column clipped",
// and the popover's own `overflowX: hidden` clips it rather than revealing it. So this runs at several
// device pixel ratios, and asserts SLACK rather than equality.
//
// ⚠️ THE HARNESS PAGE CARRIES `* { box-sizing: border-box }` BECAUSE THE APP DOES. Leaving it out is
// not a harmless simplification: it changes what `width` means on every box, so the popover measured
// 176px here and 166px on production, the palette overflowed its host by exactly the chrome, and this
// suite reported 209/0 against a build whose purple column was still cut off. A harness that does not
// reproduce the page's box model measures a different component.
//
// It drives the Chrome already installed on the machine over the DevTools protocol — no puppeteer, no
// Chromium download, no new dependency. Needs a browser, so like verify-deployed it is not part of the
// offline run.

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('No Chrome or Edge found. This suite needs a real browser; skipping is not a pass.');
  process.exit(2);
}

// ── the page under test ────────────────────────────────────────────────────────────────────────
const TMP = path.join(ROOT, 'node_modules', '.cache', 'picker-layout');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

fs.writeFileSync(path.join(TMP, 'entry.jsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ColorPicker from '${path.join(ROOT, 'src/components/chart/ColorPicker.jsx').replace(/\\/g, '/')}';
import DrawingToolbar from '${path.join(ROOT, 'src/components/chart/DrawingToolbar.jsx').replace(/\\/g, '/')}';
import { PALETTE } from '${path.join(ROOT, 'src/lib/chart/color-palette.mjs').replace(/\\/g, '/')}';

window.PALETTE = PALETTE;

function Harness({ which, theme, colour, box }) {
  const drawing = {
    id: 'd1', type: 'horizontal', locked: false,
    points: [{ time: 1700000000, price: 101.5 }],
    style: { color: colour, width: 2, dash: 'solid' },
  };
  if (which === 'toolbar') {
    return React.createElement('div', {
      style: { position: 'relative', width: '100%', height: 520, overflow: 'hidden' },
    }, React.createElement(DrawingToolbar, {
      theme, drawing, box: box || { x: 40, y: 240, w: 200, h: 2 },
      plot: { w: window.innerWidth, h: 520 },
      onStyle: () => {}, onPatch: () => {}, onDelete: () => {}, onOpenSettings: () => {},
    }));
  }
  const pos = box ? { position: 'absolute', left: box.x, top: box.y } : { padding: 40 };
  return React.createElement('div', { style: pos },
    React.createElement(ColorPicker, { theme, value: colour, compact: true, onChange: () => {} }));
}

window.mount = (which, theme, colour, box) => {
  const host = document.getElementById('root');
  // The popover is a PORTAL in document.body. Clearing the host detaches the harness but leaves the
  // portal behind, so the next case's querySelector finds the PREVIOUS case's palette — every
  // measurement after the first would describe a stale render. Unmount, do not just detach.
  if (window.__root) { window.__root.unmount(); window.__root = null; }
  host.innerHTML = '';
  const el = document.createElement('div');
  host.appendChild(el);
  window.__root = createRoot(el);
  window.__root.render(React.createElement(Harness, { which, theme, colour, box }));
};

// Open whatever trigger this case exposes: the toolbar's colour square, or the picker's own swatch.
window.openPalette = () => {
  const btn = [...document.querySelectorAll('button')].find((b) => {
    const l = b.getAttribute('aria-label') || '';
    return l === 'Color' || /more colors/.test(l);
  });
  if (btn) btn.click();
  return !!btn;
};

/**
 * MEASURE WHAT IS ON SCREEN.
 *
 * Reports, for the open palette: the clipping container's box, the grid rows' first and last swatch,
 * the padding either side, and whether anything overflows. All from getBoundingClientRect and
 * scrollWidth, i.e. from layout, not from the constants that were supposed to produce it.
 */
window.measure = () => {
  const panel = document.querySelector('[data-cp-palette]');
  if (!panel) return { error: 'no palette' };
  // The nearest ancestor that would clip: the portalled popover, or the picker's own panel.
  const clipper = panel.closest('[role="menu"]') || panel.closest('[data-cp-color-panel]') || panel;
  const cs = getComputedStyle(clipper);
  const cb = clipper.getBoundingClientRect();
  const inner = {
    left: cb.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
    right: cb.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
    top: cb.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop),
    bottom: cb.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom),
  };
  const swatches = [...panel.querySelectorAll('button')]
    .filter((b) => window.PALETTE.includes(b.getAttribute('aria-label')));
  // Rows, grouped by their flex parent, in document order.
  const rowMap = new Map();
  for (const s of swatches) {
    const key = s.parentElement;
    if (!rowMap.has(key)) rowMap.set(key, []);
    rowMap.get(key).push(s);
  }
  const rows = [...rowMap.values()].map((cells) => {
    const rects = cells.map((c) => c.getBoundingClientRect());
    return {
      n: cells.length,
      firstLeft: rects[0].left,
      lastRight: rects[rects.length - 1].right,
      swatchW: rects[0].width,
      swatchH: rects[0].height,
      colours: cells.map((c) => c.getAttribute('aria-label')),
    };
  });
  const selected = swatches.find((s) => s.getAttribute('aria-pressed') === 'true');
  const selRect = selected ? selected.getBoundingClientRect() : null;
  const selOutline = selected ? parseFloat(getComputedStyle(selected).outlineWidth) || 0 : 0;
  const selOffset = selected ? parseFloat(getComputedStyle(selected).outlineOffset) || 0 : 0;
  const overflowing = [clipper, panel, ...panel.querySelectorAll('*')]
    .filter((el) => el.scrollWidth > el.clientWidth + 0.5 || el.scrollHeight > el.clientHeight + 0.5)
    .map((el) => ({
      tag: el.tagName, cls: el.getAttribute('data-cp-palette') != null ? 'palette' : (el.getAttribute('role') || ''),
      scrollW: el.scrollWidth, clientW: el.clientWidth, scrollH: el.scrollHeight, clientH: el.clientHeight,
    }));
  return {
    dpr: window.devicePixelRatio,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    clipper: { box: { left: cb.left, right: cb.right, top: cb.top, bottom: cb.bottom, w: cb.width, h: cb.height }, inner },
    panel: panel.getBoundingClientRect().toJSON(),
    rows,
    swatchCount: swatches.length,
    selected: selected ? { colour: selected.getAttribute('aria-label'), right: selRect.right, ring: selOutline + selOffset } : null,
    overflowing,
  };
};
`, 'utf8');

await build({
  entryPoints: [path.join(TMP, 'entry.jsx')],
  bundle: true, format: 'iife', platform: 'browser', outfile: path.join(TMP, 'bundle.js'),
  jsx: 'automatic', absWorkingDir: ROOT, logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"' },
});

fs.writeFileSync(path.join(TMP, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<style>*{box-sizing:border-box}html,body{margin:0;padding:0;background:#0b0f0d}</style>'
  + '</head><body><div id="root"></div><script src="bundle.js"></script></body></html>', 'utf8');

// ── drive the browser ──────────────────────────────────────────────────────────────────────────
const PORT = 9333 + (process.pid % 200);
const profile = path.join(os.tmpdir(), `cp-picker-${process.pid}`);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const endpoint = async () => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return null;
};
const browserWs = await endpoint();
if (!browserWs) { chrome.kill(); console.error('Chrome did not expose a debugging endpoint.'); process.exit(2); }

let nextId = 0;
const open = async (url) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return r.json();
};
const connect = (wsUrl) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  const waiters = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  });
  ws.addEventListener('error', reject);
  ws.addEventListener('open', () => resolve({
    send: (method, params = {}) => new Promise((res) => {
      const id = ++nextId;
      waiters.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  }));
});

const target = await open(`file:///${path.join(TMP, 'index.html').replace(/\\/g, '/')}`);
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

const evaluate = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

// Wait for the bundle to define its hooks.
for (let i = 0; i < 60; i += 1) {
  if (await evaluate('typeof window.mount === "function"')) break;
  await sleep(200);
}
ok('the harness page loaded in a real browser', !!(await evaluate('typeof window.mount === "function"')));

const { PALETTE, PALETTE_COLUMNS, PALETTE_ROWS } = await import('../src/lib/chart/color-palette.mjs');

/**
 * ⚠️ FRACTIONAL SCALING IS PART OF THE TEST, NOT AN EDGE CASE. 125% and 150% are the Windows defaults
 * on high-DPI laptops, and they are where a layout that fits to the pixel stops fitting.
 */
const CASES = [];
// ⚠️ THE SELECTED COLOUR IS PART OF THE TEST. The reported symptom was the PURPLE column looking cut
// off, and purple is the rightmost column — so the case that matters is one where the selected swatch,
// and therefore its 2px ring drawn 1px outside the box, sits against the clipping edge. A green swatch
// in column six proves nothing about it.
const PURPLE = PALETTE[85];   // purple, mid-ramp: the rightmost column
const GRAY = PALETTE[0];      // white, mid-ramp: the leftmost column
for (const dpr of [1, 1.25, 1.5]) {
  for (const which of ['toolbar', 'picker']) {
    CASES.push({ which, dpr, vw: 1440, vh: 900, colour: PURPLE, label: `desktop ${which} purple @${dpr}x` });
  }
}
CASES.push({ which: 'toolbar', dpr: 1, vw: 1440, vh: 900, colour: GRAY, label: 'desktop toolbar gray @1x' });
// And a touch phone, where the swatches must stay big.
CASES.push({ which: 'toolbar', dpr: 2, vw: 390, vh: 844, touch: true, colour: PURPLE, label: 'phone toolbar purple @2x' });
CASES.push({ which: 'picker', dpr: 2, vw: 390, vh: 844, touch: true, colour: PURPLE, label: 'phone picker purple @2x' });
// ⚠️ ALL FOUR CORNERS OF THE PLOT, in a real browser. placeFor is unit-tested as pure geometry; this is
// the check that the geometry survives contact with a portal, a transform-free ancestor and real layout.
const CORNERS = [
  ['top-left', { x: 4, y: 4, w: 60, h: 2 }],
  ['top-right', { x: 1340, y: 4, w: 60, h: 2 }],
  ['bottom-left', { x: 4, y: 470, w: 60, h: 2 }],
  ['bottom-right', { x: 1340, y: 470, w: 60, h: 2 }],
  ['centre', { x: 700, y: 250, w: 60, h: 2 }],
];
for (const [where, box] of CORNERS) {
  CASES.push({ which: 'toolbar', dpr: 1, vw: 1440, vh: 900, colour: PURPLE, box, label: `corner ${where}` });
  CASES.push({ which: 'picker', dpr: 1, vw: 1440, vh: 900, colour: PURPLE, box, label: `corner ${where} (picker)` });
}

const results = [];
for (const c of CASES) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: c.vw, height: c.vh, deviceScaleFactor: c.dpr, mobile: !!c.touch,
  });
  // ⚠️ TOUCH EMULATION IS WHAT MAKES `(pointer: coarse)` TRUE. Without it the "phone" case is a phone
  // -sized window with a mouse — which is a real configuration, but not the one that must keep big
  // swatches, and the first run of this suite reported 16px there and looked like a bug in the sizing.
  await cdp.send('Emulation.setTouchEmulationEnabled', {
    enabled: !!c.touch, maxTouchPoints: c.touch ? 5 : 1,
  });
  await evaluate(`window.mount(${JSON.stringify(c.which)}, "dark", ${JSON.stringify(c.colour)}, ${JSON.stringify(c.box || null)})`);
  await sleep(120);
  const opened = await evaluate('window.openPalette()');
  await sleep(160);
  const m = await evaluate('JSON.stringify(window.measure())').then((s) => JSON.parse(s));
  results.push({ c, opened, m });
}

console.log('\n1. the palette opens and renders every swatch, in a real browser');
for (const { c, opened, m } of results) {
  ok(`${c.label}: the trigger exists and opens the palette`, opened && !m.error, m.error || '');
  if (m.error) continue;
  ok(`${c.label}: all ${PALETTE.length} swatches are laid out`, m.swatchCount === PALETTE.length, `${m.swatchCount}`);
  ok(`${c.label}: in ${PALETTE_ROWS} rows of ${PALETTE_COLUMNS}`,
    m.rows.length === PALETTE_ROWS && m.rows.every((r) => r.n === PALETTE_COLUMNS),
    `${m.rows.length} rows: ${m.rows.map((r) => r.n).join(',')}`);
}

console.log('\n2. ⚠️ NOTHING IS CLIPPED, and the padding is symmetrical');
for (const { c, m } of results) {
  if (m.error) continue;
  const inner = m.clipper.inner;
  const lefts = m.rows.map((r) => r.firstLeft - inner.left);
  const rights = m.rows.map((r) => inner.right - r.lastRight);
  const minRight = Math.min(...rights);
  const maxSkew = Math.max(...m.rows.map((r, i) => Math.abs(lefts[i] - rights[i])));
  // ⚠️ THE PURPLE COLUMN. Its right edge must be INSIDE the content box, with room to spare — not
  // level with it, because level is what rounds away.
  ok(`⚠️ ${c.label}: the rightmost column is fully inside the panel`,
    minRight >= 0.5, `right gap ${minRight.toFixed(2)}px`);
  ok(`⚠️ ${c.label}: ...and its padding matches the left column's`,
    maxSkew <= 1.01, `worst left/right difference ${maxSkew.toFixed(2)}px`);
  // The selection ring is drawn outside the swatch and IS clipped by overflow:hidden.
  if (m.selected) {
    ok(`⚠️ ${c.label}: the selected swatch's ring is not clipped`,
      m.selected.right + m.selected.ring <= inner.right + 0.51,
      `ring ends ${(m.selected.right + m.selected.ring - inner.right).toFixed(2)}px past the content box`);
  }
  ok(`⚠️ ${c.label}: nothing scrolls, in either axis`,
    m.overflowing.length === 0, JSON.stringify(m.overflowing).slice(0, 200));
  ok(`${c.label}: the whole popover is inside the viewport`,
    m.clipper.box.left >= -0.5 && m.clipper.box.top >= -0.5
    && m.clipper.box.right <= m.viewport.w + 0.5 && m.clipper.box.bottom <= m.viewport.h + 0.5,
    JSON.stringify(m.clipper.box));
}

console.log('\n3. ⚠️ DESKTOP IS DENSE, TOUCH STAYS TAPPABLE');
const desktop = results.filter((r) => !r.c.touch && !r.m.error);
const touch = results.filter((r) => r.c.touch && !r.m.error);
for (const { c, m } of desktop) {
  const sw = m.rows[0].swatchW;
  ok(`⚠️ ${c.label}: the swatch is compact`, sw <= 20.5, `${sw.toFixed(2)}px`);
  ok(`${c.label}: ...but still a visible colour`, sw >= 12, `${sw.toFixed(2)}px`);
  ok(`⚠️ ${c.label}: the whole popover is materially smaller than the 330px one it replaces`,
    m.clipper.box.w <= 230, `${m.clipper.box.w.toFixed(1)}px wide`);
}
for (const { c, m } of touch) {
  const sw = m.rows[0].swatchW;
  ok(`⚠️ ${c.label}: the swatch is still a comfortable tap target`, sw >= 26, `${sw.toFixed(2)}px`);
  ok(`${c.label}: ...and the palette still fits the phone`,
    m.clipper.box.w <= m.viewport.w - 8, `${m.clipper.box.w.toFixed(1)}px in ${m.viewport.w}px`);
}
ok('both pointer kinds were actually exercised', desktop.length >= 4 && touch.length >= 1,
  `${desktop.length} desktop, ${touch.length} touch`);

// A compact report, so the numbers are in the log rather than only in the assertions.
console.log('\n   case                        popover      swatch   left/right padding   rows');
for (const { c, m } of results) {
  if (m.error) { console.log(`   ${c.label.padEnd(26)} ${m.error}`); continue; }
  const inner = m.clipper.inner;
  const l = (m.rows[0].firstLeft - inner.left).toFixed(2);
  const r = (inner.right - m.rows[0].lastRight).toFixed(2);
  console.log(`   ${c.label.padEnd(26)} ${`${m.clipper.box.w.toFixed(1)}x${m.clipper.box.h.toFixed(1)}`.padEnd(12)}`
    + ` ${m.rows[0].swatchW.toFixed(1)}px`.padEnd(9) + ` ${l} / ${r}`.padEnd(20) + ` ${m.rows.length}x${m.rows[0].n}`);
}

cdp.close();
chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still hold it */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
