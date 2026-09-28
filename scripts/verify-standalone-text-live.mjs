// THE STANDALONE TEXT TOOL, ON THE DEPLOYED SITE.
//
//   node scripts/verify-standalone-text-live.mjs [url]
//
// ⚠️ A DIFFERENT THING FROM DRAWING-ATTACHED TEXT, AND DELIBERATELY TESTED APART FROM IT. A caption
// belongs to a line and is positioned beside it; a note IS its own annotation and its anchor is its
// position. They share rendering, the editor and the hit-test utility, and nothing else — so a suite
// that covered both together could pass while one of them was unreachable.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'https://catalystpit.com/ticker/NVDA';
const SHOTS = path.join(process.cwd(), 'node_modules', '.cache', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const LOG = process.env.CP_TEXT_LOG || '';
let pass = 0, fail = 0;
const say = (l) => { console.log(l); if (LOG) { try { fs.appendFileSync(LOG, `${l}\n`); } catch { /* best effort */ } } };
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; say(`  ok   ${name}`); } else { fail++; say(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { say('No browser found.'); process.exit(2); }

const PORT = 9200 + Math.floor(Math.random() * 700);
const profile = path.join(os.tmpdir(), `cp-note-${process.pid}`);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900',
  '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sock = null;
const done = (code) => {
  try { sock?.close(); } catch { /* gone */ }
  try { chrome.kill(); } catch { /* gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* held */ }
  process.exit(code);
};

let ws = null;
for (let i = 0; i < 80 && !ws; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) ws = (await r.json()).webSocketDebuggerUrl; }
  catch { /* not up */ }
  if (!ws) await sleep(250);
}
if (!ws) { say('no debugging endpoint'); done(2); }
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' })).json();
if (!target?.webSocketDebuggerUrl) { say('no page target'); done(2); }

