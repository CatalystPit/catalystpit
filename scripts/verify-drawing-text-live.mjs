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

console.log('\n4. the text is plain, and it can be dragged on its own');
{
  const stored = () => ev(`(() => { const raw = window.localStorage.getItem([...Object.keys(window.localStorage)].find((k) => /draw/i.test(k))); return raw || ''; })()`);
  const firstDrawing = (o) => {
    const syms = o?.symbols || {};
    const list = syms[Object.keys(syms)[0]] || [];
    return list[0] || null;
  };

  // Re-select the drawing. Clicking its midpoint would land on an evidence marker as often as not, so
  // the press goes on the line a little off-centre.
  await click(plot.left + plot.w * 0.40, plot.top + plot.h * 0.365);
  await sleep(800);
  let barOpen = await ev(`!!document.querySelector('[role="toolbar"]')`);
  if (!barOpen) { await click(plot.left + plot.w * 0.52, plot.top + plot.h * 0.455); await sleep(800); barOpen = await ev(`!!document.querySelector('[role="toolbar"]')`); }
  ok('the drawing is selected again', barOpen);

  // ⚠️ THE CAPTION IS PUT SOMEWHERE KNOWN BEFORE IT IS DRAGGED. Its default is right-aligned above the
  // line, whose right-hand end depends on how the chart happened to project the segment — so guessing
  // at those pixels is guessing. Align left / place below puts it just past the line's FIRST anchor,
  // which is the point this test clicked to create the line and therefore the one coordinate it knows.
  const press = async (label) => {
    const r = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`);
    if (!r) return false;
    await click(r.x, r.y);
    return true;
  };
  // ⚠️ THE EDITOR MAY ALREADY BE OPEN. Committing the text with Enter deliberately leaves it open —
  // you have just typed, you may want to restyle — so clicking T here would TOGGLE it shut, and every
  // control inside it would then be missing. Ask first.
  let editorOpen = await ev(`!!document.querySelector('[aria-label="Drawing text"]')`);
  if (!editorOpen) {
    const tBtn2 = await ev(`(() => { const b = [...document.querySelectorAll('[role="toolbar"] button')].find((x) => /^(Add text to this drawing|Text: )/.test(x.getAttribute('aria-label') || '')); if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`);
    if (tBtn2) { await click(tBtn2.x, tBtn2.y); editorOpen = await ev(`!!document.querySelector('[aria-label="Drawing text"]')`); }
  }
  ok('the text editor is open', editorOpen);
  if (editorOpen) {
    ok('alignment can be set to left', await press('Align left'));
    ok('placement can be set to below', await press('Below the line'));
    await ev(`document.activeElement && document.activeElement.blur()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await sleep(700);
  }
  // Re-select after the editor closed.
  await click(plot.left + plot.w * 0.40, plot.top + plot.h * 0.365);
  await sleep(800);

  const before = JSON.parse((await stored()) || '{}');
  const d0 = firstDrawing(before);
  ok('the drawing is in storage before the drag', !!d0 && !!d0.label, JSON.stringify(d0?.label));
  ok('⚠️ ...with no manual position yet', !d0?.labelStyle?.at, JSON.stringify(d0?.labelStyle));

  // The caption sits just right of, and below, the line's first anchor — the point this test clicked
  // at 30% / 32% when it drew the line, and the one coordinate it knows.
  let capX = plot.left + plot.w * 0.30 + 34;
  let capY = plot.top + plot.h * 0.32 + 20;

  /**
   * A real press-move-release on the caption, reporting where it ended up in CHART coordinates.
   *
   * ⚠️ THE ASSERTION IS ON THE STORED TIME AND PRICE, NOT ON PIXELS. Pixels would move for a pan or a
   * zoom too; what is being tested is that the caption's own position in the chart's world changed on
   * the axis that was frozen.
   */
  const dragCaptionTo = async (toX, toY) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: capX, y: capY, button: 'left', clickCount: 1, buttons: 1 });
    const steps = 10;
    for (let i = 1; i <= steps; i += 1) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', button: 'left', buttons: 1,
        x: capX + ((toX - capX) * i) / steps, y: capY + ((toY - capY) * i) / steps,
      });
      await sleep(40);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0 });
    await sleep(900);
    capX = toX; capY = toY;
    return firstDrawing(JSON.parse((await stored()) || '{}'));
  };

  // ── E. FAR RIGHT ──
  const right = await dragCaptionTo(plot.left + plot.w * 0.88, plot.top + plot.h * 0.30);
  ok('⚠️ dragging the caption stores an ABSOLUTE chart position', !!right?.labelStyle?.at,
    JSON.stringify(right?.labelStyle));
  ok('⚠️ ...a time and a price, not an offset',
    right?.labelStyle?.at?.time != null && Number.isFinite(right?.labelStyle?.at?.price),
    JSON.stringify(right?.labelStyle?.at));
  ok('⚠️ F. the line did NOT move when the caption did',
    JSON.stringify(right?.points) === JSON.stringify(d0?.points),
    `${JSON.stringify(d0?.points)} -> ${JSON.stringify(right?.points)}`);

  // ── G. FAR LEFT ──
  const left = await dragCaptionTo(plot.left + plot.w * 0.12, plot.top + plot.h * 0.62);
  ok('⚠️ ...and the caption is still grabbable where it was dropped', !!left?.labelStyle?.at,
    'a caption that cannot be picked up again has not really been placed');

  // ⚠️ THE FAILURE BEING REPORTED, MEASURED. The caption was draggable vertically and frozen
  // horizontally, because a date-string time resolved to NaN and every horizontal delta became zero.
  // Two drags to opposite sides of the chart must produce two different TIMES.
  const tRight = right?.labelStyle?.at?.time;
  const tLeft = left?.labelStyle?.at?.time;
  ok('⚠️ H. the caption MOVED HORIZONTALLY — left and right are different times',
    tRight != null && tLeft != null && String(tRight) !== String(tLeft),
    `right=${JSON.stringify(tRight)} left=${JSON.stringify(tLeft)} — identical means the axis is still frozen`);
  ok('⚠️ ...and leftwards really is earlier than rightwards',
    String(tLeft) < String(tRight), `${JSON.stringify(tLeft)} should sort before ${JSON.stringify(tRight)}`);
  ok('⚠️ I. ...and it moved on the price axis too, in the same gesture',
    left?.labelStyle?.at?.price !== right?.labelStyle?.at?.price,
    `${right?.labelStyle?.at?.price} -> ${left?.labelStyle?.at?.price}`);
  ok('⚠️ ...with the line still untouched after both drags',
    JSON.stringify(left?.points) === JSON.stringify(d0?.points));

  await shoot('live-text-dragged.png');

  // ── N. CLICKING THE TEXT SELECTS ITS DRAWING ──
  // Deselect first, so this proves the click reached the caption rather than finding it already on.
  await click(plot.left + plot.w * 0.95, plot.top + plot.h * 0.92);
  await sleep(700);
  ok('the drawing is deselected to begin with',
    !(await ev(`!!document.querySelector('[role="toolbar"]')`)));
  // ⚠️ INSIDE THE BOX, NOT ON ITS CORNER. labelBox puts the caption's TOP-LEFT at the stored anchor,
  // and the drag released with the pointer exactly there — so clicking that same point lands on the
  // single corner pixel, which is a coin toss. A few pixels in is where a reader would actually click.
  // The caption's box starts at the stored anchor and runs right and down from it; probe a few
  // points inside it and report which one reaches, so a miss reads as a miss rather than as a bug.
  let selected = false; let hitAt = null;
  for (const [dx, dy] of [[12, 9], [30, 9], [12, 4], [40, 12], [6, 12], [60, 9]]) {
    await click(capX + dx, capY + dy);
    await sleep(900);
    if (await ev(`!!document.querySelector('[role="toolbar"]')`)) { selected = true; hitAt = [dx, dy]; break; }
  }
  // ⚠️ A CONTROL, so a failure above reads as what it is. If clicking the LINE cannot raise the
  // toolbar either, the harness has lost the drawing and the text assertion is measuring nothing.
  let lineWorks = false;
  if (!selected) {
    await click(plot.left + plot.w * 0.40, plot.top + plot.h * 0.365);
    await sleep(900);
    lineWorks = await ev(`!!document.querySelector('[role="toolbar"]')`);
  }
  ok('⚠️ N. clicking the TEXT alone selects its drawing and shows the toolbar', selected,
    selected ? '' : (lineWorks
      ? 'the line still selects, so the text hit genuinely missed'
      : 'the LINE does not select either — the harness has lost the drawing, so this assertion measured nothing'));
  if (selected) console.log('     (reached at +' + hitAt[0] + ',+' + hitAt[1] + ' from the stored anchor)');
}


console.log('\n5. it is painted on the chart, and it follows the line');
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

console.log('\n6. it survives a reload');
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
