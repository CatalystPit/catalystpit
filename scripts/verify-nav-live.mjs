// THE GLOBAL HEADER, ON THE DEPLOYED SITE, AT BOTH WIDTHS.
//
//   node scripts/verify-nav-live.mjs [origin]
//
// ⚠️ DESKTOP AND MOBILE ARE DIFFERENT RENDERS OF THE SAME ARRAY, and a removal that only lands on one
// of them is the failure this checks for. The bar shows `links.slice(0, visible)` with the rest folded
// into More; the phone menu shows `[...links, ...MENU_ONLY]` in full. So a name can hide from the row
// by overflowing and still be one tap away — which is not removed, it is just further down.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SITE = process.argv[2] || 'https://catalystpit.com';
const LOG = process.env.CP_NAV_LOG || '';
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
const profile = path.join(os.tmpdir(), `cp-nav-${process.pid}`);
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
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
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
  await sleep(500);
};
const go = async (p) => {
  await send('Page.navigate', { url: SITE + p });
  for (let i = 0; i < 60; i += 1) {
    if (await ev('!!document.querySelector("nav, header, .cp-topnav") && document.body.innerText.length > 50')) return true;
    await sleep(500);
  }
  return false;
};
await send('Runtime.enable');
await send('Page.enable');

const WANT = ['Terminal', 'Pit Consensus', 'Insiders', 'Politicians', 'Institutions', 'News', 'Screener'];

// ── desktop ────────────────────────────────────────────────────────────────────────────────────
say('\n1. the desktop header');
{
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  ok('the page rendered', await go('/insiders'));
  await sleep(1200);
  // ⚠️ THE DOCKS HAVE TO BE SHUT FIRST. The Tape and Pit docks inset #cp-shell by 330px each, so a
  // 1600px desktop behaves like a narrow one and the bar shows two links with the rest folded into
  // More. That is the overflow working, not a missing link — but it makes "the row is the seven" a
  // statement about the docks rather than about the nav.
  await ev('[...document.querySelectorAll("button")].filter(b => /close/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || "")).forEach(b => b.click())');
  await sleep(1200);
  const bar = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.cp-nav-links a')].map((a) => a.textContent.trim()))`) || '[]');
  ok('the nav row was read', bar.length >= 1, bar.join(' | '));
  ok('⚠️ Scan is not in the desktop row', !bar.some((t) => /^Scan$/i.test(t)), bar.join(' | '));
  ok('⚠️ the row leads with the first destinations, in order',
    bar.every((t, i) => t === WANT[i]), bar.join(' | '));

  // ⚠️ THE ROW ALONE DOES NOT ANSWER THE QUESTION, and this is the assertion that matters. A name that
  // overflows is still one tap away in More — so what must be checked is the WHOLE navigation: the row
  // plus the menu. It is also the only dock-independent check: how many links fit the bar depends on
  // whether the Tape and Pit docks happen to be open, which is a layout fact, not a navigation one.
  const more = await ev(`(() => {
    const b = [...document.querySelectorAll('.cp-nav-links button, .cp-nav-links [role="button"], .cp-nav-links span')]
      .find((x) => /^more/i.test((x.textContent || '').trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  ok('the More control was found', !!more);
  let menu = [];
  if (more) {
    await click(more.x, more.y);
    menu = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('a')]
      .map((a) => a.textContent.trim())
      .filter((t) => t && t.length < 24))`) || '[]');
  }
  const whole = [...new Set([...bar, ...menu])];
  ok('⚠️ Scan is nowhere in the desktop navigation — row or menu',
    !whole.some((t) => /^Scan$/i.test(t)), whole.join(' | '));
  ok('⚠️ ...while all seven destinations are reachable',
    WANT.every((w) => whole.includes(w)), `missing: ${WANT.filter((w) => !whole.includes(w)).join(', ')}`);
  ok('⚠️ Pit Consensus is still one of them', whole.includes('Pit Consensus'));
}

// ── mobile ─────────────────────────────────────────────────────────────────────────────────────
say('\n2. the mobile menu');
{
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  ok('the page rendered at phone width', await go('/insiders'));

  await sleep(1400);
  const burger = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /cp-mobile-menu/.test(x.getAttribute('aria-controls') || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  ok('the hamburger was found', !!burger);
  if (burger) {
    await click(burger.x, burger.y);
    await sleep(600);
    const items = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#cp-mobile-menu a')].map((a) => a.textContent.trim()).filter(Boolean))`) || '[]');
    ok('the mobile menu opened', items.length >= 5, items.join(' | '));
    ok('⚠️ Scan is not in the mobile menu', !items.some((t) => /^Scan$/i.test(t)), items.join(' | '));
    ok('⚠️ ...and the seven are all there', WANT.every((w) => items.includes(w)), items.join(' | '));
    ok('⚠️ Pit Consensus is still there too', items.includes('Pit Consensus'));
  }
}

// ── the tool itself is untouched ───────────────────────────────────────────────────────────────
say('\n3. Pit Scan itself is untouched');
{
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${SITE}/scan` });
  await sleep(4000);
  const status = await ev('document.body.innerText.length');
  const text = await ev('document.body.innerText.slice(0, 400)');
  ok('⚠️ the /scan route still serves', (status || 0) > 200, `${status} chars`);
  ok('⚠️ ...and it is still Pit Scan', /scan/i.test(text || ''), (text || '').slice(0, 120).replace(/\s+/g, ' '));
  ok('⚠️ ...and it is not a 404', !/404|not found|page could not be found/i.test(text || ''),
    (text || '').slice(0, 120).replace(/\s+/g, ' '));
}

say(`\n${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
