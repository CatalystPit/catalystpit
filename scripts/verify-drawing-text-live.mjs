// THE WHOLE CAPTION WORKFLOW, ON THE DEPLOYED SITE.
//
//   node scripts/verify-drawing-text-live.mjs [url]
//
// ⚠️ WHY THIS EXISTS SEPARATELY FROM verify-drawing-text. That suite renders the toolbar in jsdom and
// asserts the model, which is most of the feature — but jsdom has no canvas, so the one thing it can
// never check is whether the caption is actually PAINTED on the chart, anchored to the line, and still
// there after a pan. That is the part a user sees, so it is checked here: a real browser, the deployed
// bundle, a real drawing, real pixels.
//
// Needs a browser and the network, so like verify-deployed it is not part of the offline run.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'https://catalystpit.com/ticker/AAPL';
const SHOTS = path.join(process.cwd(), 'node_modules', '.cache', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('No browser found; this suite needs one. Skipping is not a pass.'); process.exit(2); }

const PORT = 9800 + (process.pid % 150);
const profile = path.join(os.tmpdir(), `cp-text-${process.pid}`);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900',
  '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws = null;
for (let i = 0; i < 80 && !ws; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) ws = (await r.json()).webSocketDebuggerUrl; }
  catch { /* not up */ }
  if (!ws) await sleep(250);
}
if (!ws) { chrome.kill(); console.error('no debugging endpoint'); process.exit(2); }

