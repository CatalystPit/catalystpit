// Measure the real Insiders table in a real browser, at every dock state the user listed.
//
// Nothing here is inferred from source: headless Chrome loads the page over CDP, the docks are
// opened by CLICKING their own toggle buttons, and every number below is read out of the live
// layout — scroller clientWidth/scrollWidth, the VALUE column's painted rect, the page's own
// scrollWidth, and the left offset of every header cell against the first row's cells.
//
//   node scripts/verify-insiders-live.mjs                      # http://localhost:3100
//   node scripts/verify-insiders-live.mjs https://catalystpit.com
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:3100';
const PORT = 9333;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
].find((p) => existsSync(p));
if (!CHROME) { console.error('no Chrome found'); process.exit(1); }

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars=false', `--user-data-dir=${process.env.TEMP}/cp-insiders-profile`,
  'about:blank',
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const tabs = await r.json();
      const t = tabs.find((x) => x.type === 'page');
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome never exposed a debugging target');
}

const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id;
  pending.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');

// ── the measurement, run inside the page ─────────────────────────────────────
const MEASURE = `(() => {
  // The transactions table is the one with a Value header.
  const tables = [...document.querySelectorAll('table')];
  const table = tables.find(t => [...t.querySelectorAll('thead th')].some(th => th.textContent.trim().startsWith('VALUE')));
  if (!table) return { ready: false };
  const scroller = table.parentElement;
  // Put the table on screen first. A sticky element cannot be inside the viewport while its
  // containing block is still below the fold, so measuring at scrollTop 0 would only prove that the
  // table has not been scrolled to yet.
  window.scrollTo(0, Math.max(0, scroller.getBoundingClientRect().top + window.scrollY - 120));
  const ths = [...table.querySelectorAll('thead th')];
  const vi = ths.findIndex(th => th.textContent.trim().startsWith('VALUE'));
  const firstRow = table.querySelector('tbody tr');
  const tds = firstRow ? [...firstRow.children] : [];
  const cs = getComputedStyle(scroller);

  // Scroll the box fully right, then read where VALUE actually sits.
  const before = scroller.scrollLeft;
  scroller.scrollLeft = scroller.scrollWidth;
  const box = scroller.getBoundingClientRect();
  const vh = ths[vi].getBoundingClientRect();
  const vd = tds[vi] ? tds[vi].getBoundingClientRect() : null;
  const conv = ths[ths.length - 1].getBoundingClientRect();
  const valueVisible = vh.left >= box.left - 0.5 && vh.right <= box.right + 0.5;
  const convVisible = conv.left >= box.left - 0.5 && conv.right <= box.right + 0.5;

  // Header/row alignment at this scroll position, and again at scrollLeft 0.
  const misalignedAt = (pos) => {
    scroller.scrollLeft = pos;
    let worst = 0;
    for (let i = 0; i < ths.length && i < tds.length; i++) {
      const a = ths[i].getBoundingClientRect(), b = tds[i].getBoundingClientRect();
      worst = Math.max(worst, Math.abs(a.left - b.left), Math.abs(a.width - b.width));
    }
    return worst;
  };
  const alignRight = misalignedAt(scroller.scrollWidth);
  const alignMid = misalignedAt(Math.round(scroller.scrollWidth / 2));
  const alignLeft = misalignedAt(0);
  scroller.scrollLeft = before;

  // Does the PAGE scroll sideways, and does the table sit under a fixed dock?
  const de = document.documentElement;
  const pageScrolls = de.scrollWidth > de.clientWidth + 1 || document.body.scrollWidth > de.clientWidth + 1;
  const docks = [...document.querySelectorAll('div')].filter(d => {
    const s = getComputedStyle(d);
    return s.position === 'fixed' && parseFloat(s.zIndex) >= 60 && d.getBoundingClientRect().width > 100
      && d.getBoundingClientRect().right > window.innerWidth - 2;
  });
  const dockLeft = docks.length ? Math.min(...docks.map(d => d.getBoundingClientRect().left)) : Infinity;
  const cardRight = scroller.getBoundingClientRect().right;

  // The sticky scrollbar: present only when the table overflows, reachable inside the viewport,
  // and driving the same scroll position as the table box.
  const bar = document.querySelector('.cp-hbar');
  let barOk = null, barInView = null, barDrives = null;
  if (bar) {
    const br = bar.getBoundingClientRect();
    barInView = br.bottom <= window.innerHeight + 1 && br.top >= -1;
    bar.scrollLeft = 0; scroller.dispatchEvent(new Event('scroll'));
    bar.scrollLeft = 99999;
    bar.dispatchEvent(new Event('scroll'));
    barDrives = scroller.scrollLeft > 10;
    barOk = bar.scrollWidth >= scroller.scrollWidth - 2;
  }

  return {
    ready: true,
    hasBar: !!bar, barOk, barInView, barDrives,
    viewport: window.innerWidth,
    shell: document.getElementById('cp-shell').getBoundingClientRect().width,
    client: Math.round(scroller.clientWidth),
    scroll: Math.round(scroller.scrollWidth),
    tableW: Math.round(table.getBoundingClientRect().width),
    overflowX: cs.overflowX,
    valueW: Math.round(vh.width),
    valueDataW: vd ? Math.round(vd.width) : null,
    valueVisible, convVisible,
    align: Math.max(alignLeft, alignMid, alignRight),
    pageScrolls,
    underDock: cardRight > dockLeft + 1,
    rows: table.querySelectorAll('tbody tr').length,
    cols: ths.length,
    headers: ths.map(t => t.textContent.trim().replace(/[ ↑↓]+$/, '')).join('|'),
  };
})()`;