let id = 0;
const waiters = new Map();
sock = new WebSocket(target.webSocketDebuggerUrl);
sock.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
});
const opened = await Promise.race([
  new Promise((r) => sock.addEventListener('open', () => r(true))), sleep(15000).then(() => false),
]);
if (!opened) { say('socket never opened'); done(2); }
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id;
  const t = setTimeout(() => { waiters.delete(n); res({ timedOut: true }); }, 20000);
  waiters.set(n, (m) => { clearTimeout(t); res(m); });
  sock.send(JSON.stringify({ id: n, method, params }));
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const click = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  await sleep(300);
};
const type_ = async (text) => { for (const ch of text) await send('Input.dispatchKeyEvent', { type: 'char', text: ch }); await sleep(150); };
const shoot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.result.data, 'base64'));
};
const stored = () => ev(`(() => { const k = [...Object.keys(window.localStorage)].find((x) => /draw/i.test(x)); return k ? window.localStorage.getItem(k) : ''; })()`);
const notes = async () => {
  const raw = await stored();
  try {
    const o = JSON.parse(raw || '{}');
    const syms = o.symbols || {};
    return (syms[Object.keys(syms)[0]] || []).filter((d) => d.type === 'text');
  } catch { return []; }
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
for (let i = 0; i < 60; i += 1) { if (await ev('!!document.querySelector("canvas")')) break; await sleep(500); }
await sleep(2500);
await ev('[...document.querySelectorAll("button")].filter(b => /close/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || "")).forEach(b => b.click())');
await sleep(600);
await ev('(() => { const c = [...document.querySelectorAll("canvas")].sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0]; c && c.scrollIntoView({ block: "center" }); })()');
await sleep(1600);
// Start clean: a previous run's notes would make "it was created" true before anything is clicked.
await ev(`(() => { const k = [...Object.keys(window.localStorage)].find((x) => /draw/i.test(x)); if (k) window.localStorage.removeItem(k); })()`);
await send('Page.navigate', { url: URL_ });
await sleep(1000);
for (let i = 0; i < 60; i += 1) { if (await ev('!!document.querySelector("canvas")')) break; await sleep(500); }
await sleep(3000);
await ev('[...document.querySelectorAll("button")].filter(b => /close/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || "")).forEach(b => b.click())');
await sleep(600);
await ev('(() => { const c = [...document.querySelectorAll("canvas")].sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0]; c && c.scrollIntoView({ block: "center" }); })()');
await sleep(1600);

const plot = await ev(`(() => {
  const c = [...document.querySelectorAll('canvas')].filter((x) => x.getBoundingClientRect().height > 100)
    .sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0];
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width, h: r.height };
})()`);

say('\nA-E. place a standalone note');
ok('the chart rendered', !!plot, JSON.stringify(plot));
if (!plot) done(3);
ok('no notes to begin with', (await notes()).length === 0);

const tool = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /Text & notes/i.test(x.getAttribute('title') || ''));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, title: b.getAttribute('title') };
})()`);
ok('B. the T tool is in the left rail', !!tool, JSON.stringify(tool));
if (!tool) { await shoot('live-note-no-tool.png'); done(3); }
await click(tool.x, tool.y);
await sleep(500);

// C. click an empty area near the upper-left of the plot.
const spotX = plot.left + plot.w * 0.22;
const spotY = plot.top + plot.h * 0.20;
await click(spotX, spotY);
await sleep(800);
const editor = await ev(`!!document.querySelector('[aria-label="Note text"], input[placeholder="Note…"]')`);
ok('C-D. clicking the chart opens the note editor', editor);
if (editor) {
  await ev(`(() => { const i = document.querySelector('[aria-label="Note text"], input[placeholder="Note…"]'); i && i.focus(); })()`);
  await type_('TEST ONE');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
  await sleep(1200);
}
const made = await notes();
ok('⚠️ E. the note was created', made.length === 1, `${made.length} notes`);
ok('⚠️ ...with the text that was typed', made[0]?.text === 'TEST ONE', JSON.stringify(made[0]?.text));
ok('⚠️ ...at its own chart coordinates', made[0]?.points?.[0]?.time != null
  && Number.isFinite(Number(made[0]?.points?.[0]?.price)), JSON.stringify(made[0]?.points));
await shoot('live-note-placed.png');

say('\nF-J. click the words, then drag them');
// Deselect so the click has to reach the note on its own.
await click(plot.left + plot.w * 0.92, plot.top + plot.h * 0.90);
await sleep(700);
ok('the note is deselected to begin with', !(await ev(`!!document.querySelector('[role="toolbar"]')`)));

// The words are drawn to the RIGHT of the anchor the click placed.
let wordsX = spotX + 26;
let wordsY = spotY;
await click(wordsX, wordsY);
await sleep(900);
ok('⚠️ F. clicking the WORDS selects the note', await ev(`!!document.querySelector('[role="toolbar"]')`),
  'the anchor dot was never clicked in this step');

const before = (await notes())[0];
const dragTo = async (toX, toY) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: wordsX, y: wordsY, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 10; i += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1,
      x: wordsX + ((toX - wordsX) * i) / 10, y: wordsY + ((toY - wordsY) * i) / 10,
    });
    await sleep(40);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0 });
  await sleep(900);
  wordsX = toX; wordsY = toY;
  return (await notes())[0];
};

const right = await dragTo(plot.left + plot.w * 0.78, plot.top + plot.h * 0.22);
ok('⚠️ G. dragging the words moves the note RIGHT',
  right?.points?.[0]?.time !== before?.points?.[0]?.time,
  `${JSON.stringify(before?.points?.[0])} -> ${JSON.stringify(right?.points?.[0])}`);
// ⚠️ AND THIS SECOND DRAG PRESSES WHERE THE FIRST ONE DROPPED IT, which is the only reason the note
// has to STILL BE THERE — painted where its stored time and price say, not merely stored correctly.
// A drag lands the note on whatever day the pixel falls on, weekends included, and a weekend has no
// bar; when that projection was wrong the note was stored right and drawn at the chart's left edge,
// so this press found empty chart, panned it, and nothing moved.
const down = await dragTo(plot.left + plot.w * 0.55, plot.top + plot.h * 0.72);
ok('⚠️ H-I. ...and DOWN and diagonally, on both axes',
  down?.points?.[0]?.price !== right?.points?.[0]?.price
  && down?.points?.[0]?.time !== right?.points?.[0]?.time,
  `${JSON.stringify(right?.points?.[0])} -> ${JSON.stringify(down?.points?.[0])}`);
ok('⚠️ ...and the text is unchanged throughout', down?.text === 'TEST ONE');
await shoot('live-note-dragged.png');

say('\nK-O. pan, zoom, reload');
const placed = JSON.stringify(down?.points?.[0]);
// J/K: a pan must not be swallowed, and must not move the note's chart coordinates.
const y = plot.top + plot.h * 0.5;
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: plot.left + plot.w * 0.75, y, button: 'left', clickCount: 1, buttons: 1 });
for (let i = 1; i <= 10; i += 1) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: plot.left + plot.w * (0.75 - 0.03 * i), y, button: 'left', buttons: 1 });
  await sleep(35);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: plot.left + plot.w * 0.45, y, button: 'left', buttons: 0 });
await sleep(1000);
ok('⚠️ K-M. panning the chart leaves the note at the same chart coordinates',
  JSON.stringify((await notes())[0]?.points?.[0]) === placed,
  `${placed} -> ${JSON.stringify((await notes())[0]?.points?.[0])}`);

await send('Page.navigate', { url: URL_ });
await sleep(1200);
for (let i = 0; i < 60; i += 1) { if (await ev('!!document.querySelector("canvas")')) break; await sleep(500); }
await sleep(3000);
const after = (await notes())[0];
ok('⚠️ N-O. the note survives a reload', !!after && after.text === 'TEST ONE', JSON.stringify(after?.text));
ok('⚠️ ...at the position it was dragged to', JSON.stringify(after?.points?.[0]) === placed,
  `${placed} -> ${JSON.stringify(after?.points?.[0])}`);
await shoot('live-note-reloaded.png');

say(`\n${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