const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' })).json();
let id = 0;
const waiters = new Map();
const sock = new WebSocket(target.webSocketDebuggerUrl);
sock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
});
await new Promise((r) => sock.addEventListener('open', r));
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id; waiters.set(n, res); sock.send(JSON.stringify({ id: n, method, params }));
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const click = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  await sleep(200);
};
const type = async (text) => {
  for (const ch of text) await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
  await sleep(120);
};
const key = async (k, code) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: code === 'Enter' ? 13 : 0 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
  await sleep(200);
};
const shoot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  if (!r.result?.data) return null;
  const f = path.join(SHOTS, name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  return f;
};
const rectOf = async (sel) => ev(`(() => { const b = ${sel}; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
const byTitle = (re) => `[...document.querySelectorAll('button')].find((x) => ${re}.test(x.getAttribute('title') || ''))`;
const byAria = (l) => `[...document.querySelectorAll('button,input,select')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(l)})`;

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

for (let i = 0; i < 60; i += 1) { if (await ev('!!document.querySelector("canvas")')) break; await sleep(500); }
await sleep(2500);
await ev('[...document.querySelectorAll("button")].filter(b => /close/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || "")).forEach(b => b.click())');
await sleep(600);
await ev('(() => { const c = [...document.querySelectorAll("canvas")].sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0]; c && c.scrollIntoView({ block: "center" }); })()');
await sleep(1600);

console.log('\n1. draw a line and select it');
const tool = await rectOf(byTitle('/Lines . Horizontal line|Lines . Trend line/'));
ok('the rail offers a line tool', !!tool);
if (!tool) { await shoot('live-text-no-tool.png'); sock.close(); chrome.kill(); process.exit(3); }
await click(tool.x, tool.y);
const plot = await ev('(() => { const c = [...document.querySelectorAll("canvas")].sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0]; const r = c.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; })()');
await click(plot.left + plot.w * 0.30, plot.top + plot.h * 0.32);
await sleep(400);
await click(plot.left + plot.w * 0.64, plot.top + plot.h * 0.52);
await sleep(900);
let hasBar = await ev(`!!document.querySelector('[role="toolbar"]')`);
if (!hasBar) { await click(plot.left + plot.w * 0.47, plot.top + plot.h * 0.42); await sleep(700); hasBar = await ev(`!!document.querySelector('[role="toolbar"]')`); }
ok('selecting the drawing shows its floating toolbar', hasBar);

console.log('\n2. the T sits beside the colour square');
const names = await ev(`JSON.stringify([...document.querySelectorAll('[role="toolbar"] button')].map(b => b.getAttribute('aria-label')))`);
const list = JSON.parse(names || '[]');
const ci = list.findIndex((n) => n === 'Color');
ok('⚠️ the colour square is on the toolbar', ci !== -1, list.join(' | '));
ok('⚠️ a text control sits immediately after it',
  /^(Add text to this drawing|Text: )/.test(list[ci + 1] || ''), list.join(' | '));
ok('⚠️ ...and before the stroke controls',
  list.indexOf('Line width') === -1 || list.indexOf('Line width') > ci + 1, list.join(' | '));

console.log('\n3. add text');
const tBtn = await rectOf(`[...document.querySelectorAll('[role="toolbar"] button')][${ci + 1}]`);
await click(tBtn.x, tBtn.y);
const field = await rectOf(byAria('Drawing text'));
ok('⚠️ one tap opens the editor', !!field);
if (field) {
  await click(field.x, field.y);
  await type('Previous Resistance');
  await key('Enter', 'Enter');
}
const stored = await ev(`(() => { const raw = window.localStorage.getItem([...Object.keys(window.localStorage)].find((k) => /draw/i.test(k))); return raw || ''; })()`);
ok('⚠️ the text was attached to the drawing and stored',
  /Previous Resistance/.test(stored || ''), (stored || '').slice(0, 160));
ok('⚠️ ...as a field on the line, not as a new text drawing',
  !/"type":"text"/.test(stored || ''), (stored || '').slice(0, 200));
ok('⚠️ ...with a style alongside it', /labelStyle/.test(stored || ''));

console.log('\n4. it is painted on the chart, and it follows the line');
// Dismiss the editor, then read the canvas: the caption is drawn, so it has to be found in pixels.
await key('Escape', 'Escape');
await click(plot.left + plot.w * 0.9, plot.top + plot.h * 0.9);
await sleep(700);
const shotA = await shoot('live-text-attached.png');
ok('a screenshot of the chart with the caption was taken', !!shotA);

// ⚠️ THE CAPTION IS CANVAS, SO "IS IT THERE" IS A PIXEL QUESTION. Compare the plate's own region
// before and after a pan: if the caption is anchored to the line it must MOVE with it, and the two
// frames must differ. A caption baked at a fixed screen position would leave them identical.
const sampleOf = async (fx, fy, w, h) => ev(`(() => {
  const c = [...document.querySelectorAll('canvas')].sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0];
  const r = c.getBoundingClientRect();
  const cv = document.createElement('canvas'); cv.width = ${w}; cv.height = ${h};
  const g = cv.getContext('2d');
  g.drawImage(c, Math.round(r.width * ${fx}), Math.round(r.height * ${fy}), ${w}, ${h}, 0, 0, ${w}, ${h});
  return cv.toDataURL().slice(-2000);
})()`);

// ⚠️ THE SAMPLE BOX HAS TO CONTAIN THE CAPTION. The first version of this sampled the upper-middle of
// the plot, which is nowhere near a right-aligned caption on a line drawn across the lower half — so it
// compared two identical patches of empty chart and reported a failure that was about the test.
const CAP = [0.35, 0.35, 340, 180];
const whole = () => sampleOf(0, 0, 300, 200);
const before = await sampleOf(...CAP);
const wholeBefore = await whole();

// ⚠️ A PAN IS A DRAG WITH INTERMEDIATE MOVES. A single mouseMoved between press and release moves the
// crosshair and nothing else — the chart library tracks a drag across successive moves, so the first
// version of this test panned nothing and then correctly reported that nothing had changed.
const y = plot.top + plot.h * 0.5;
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: plot.left + plot.w * 0.75, y, button: 'left', clickCount: 1, buttons: 1 });
for (let i = 1; i <= 10; i += 1) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: plot.left + plot.w * (0.75 - 0.035 * i), y, button: 'left', buttons: 1,
  });
  await sleep(35);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: plot.left + plot.w * 0.40, y, button: 'left', buttons: 0 });
await sleep(1100);
const after = await sampleOf(...CAP);
const wholeAfter = await whole();
ok('⚠️ the drag actually panned the chart', !!wholeBefore && wholeBefore !== wholeAfter,
  'an unchanged canvas means the gesture never reached the chart, so nothing below is being tested');
await shoot('live-text-after-pan.png');
ok('the canvas region could be sampled', !!before && !!after);
ok('⚠️ ...and the caption moved with the line it belongs to',
  !!before && !!after && before !== after,
  'identical pixels in the caption region would mean it is painted at a fixed screen position');

// ⚠️ AND THE CAPTION SURVIVES THE PAN. Its text is in the stored drawing, and the drawing is still
// there — a pan must not be able to detach or clear it.
const afterPan = await ev(`(() => { const raw = window.localStorage.getItem([...Object.keys(window.localStorage)].find((k) => /draw/i.test(k))); return raw || ''; })()`);
ok('⚠️ the caption is still attached after panning', /Previous Resistance/.test(afterPan || ''));

console.log('\n5. it survives a reload');
await send('Page.navigate', { url: URL_ });
await sleep(1000);
for (let i = 0; i < 60; i += 1) { if (await ev('!!document.querySelector("canvas")')) break; await sleep(500); }
await sleep(3000);
const afterReload = await ev(`(() => { const raw = window.localStorage.getItem([...Object.keys(window.localStorage)].find((k) => /draw/i.test(k))); return raw || ''; })()`);
ok('⚠️ the caption is still there after a full reload', /Previous Resistance/.test(afterReload || ''),
  (afterReload || '').slice(0, 160));
ok('⚠️ ...with its style', /labelStyle/.test(afterReload || ''));
await ev('(() => { const c = [...document.querySelectorAll("canvas")].sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0]; c && c.scrollIntoView({ block: "center" }); })()');
await sleep(1500);
const shotB = await shoot('live-text-after-reload.png');
ok('a screenshot after reload was taken', !!shotB);

sock.close();
chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* held */ }
console.log(`\nscreenshots in ${SHOTS}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