const setViewport = (w, h = 900) => send('Emulation.setDeviceMetricsOverride',
  { width: w, height: h, deviceScaleFactor: 1, mobile: false });

async function load(w) {
  await setViewport(w);
  await send('Page.navigate', { url: `${BASE}/insiders` });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await evaluate(MEASURE).catch(() => ({ ready: false }));
    if (r?.ready && r.rows > 0) return r;
  }
  return { ready: false };
}

// Every dock, collapsed. Their open/closed state persists in localStorage, so a state has to be
// established, never assumed.
async function closeAllDocks() {
  for (const l of ['Collapse the Tape', 'Collapse The Pit', 'Collapse watchlist']) {
    const r = await clickDock(l);
    if (r === 'clicked') await sleep(450);
  }
}

function clickDock(label) {
  return evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === ${JSON.stringify(label)});
    if (!b) return 'absent';
    b.click(); return 'clicked';
  })()`);
}

const MIN = 1324;
console.log(`\nmeasuring ${BASE}/insiders in headless Chrome\n`);

try {
  const first = await load(1512);
  if (!first.ready) { console.error('the transactions table never rendered — is the dev server up and signed-in data available?'); process.exit(2); }
  console.log(`  columns: ${first.headers}`);
  ok('all 13 columns render', first.cols === 13, String(first.cols));
  ok('VALUE is one of them', first.headers.includes('VALUE'));

  const STATES = [
    ['both docks closed',          1512, []],
    ['Watchlist open',             1512, ['Open watchlist']],
    ['The Pit open',               1512, ['Open The Pit']],
    ['Watchlist + Pit open',       1512, ['Open watchlist', 'Open The Pit']],
    ['Tape + Pit open',            1512, ['Open the Tape', 'Open The Pit']],
    ['1280 laptop, docks closed',  1280, []],
    ['1280 laptop, Watchlist',     1280, ['Open watchlist']],
    ['1280 laptop, The Pit',       1280, ['Open The Pit']],
    ['1280 laptop, Tape + Pit',    1280, ['Open the Tape', 'Open The Pit']],
    ['1920 wide, Watchlist + Pit', 1920, ['Open watchlist', 'Open The Pit']],
  ];

  for (const [name, vp, clicks] of STATES) {
    let m = await load(vp);
    // Docks remember their own open/closed state, so reach the wanted state explicitly rather than
    // assuming a fresh profile starts closed — an earlier run of this harness proved that wrong.
    await closeAllDocks();
    for (const c of clicks) { await clickDock(c); await sleep(450); }
    m = await evaluate(MEASURE);
    console.log(`  ${name.padEnd(28)} shell=${Math.round(m.shell)} box=${m.client} scroll=${m.scroll} `
      + `table=${m.tableW} value=${m.valueW}px ${m.scroll > m.client ? 'scrolls' : 'fits'}`);
    ok(`${name}: table keeps its full layout`, m.tableW >= MIN - 1, `${m.tableW}px`);
    ok(`${name}: VALUE column is not squeezed`, m.valueW >= 91, `${m.valueW}px`);
    ok(`${name}: VALUE is reachable`, m.valueVisible, 'not visible after scrolling right');
    ok(`${name}: CONVICTION is reachable`, m.convVisible);
    ok(`${name}: header stays aligned with rows`, m.align < 1, `worst drift ${m.align.toFixed(2)}px`);
    ok(`${name}: the page has no horizontal scrollbar`, !m.pageScrolls);
    ok(`${name}: the table is not under a dock`, !m.underDock);
    ok(`${name}: the box scrolls when it must`, m.client >= MIN - 1 || m.scroll > m.client);
    // The affordance: a scrollbar the trader can actually see and use, and only when needed.
    if (m.scroll > m.client + 1) {
      ok(`${name}: a reachable scrollbar is offered`, m.hasBar, 'table overflows with no sticky bar');
      ok(`${name}: ...inside the viewport`, m.barInView, 'the bar is off screen');
      ok(`${name}: ...spanning the full table width`, m.barOk);
      ok(`${name}: ...and dragging it scrolls the table`, m.barDrives);
    } else {
      ok(`${name}: no scrollbar is added when the table fits`, !m.hasBar);
    }
  }

  console.log('\n  expand then collapse — the table must recover');
  let m = await load(1512);
  await closeAllDocks();
  m = await evaluate(MEASURE);
  const closed = m.client;
  await clickDock('Open watchlist'); await sleep(450);
  const openM = await evaluate(MEASURE);
  await clickDock('Collapse watchlist'); await sleep(600);
  const backM = await evaluate(MEASURE);
  console.log(`    closed=${closed} watchlist-open=${openM.client} reclosed=${backM.client}`);
  // The Watchlist only sets --cp-watch when it is ACTIVE, which needs a signed-in session. A
  // headless run is anonymous, so it cannot inset the shell here — and saying so is better than an
  // assertion that passes for the wrong reason. The Pit exercises the identical rule: the shell
  // margin is max(--cp-pit, --cp-watch), one declaration serving both docks.
  if (openM.client < closed - 100) {
    ok('collapsing the Watchlist restores the box', Math.abs(backM.client - closed) <= 2, `${backM.client} vs ${closed}`);
    ok('...and the table is not squeezed afterwards', backM.valueW >= 91 && backM.tableW >= MIN - 1);
  } else {
    console.log('    (Watchlist needs a signed-in session to inset the shell; The Pit covers the same CSS rule)');
  }

  await clickDock('Open The Pit'); await sleep(450);
  const pitM = await evaluate(MEASURE);
  await clickDock('Collapse The Pit'); await sleep(600);
  const pitBack = await evaluate(MEASURE);
  ok('opening The Pit narrows the box', pitM.client < closed - 100, `${pitM.client}`);
  ok('collapsing The Pit restores it', Math.abs(pitBack.client - closed) <= 2, `${pitBack.client} vs ${closed}`);
  ok('...VALUE still full width after the round trip', pitBack.valueW >= 91, `${pitBack.valueW}px`);
} finally {
  ws.close();
  chrome.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
