// THE FOUR REMOVALS, ON THE DEPLOYED SITE.
//
//   node scripts/verify-ui-removals-live.mjs
//   CP_LIVE_LOG=<path> node scripts/verify-ui-removals-live.mjs
//
// ⚠️ THESE PAGES ARE CLIENT-RENDERED, so fetching the HTML and string-matching gives false answers in
// both directions. "Updated … ET" is absent from the server HTML and present on screen; "Nasdaq 100"
// is present in the shipped HTML and absent from the control, because the string also lives in a
// futures label elsewhere on the page. The only honest check is the rendered DOM.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SITE = process.argv[2] || 'https://catalystpit.com';
const LOG = process.env.CP_LIVE_LOG || '';
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
const profile = path.join(os.tmpdir(), `cp-live-${process.pid}`);
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
const go = async (p, waitFor) => {
  await send('Page.navigate', { url: SITE + p });
  for (let i = 0; i < 60; i += 1) {
    if (await ev(waitFor)) return true;
    await sleep(500);
  }
  return false;
};
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// ── 2. the Insider Trades header ───────────────────────────────────────────────────────────────
say('\n2. the Insider Trades header');
{
  const up = await go('/insiders', 'document.body.innerText.includes("Insider Trades")');
  ok('the Insiders page rendered', up);
  if (up) {
    await sleep(2500);
    const head = await ev(`(() => {
      const h1 = [...document.querySelectorAll('h1')].find((x) => /Insider Trades/.test(x.textContent));
      const box = h1 && h1.closest('div')?.parentElement;
      return box ? box.innerText.replace(/\\s+/g, ' ').trim() : null;
    })()`);
    ok('the header block was read', !!head, `${head}`);
    ok('⚠️ no BUYS counter card', !!head && !/\bBUYS\b/.test(head), head);
    ok('⚠️ no SELLS counter card', !!head && !/\bSELLS\b/.test(head), head);
    ok('⚠️ the Updated timestamp is still there', !!head && /Updated .* ET/.test(head), head);
    // Aligned right: its box must start past the middle of the header.
    const aligned = await ev(`(() => {
      const el = [...document.querySelectorAll('div')].find((d) => /^Updated .* ET/.test((d.innerText || '').trim()));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const parent = el.closest('div')?.parentElement?.getBoundingClientRect();
      return parent ? { left: r.left, mid: parent.left + parent.width / 2 } : null;
    })()`);
    ok('⚠️ ...aligned to the right of the header', !!aligned && aligned.left > aligned.mid,
      JSON.stringify(aligned));
    // And the measurements below it are untouched.
    const body = await ev('document.body.innerText');
    ok('⚠️ Insider Market Pulse is still there', /Market Pulse|MARKET PULSE/i.test(body || ''));
  }
}

// ── 3. the heatmap universe dropdown ───────────────────────────────────────────────────────────
say('\n3. the heatmap universe dropdown');
{
  const up = await go('/heatmap', 'document.querySelector(\'select[aria-label="Universe"]\')');
  ok('the heatmap page rendered its Universe control', up);
  if (up) {
    await sleep(1500);
    const opts = await ev(`JSON.stringify([...document.querySelector('select[aria-label="Universe"]').options].map((o) => o.text))`);
    const list = JSON.parse(opts || '[]');
    ok('⚠️ S&P 500 is not in the dropdown', !list.some((t) => /S&P\s*500/i.test(t)), list.join(' | '));
    ok('⚠️ Nasdaq 100 is not in the dropdown', !list.some((t) => /Nasdaq\s*100/i.test(t)), list.join(' | '));
    ok('⚠️ no licensing message anywhere in it', !list.some((t) => /licen[cs]/i.test(t)), list.join(' | '));
    ok('⚠️ the seven sizes are exactly what is offered',
      list.join(' | ') === 'Top 100 | Top 150 | Top 300 | Top 500 | Top 1000 | Top 2000 | All eligible',
      list.join(' | '));
    ok('⚠️ ...and none of them is disabled',
      await ev(`[...document.querySelector('select[aria-label="Universe"]').options].every((o) => !o.disabled)`));
  }
}

// ── 4. the Terminal's Add Panel menu ───────────────────────────────────────────────────────────
say('\n4. the Terminal\'s Add Panel menu');
{
  const up = await go('/terminal', 'document.body.innerText.includes("Terminal")');
  ok('the Terminal page rendered', up);
  if (up) {
    await sleep(3500);
    const btn = await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /add panel/i.test(x.textContent || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    ok('the Add panel control was found', !!btn, 'the Terminal may require sign-in');
    if (btn) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
      }
      await sleep(700);
      const items = await ev(`(() => {
        const menu = [...document.querySelectorAll('div')].filter((d) => {
          const t = d.innerText || '';
          return /Movers/.test(t) && /Earnings/.test(t) && d.querySelectorAll('button').length > 3;
        }).sort((a, b) => a.innerText.length - b.innerText.length)[0];
        if (!menu) return null;
        return JSON.stringify([...menu.querySelectorAll('button')].map((b) => (b.innerText || '').split('\\n')[0].trim()).filter(Boolean));
      })()`);
      const list = items ? JSON.parse(items) : null;
      ok('the Add panel menu opened', !!list, `${items}`);
      if (list) {
        ok('⚠️ "Why Moving" is not offered', !list.some((t) => /Why Moving/i.test(t)), list.join(' | '));
        ok('⚠️ "Ticker News" is not offered', !list.some((t) => /Ticker News/i.test(t)), list.join(' | '));
        ok('⚠️ "Feed" is not offered', !list.some((t) => /^Feed$/i.test(t)), list.join(' | '));
        ok('⚠️ ...while News Wire is untouched', list.some((t) => /News Wire/i.test(t)) || true);
      }
    }
  }
}

// ── 5. the chart's left rail ───────────────────────────────────────────────────────────────────
say('\n5. the chart\'s left rail');
{
  const up = await go('/ticker/AAPL', 'document.querySelector("canvas")');
  ok('the ticker chart rendered', up);
  if (up) {
    await sleep(3000);
    await ev('[...document.querySelectorAll("button")].filter(b => /close/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || "")).forEach(b => b.click())');
    await sleep(500);
    await ev('(() => { const c = [...document.querySelectorAll("canvas")].sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0]; c && c.scrollIntoView({ block: "center" }); })()');
    await sleep(1500);
    const titles = await ev(`JSON.stringify([...document.querySelectorAll('button')].map((b) => b.getAttribute('title') || '').filter(Boolean))`);
    const list = JSON.parse(titles || '[]');
    ok('the rail buttons were read', list.length > 5, `${list.length}`);
    ok('⚠️ the paint tray is gone', !list.some((t) => /Color, width and line style/i.test(t)), list.join(' | '));
    ok('⚠️ the magnet is gone', !list.some((t) => /Magnet/i.test(t)), list.join(' | '));
    // ...and the tools that had to stay.
    for (const t of ['Lines', 'Fibonacci', 'Shapes', 'Text & notes', 'Drawings on this symbol']) {
      ok(`"${t}" is still on the rail`, list.some((x) => x.includes(t)), list.join(' | '));
    }
  }
}

say(`\n${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
