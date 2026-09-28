// A SCREENSHOT OF THE LIVE PALETTE, FROM THE DEPLOYED SITE.
//
//   node scripts/shoot-production-picker.mjs [url]
//
// Drives the installed Chrome over the DevTools protocol: opens the production ticker page, draws a
// horizontal line, selects it, opens the colour square and photographs the result. The point is the
// right-hand edge of the palette — the purple column and the gap beside it — which is a thing to look
// at rather than a number to assert.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'https://catalystpit.com/ticker/AAPL';
const OUT = path.join(process.cwd(), 'node_modules', '.cache', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('no browser found'); process.exit(2); }

const PORT = 9555 + (process.pid % 300);
const profile = path.join(os.tmpdir(), `cp-shot-${process.pid}`);
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
await new Promise((res) => sock.addEventListener('open', res));
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id; waiters.set(n, res); sock.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const click = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  await sleep(180);
};
const shoot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (!r.result?.data) return null;
  const f = path.join(OUT, name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  console.log('  wrote', f);
  return f;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// Wait for the chart canvas to exist.
let ready = false;
for (let i = 0; i < 60 && !ready; i += 1) {
  ready = await evaluate('!!document.querySelector("canvas")');
  if (!ready) await sleep(500);
}
console.log('chart canvas present:', ready);

// The ticker page opens with the Tape and Pit docks out, which squeeze the chart, and the chart
// itself sits well below the fold. Close them and scroll to it before looking for the drawing rail.
await evaluate('[...document.querySelectorAll(String.fromCharCode(98,117,116,116,111,110))].filter(b => /close/i.test(b.getAttribute(String.fromCharCode(97,114,105,97,45,108,97,98,101,108)) || b.getAttribute(String.fromCharCode(116,105,116,108,101)) || String.fromCharCode())).forEach(b => b.click())');
await sleep(700);
const scrolled = await evaluate('(() => { const c = [...document.querySelectorAll(String.fromCharCode(99,97,110,118,97,115))].sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0]; if (!c) return null; c.scrollIntoView({ block: String.fromCharCode(99,101,110,116,101,114) }); const r = c.getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top }; })()');
console.log('largest canvas after scroll:', JSON.stringify(scrolled));
await sleep(1800);
await shoot('production-chart-area.png');
await sleep(2500);

// The rail's line tool is "Lines - Trend line"; a trend line takes two clicks, which is the shortest
// path to a selected drawing and therefore to the floating toolbar that owns the colour square.
const tool = await evaluate('(() => { const b = [...document.querySelectorAll("button")].find((x) => /Lines . Trend line/.test(x.getAttribute("title") || "")); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
console.log('lines tool:', JSON.stringify(tool));
if (!tool) { await shoot('production-no-tool.png'); sock.close(); chrome.kill(); process.exit(3); }
await click(tool.x, tool.y);

const plot = await evaluate('(() => { const c = [...document.querySelectorAll("canvas")].sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0]; const r = c.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; })()');
console.log('plot:', JSON.stringify(plot));
await click(plot.left + plot.w * 0.30, plot.top + plot.h * 0.30);
await sleep(400);
await click(plot.left + plot.w * 0.62, plot.top + plot.h * 0.55);
await sleep(900);
await shoot('production-drawn.png');
// If it did not auto-select, click the middle of the line to select it.
let hasToolbar = await evaluate('!!document.querySelector(String.fromCharCode(91) + "role=" + String.fromCharCode(34) + "toolbar" + String.fromCharCode(34) + String.fromCharCode(93))');
if (!hasToolbar) {
  await click(plot.left + plot.w * 0.46, plot.top + plot.h * 0.425);
  await sleep(700);
  hasToolbar = await evaluate('!!document.querySelector(String.fromCharCode(91) + "role=" + String.fromCharCode(34) + "toolbar" + String.fromCharCode(34) + String.fromCharCode(93))');
}
console.log('drawing toolbar present:', hasToolbar);

const colour = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === 'Color');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
console.log('colour square:', JSON.stringify(colour));
if (!colour) {
  await shoot('production-no-toolbar.png');
  console.log('the drawing toolbar did not appear; screenshot written for inspection');
  sock.close(); chrome.kill(); process.exit(3);
}
await click(colour.x, colour.y);
await sleep(500);

// Measure the live palette, then photograph it.
const m = await evaluate(`(() => {
  const p = document.querySelector('[data-cp-palette]');
  if (!p) return { error: 'no palette in the live page' };
  const clip = p.closest('[role="menu"]') || p;
  const cs = getComputedStyle(clip), cb = clip.getBoundingClientRect();
  const inner = {
    left: cb.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
    right: cb.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
  };
  const rows = [...p.querySelectorAll('div')].filter((d) => d.children.length === 9);
  const first = rows[0] ? rows[0].children[0].getBoundingClientRect() : null;
  const last = rows[0] ? rows[0].children[8].getBoundingClientRect() : null;
  return {
    popover: { w: cb.width, h: cb.height },
    swatch: first ? first.width : null,
    leftGap: first ? first.left - inner.left : null,
    rightGap: last ? inner.right - last.right : null,
    rows: rows.length,
    swatches: [...p.querySelectorAll('button')].length,
    box: { left: cb.left, top: cb.top, w: cb.width, h: cb.height },
  };
})()`);
console.log('\nLIVE PALETTE MEASURED ON PRODUCTION:');
console.log(JSON.stringify(m, null, 2));

await shoot('production-palette-full.png');
if (m && m.box) {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, m.box.left - 30), y: Math.max(0, m.box.top - 30), width: m.box.w + 60, height: m.box.h + 60, scale: 2 },
  });
  if (r.result?.data) {
    const f = path.join(OUT, 'production-palette-closeup.png');
    fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
    console.log('  wrote', f);
  }
}

sock.close();
chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* held */ }
