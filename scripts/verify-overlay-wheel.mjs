// A WHEEL INSIDE A CHART OVERLAY BELONGS TO THAT OVERLAY.
//
//   node scripts/verify-overlay-wheel.mjs [url]
//   CP_WHEEL_LOG=<path> node scripts/verify-overlay-wheel.mjs   (progress written as it goes)
//
// ⚠️ WHY THIS NEEDS A REAL BROWSER. The failure is scroll CHAINING: a wheel over an open dropdown
// scrolls the dropdown until it hits its end, and the browser then hands the remaining delta to
// whatever is behind it. jsdom implements no scrolling and no chaining at all, so the bug is invisible
// there — a jsdom test of this would pass against the broken build. Its companion,
// verify-overlay-wheel-containment.mjs, covers the half jsdom CAN prove (event propagation).
//
// ⚠️ AND THE CHART'S STATE IS READ FROM THE TIME AXIS, NOT FROM A SCREENSHOT OF THE PLOT. The plot
// repaints for reasons that have nothing to do with the wheel — a price tick, the crosshair, a blinking
// marker — so "the canvas changed" cannot tell a zoom from a quote arriving. The time axis is its own
// canvas and redraws only when the visible range does, which is exactly the thing that must not move.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'https://catalystpit.com/ticker/AAPL';

// ⚠️ WRITTEN AS IT GOES, NOT BUFFERED TO THE END. Piping this suite's output through anything makes
// stdout fully buffered, so a run that is killed prints nothing at all and looks identical to a hang.
const LOG = process.env.CP_WHEEL_LOG || '';
let pass = 0, fail = 0;
const say = (line) => {
  console.log(line);
  if (LOG) { try { fs.appendFileSync(LOG, `${line}\n`); } catch { /* best effort */ } }
};
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; say(`  ok   ${name}`); }
  else { fail++; say(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { say('No browser found; this suite needs one.'); process.exit(2); }

const PORT = 9200 + Math.floor(Math.random() * 700);
const profile = path.join(os.tmpdir(), `cp-wheel-${process.pid}`);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900',
  '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Chrome, the child process and the socket all keep the event loop alive; leave nothing behind. */
const done = (code) => {
  try { sock?.close(); } catch { /* already gone */ }
  try { chrome.kill(); } catch { /* already gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* held */ }
  process.exit(code);
};

let ws = null;
for (let i = 0; i < 80 && !ws; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) ws = (await r.json()).webSocketDebuggerUrl; }
  catch { /* not up yet */ }
  if (!ws) await sleep(250);
}
if (!ws) { say('no debugging endpoint'); done(2); }

const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' })).json();
if (!target?.webSocketDebuggerUrl) { say(`no page target: ${JSON.stringify(target).slice(0, 200)}`); done(2); }

let id = 0;
const waiters = new Map();
var sock = new WebSocket(target.webSocketDebuggerUrl);   // eslint-disable-line no-var
sock.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
});
// Bounded: an 'open' that never fires would leave this awaiting for ever with nothing printed.
const opened = await Promise.race([
  new Promise((r) => sock.addEventListener('open', () => r(true))),
  sleep(15000).then(() => false),
]);
if (!opened) { say('socket never opened'); done(2); }

