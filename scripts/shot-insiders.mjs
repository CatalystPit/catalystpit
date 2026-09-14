// Screenshot the real Insiders page in the real dock configuration, so the result can be LOOKED at
// rather than inferred from widths.
//
//   node scripts/shot-insiders.mjs [baseUrl] [width] [height]
//
// Writes PNGs to the scratchpad and prints their paths plus the geometry of the VALUE column.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'https://catalystpit.com';
const W = Number(process.argv[3] || 1512);
const H = Number(process.argv[4] || 900);
const OUT = process.env.SHOT_DIR || `${process.env.TEMP}/cp-shots`;
mkdirSync(OUT, { recursive: true });
const PORT = 9341;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', '--force-device-scale-factor=1', `--user-data-dir=${process.env.TEMP}/cp-shot-profile`,
  'about:blank'], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 60; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page');
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl; } catch { /* wait */ }
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
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const click = (label) => ev(`(() => { const b=[...document.querySelectorAll('button')]
  .find(x=>(x.getAttribute('aria-label')||'')===${JSON.stringify(label)}); if(!b) return 'absent'; b.click(); return 'clicked'; })()`);

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const p = `${OUT}/${name}.png`;
  writeFileSync(p, Buffer.from(data, 'base64'));
  console.log('  wrote', p);
  return p;
}

// Where is VALUE, and is its text fully inside the visible scroll box?
const GEOM = `(() => {
  const table = [...document.querySelectorAll('table')].find(t =>
    [...t.querySelectorAll('thead th')].some(th => th.textContent.trim().startsWith('VALUE')));
  if (!table) return { ready: false };
  const scroller = table.parentElement;
  const ths = [...table.querySelectorAll('thead th')];
  const vi = ths.findIndex(th => th.textContent.trim().startsWith('VALUE'));
  const box = scroller.getBoundingClientRect();
  const rows = [...table.querySelectorAll('tbody tr')].slice(0, 12);
  const cells = rows.map(r => {
    const td = r.children[vi];
    if (!td) return null;
    const cr = td.getBoundingClientRect();
    return { text: td.textContent.trim(), left: Math.round(cr.left), right: Math.round(cr.right),
             clipped: cr.right > box.right + 0.5 || cr.left < box.left - 0.5 };
  }).filter(Boolean);
  const bar = document.querySelector('.cp-hbar');
  const br = bar && bar.getBoundingClientRect();
  return {
    ready: true,
    boxLeft: Math.round(box.left), boxRight: Math.round(box.right),
    boxW: Math.round(scroller.clientWidth), scrollW: Math.round(scroller.scrollWidth),
    scrollLeft: Math.round(scroller.scrollLeft),
    valueHeader: { left: Math.round(ths[vi].getBoundingClientRect().left), right: Math.round(ths[vi].getBoundingClientRect().right) },
    cells,
    clippedCells: cells.filter(c => c.clipped).map(c => c.text),
    bar: bar ? { top: Math.round(br.top), bottom: Math.round(br.bottom), h: Math.round(br.height),
                 inViewport: br.bottom <= window.innerHeight + 1 && br.top >= 0,
                 viewportH: window.innerHeight } : null,
    pageScrollY: Math.round(window.scrollY),
  };
})()`;

try {
  await send('Page.navigate', { url: `${BASE}/insiders` });
  for (let i = 0; i < 60; i++) { await sleep(500); const g = await ev(GEOM).catch(() => ({ ready: false })); if (g.ready) break; }

  // The user's configuration: Tape open on the left, a dock open on the right. DOCKS=closed checks
  // that the ordinary full-width layout is untouched.
  const want = process.env.DOCKS === 'closed'
    ? ['Collapse the Tape', 'Collapse The Pit', 'Collapse watchlist']
    : ['Open the Tape', 'Open The Pit', 'Open watchlist'];
  for (const l of want) { const r = await click(l); if (r === 'clicked') await sleep(500); }
  await sleep(900);

  // Bring the table area into view the way a trader scrolling down would.
  await ev(`(() => { const t=[...document.querySelectorAll('table')].find(t=>[...t.querySelectorAll('thead th')].some(th=>th.textContent.trim().startsWith('VALUE')));
    window.scrollTo(0, t.parentElement.getBoundingClientRect().top + window.scrollY - 70); return 1; })()`);
  await sleep(700);

  const g = await ev(GEOM);
  console.log('\n-- geometry, docks open, scrolled into the list --');
  console.log(JSON.stringify(g, null, 1));
  console.log('\n-- computed on the scroll box --');
  console.log(await ev(`(() => {
    const t=[...document.querySelectorAll('table')].find(t=>[...t.querySelectorAll('thead th')].some(th=>th.textContent.trim().startsWith('VALUE')));
    const s=t.parentElement, cs=getComputedStyle(s), th=t.querySelector('thead th');
    const r=s.getBoundingClientRect();
    return JSON.stringify({cls:s.className, overflowX:cs.overflowX, overflowY:cs.overflowY, maxHeight:cs.maxHeight,
      boxTop:Math.round(r.top), boxBottom:Math.round(r.bottom), viewportH:window.innerHeight,
      scrollbarH:s.offsetHeight-s.clientHeight, thPosition:getComputedStyle(th).position,
      barOnScreen: r.bottom <= window.innerHeight + 1});
  })()`));
  await shot('insiders-docks-open-scrolled');

  // Now scroll the TABLE to its right end: VALUE and CONVICTION must be fully visible, not clipped.
  await ev(`(() => { const t=[...document.querySelectorAll('table')].find(t=>[...t.querySelectorAll('thead th')].some(th=>th.textContent.trim().startsWith('VALUE')));
    t.parentElement.scrollLeft = t.parentElement.scrollWidth; return 1; })()`);
  await sleep(500);
  const g2 = await ev(GEOM);
  console.log('\n-- table scrolled to its right end --');
  console.log(`  scrollLeft=${g2.scrollLeft} clipped VALUE cells: ${JSON.stringify(g2.clippedCells)}`);
  console.log(`  VALUE cells now: ${JSON.stringify(g2.cells.map((c) => c.text))}`);
  await shot('insiders-scrolled-right');
} finally { ws.close(); chrome.kill(); }
