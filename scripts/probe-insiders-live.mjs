// What does the Insiders table ACTUALLY do in a browser? Measure, do not theorise.
// Run: node scripts/probe-insiders-live.mjs [baseUrl]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] || 'https://catalystpit.com';
const PORT = 9334;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/cp-probe-profile`, 'about:blank'], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = tabs.find((x) => x.type === 'page');
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch { /* wait */ }
    await sleep(250);
  }
  throw new Error('no debugging target');
}
const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id; pending.set(n, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
await send('Page.enable'); await send('Runtime.enable');

const PROBE = `(() => {
  const table = [...document.querySelectorAll('table')].find(t =>
    [...t.querySelectorAll('thead th')].some(th => th.textContent.trim().startsWith('VALUE')));
  if (!table) return { ready: false, body: document.body.innerText.slice(0, 200) };
  const scroller = table.parentElement;
  const card = scroller.parentElement;
  const ths = [...table.querySelectorAll('thead th')];
  const vi = ths.findIndex(th => th.textContent.trim().startsWith('VALUE'));
  scroller.scrollLeft = 0;
  const box = scroller.getBoundingClientRect();
  const v = ths[vi].getBoundingClientRect();
  const docks = [...document.querySelectorAll('div')].filter(d => {
    const s = getComputedStyle(d);
    return s.position === 'fixed' && parseFloat(s.zIndex) >= 60 && d.getBoundingClientRect().width > 100;
  }).map(d => Math.round(d.getBoundingClientRect().left) + '..' + Math.round(d.getBoundingClientRect().right));
  return {
    ready: true,
    viewportW: window.innerWidth, viewportH: window.innerHeight,
    shellW: Math.round(document.getElementById('cp-shell').getBoundingClientRect().width),
    cssTape: getComputedStyle(document.documentElement).getPropertyValue('--cp-tape'),
    cssPit: getComputedStyle(document.documentElement).getPropertyValue('--cp-pit'),
    cssWatch: getComputedStyle(document.documentElement).getPropertyValue('--cp-watch'),
    docks,
    boxW: Math.round(scroller.clientWidth), scrollW: Math.round(scroller.scrollWidth),
    tableW: Math.round(table.getBoundingClientRect().width),
    // How tall is the scrolling element, and where does its bottom edge (where a horizontal
    // scrollbar would live) sit relative to the window?
    scrollerH: Math.round(scroller.offsetHeight),
    scrollbarPx: scroller.offsetHeight - scroller.clientHeight,
    boxBottomVsViewport: Math.round(box.bottom - window.innerHeight),
    cardH: Math.round(card.getBoundingClientRect().height),
    pageH: Math.round(document.documentElement.scrollHeight),
    // At the position the user actually lands in, is VALUE on screen at all?
    valueVisibleAtRest: v.left >= box.left && v.right <= box.right,
    valueLeftInBox: Math.round(v.left - box.left),
    rows: table.querySelectorAll('tbody tr').length,
    overflowX: getComputedStyle(scroller).overflowX,
  };
})()`;

const setVp = (w, h = 900) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
const click = (label) => ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'')===${JSON.stringify(label)}); if(!b) return 'absent'; b.click(); return 'clicked'; })()`);
const buttons = () => ev(`[...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')).filter(Boolean).join(' | ')`);

try {
  await setVp(1512);
  await send('Page.navigate', { url: `${BASE}/insiders` });
  let m;
  for (let i = 0; i < 60; i++) { await sleep(500); m = await ev(PROBE).catch(() => ({ ready: false })); if (m?.ready) break; }
  console.log('\n-- as loaded, 1512x900 --');
  console.log(JSON.stringify(m, null, 1));
  console.log('\ndock buttons present:', await buttons());

  // Close every dock we can, to reach the state the user calls "correct".
  for (const l of ['Collapse the Tape', 'Collapse The Pit', 'Collapse watchlist']) {
    const r = await click(l); if (r === 'clicked') await sleep(500);
  }
  console.log('\n-- all docks collapsed --');
  console.log(JSON.stringify(await ev(PROBE), null, 1));

  await click('Open The Pit'); await sleep(600);
  console.log('\n-- The Pit reopened --');
  console.log(JSON.stringify(await ev(PROBE), null, 1));
} finally { ws.close(); chrome.kill(); }