// ⚠️ EVERY CALL TIMES OUT. A DevTools request that never comes back would hang the suite silently.
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id;
  const t = setTimeout(() => { waiters.delete(n); res({ timedOut: true }); }, 15000);
  waiters.set(n, (m) => { clearTimeout(t); res(m); });
  sock.send(JSON.stringify({ id: n, method, params }));
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const click = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  await sleep(260);
};
const wheel = async (x, y, dy, times = 1) => {
  for (let i = 0; i < times; i += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
    await sleep(70);
  }
  await sleep(380);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

let sawCanvas = false;
for (let i = 0; i < 40 && !sawCanvas; i += 1) {
  sawCanvas = await ev('!!document.querySelector("canvas")');
  if (!sawCanvas) await sleep(500);
}
if (!sawCanvas) { say('the page never rendered a chart'); done(2); }
await sleep(2500);
// The ticker page opens with the side docks out, which squeeze the chart; the chart is below the fold.
await ev('[...document.querySelectorAll("button")].filter(b => /close/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || "")).forEach(b => b.click())');
await sleep(500);
await ev('(() => { const c = [...document.querySelectorAll("canvas")].sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0]; c && c.scrollIntoView({ block: "center" }); })()');
await sleep(1600);

/** The time axis: its own short, wide canvas, which redraws only when the visible range moves. */
const axisOf = () => ev(`(() => {
  const axis = [...document.querySelectorAll('canvas')]
    .filter((c) => { const r = c.getBoundingClientRect(); return r.height > 8 && r.height < 48 && r.width > 200; })
    .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  if (!axis) return null;
  const r = axis.getBoundingClientRect();
  const cv = document.createElement('canvas');
  cv.width = Math.round(r.width); cv.height = Math.round(r.height);
  cv.getContext('2d').drawImage(axis, 0, 0);
  return cv.toDataURL().slice(-4000);
})()`);

const readMenu = () => ev(`(() => {
  const m = [...document.querySelectorAll('[role="menu"]')].find((x) => /1 ?m|5 ?m|1D|Day/i.test(x.innerText || ''));
  return m ? { top: m.scrollTop, max: m.scrollHeight - m.clientHeight, h: m.clientHeight } : null;
})()`);

say('\n1. the chart is interactive to begin with');
const plot = await ev(`(() => {
  const c = [...document.querySelectorAll('canvas')].filter((x) => x.getBoundingClientRect().height > 100)
    .sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0];
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width, h: r.height };
})()`);
ok('the chart canvas was found', !!plot, JSON.stringify(plot));
if (!plot) done(3);

// ⚠️ THE POSITIVE CONTROL. Without it, every "the chart did not move" assertion below would also pass
// against a chart that ignores the wheel entirely — which is the one outcome the brief rules out.
const axisStart = await axisOf();
await wheel(plot.left + plot.w * 0.5, plot.top + plot.h * 0.45, -240, 3);
const axisZoomed = await axisOf();
ok('⚠️ a wheel over the plot DOES move the chart', !!axisStart && axisStart !== axisZoomed,
  'without this, the checks below would pass against a chart that ignores the wheel');

say('\n2. open the timeframe menu');
const tfBtn = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /timeframe/i.test(x.getAttribute('title') || x.getAttribute('aria-label') || ''));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: (b.getAttribute('title') || '').trim() };
})()`);
ok('the timeframe control was found', !!tfBtn, JSON.stringify(tfBtn));
if (!tfBtn) done(3);
await click(tfBtn.x, tfBtn.y);
const menu = await ev(`(() => {
  const m = [...document.querySelectorAll('[role="menu"]')].find((x) => /1 ?m|5 ?m|1D|Day/i.test(x.innerText || ''));
  if (!m) return null;
  const r = m.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2,
    scrollH: m.scrollHeight, clientH: m.clientHeight,
    overscroll: getComputedStyle(m).overscrollBehaviorY };
})()`);
ok('⚠️ the timeframe menu opened', !!menu, JSON.stringify(menu));
if (!menu) done(3);
ok('⚠️ ...and it is long enough to scroll', menu.scrollH > menu.clientH + 2,
  `scrollHeight ${menu.scrollH} vs clientHeight ${menu.clientH} — a menu that fits cannot chain`);
ok('⚠️ ...and the browser sees the containment we declared', menu.overscroll === 'contain',
  `computed overscroll-behavior-y: ${menu.overscroll}`);

say('\n3. a wheel inside the menu belongs to the menu');
const axisBefore = await axisOf();
const pageBefore = await ev('window.scrollY');
const menuBefore = await readMenu();

// Down, far past the end of the list — which is where chaining starts.
await wheel(menu.x, menu.y, 120, 14);
const menuDown = await readMenu();
const axisDown = await axisOf();
ok('⚠️ the menu is still open after wheeling inside it', !!menuDown,
  'a menu that closes on its own wheel is the chaining symptom: the page scrolled, and every chart popover closes on a page scroll');
ok('⚠️ the menu itself scrolled down', !!menuDown && menuDown.top > menuBefore.top,
  `${menuBefore?.top} -> ${menuDown?.top}`);
ok('⚠️ ...and reached its end, so the overflow had somewhere to chain to',
  !!menuDown && menuDown.top >= menuDown.max - 1, `${menuDown?.top} of ${menuDown?.max}`);
ok('⚠️ THE CHART DID NOT MOVE while scrolling the menu down', axisBefore === axisDown,
  'the chart time axis changed, so the wheel reached the chart');
ok('⚠️ ...and the page did not scroll out from under it', (await ev('window.scrollY')) === pageBefore);

// And back up, past the top.
await wheel(menu.x, menu.y, -120, 14);
const menuUp = await readMenu();
ok('⚠️ the menu scrolled back up', !!menuUp && menuUp.top < menuDown.top, `${menuDown?.top} -> ${menuUp?.top}`);
ok('⚠️ ...to the top, so the overflow chained at that end too', !!menuUp && menuUp.top <= 1, `${menuUp?.top}`);
ok('⚠️ THE CHART STILL DID NOT MOVE while scrolling the menu up', axisBefore === (await axisOf()));
ok('⚠️ ...and the page still did not scroll', (await ev('window.scrollY')) === pageBefore);

// A trackpad sends many small deltas rather than a few large ones.
await wheel(menu.x, menu.y, 8, 30);
ok('⚠️ THE CHART DID NOT MOVE under trackpad-sized deltas either', axisBefore === (await axisOf()));
ok('⚠️ ...and the menu survived that too', !!(await readMenu()));

say('\n4. the menu still works, and the chart takes the wheel back');
const picked = await ev(`(() => {
  const m = [...document.querySelectorAll('[role="menu"]')].find((x) => /1 ?m|5 ?m|1D|Day/i.test(x.innerText || ''));
  if (!m) return null;
  const rows = [...m.querySelectorAll('button,[role="menuitem"],[role="menuitemradio"]')]
    .filter((b) => (b.textContent || '').trim().length > 0);
  const row = rows.find((b) => /^\s*(1W|1 W|Week)/i.test(b.textContent || '')) || rows[rows.length - 1];
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: row.textContent.trim().slice(0, 24) };
})()`);
ok('a timeframe row is reachable after all that wheeling', !!picked, JSON.stringify(picked));
if (picked) {
  await click(picked.x, picked.y);
  await sleep(2000);
  ok('⚠️ picking a timeframe still works', !(await ev(`!!document.querySelectorAll('[role="menu"]').length`)),
    'the menu should close on a pick');
}
await sleep(900);
const axisClosed = await axisOf();
await wheel(plot.left + plot.w * 0.5, plot.top + plot.h * 0.45, -240, 3);
ok('⚠️ the chart responds to the wheel again once the menu is closed',
  !!axisClosed && axisClosed !== (await axisOf()),
  'containment must be scoped to the overlay, not a global disable');

say(`\n${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
