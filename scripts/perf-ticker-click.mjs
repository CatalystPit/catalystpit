// TICKER PAGE: CLICK → FULL PAGE INTERACTIVE, measured the way a user experiences it.
//
//   node scripts/perf-ticker-click.mjs [--tickers NVDA,AAPL,MSFT,PLAB] [--runs 2]
//
// ⚠️ WHY THE PREVIOUS 503ms NUMBER WAS WRONG. It waited for "the company name is on screen and there
// are some rows". The SSR shell renders EXACTLY that — header, ABOUT, RECENT INSIDER TRADES,
// INSTITUTIONAL OWNERSHIP, congress, news — so the marker went true the instant the shell painted
// and the measurement stopped before the real page existed. Measuring the wrong end of the wait
// reported 0.5s for something users experience as 5-10s.
//
// The full page is the one with the TAB BAR (Overview / News / Press Releases / …). The shell has no
// tabs, so "Press Releases" is present if and only if ValidView has mounted. That is the marker.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'https://www.catalystpit.com');
const TICKERS = arg('tickers', 'NVDA,AAPL,MSFT,PLAB').split(',');
const RUNS = Number(arg('runs', 2));
const PORT = 9410;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${process.env.TEMP}/cp-tick`, 'about:blank'], { stdio: 'ignore' });
async function target() {
  for (let i = 0; i < 60; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page');
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl; } catch { /* wait */ }
    await sleep(250);
  } throw new Error('no target');
}
const ws = new WebSocket(await target());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map(); let evs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) evs.push(m); };
const send = (m, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id: n, method: m, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? null : r.result.value; };
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// Markers, evaluated in the page. Deliberately structural, not text the shell also has.
const SHELL = `!!document.querySelector('h1') && /ABOUT|RECENT INSIDER TRADES/.test(document.body.innerText)`;
const FULL = `/Press Releases/.test(document.body.innerText)`;
const CHART = `!!document.querySelector('canvas')`;

async function measure(ticker) {
  // Always start from a fully loaded homepage, like a user who is already on the site.
  await send('Page.navigate', { url: BASE });
  await sleep(7000);
  evs = [];

  const t0 = Date.now();
  // ⚠️ A REAL CLICK ON A REAL LINK. Falls back to the router only if the homepage does not happen to
  // link that symbol — still the same client-side navigation path, not a document load.
  const clicked = await ev(`(() => {
    const a = [...document.querySelectorAll('a[href]')].find((x) => (x.getAttribute('href') || '').toUpperCase() === '/TICKER/${ticker}');
    if (a) { a.click(); return 'link'; }
    const any = [...document.querySelectorAll('a[href^="/ticker/"]')][0];
    if (any) { history.pushState({}, '', '/ticker/${ticker}'); window.dispatchEvent(new PopStateEvent('popstate')); return 'push'; }
    return 'none';
  })()`);
  if (clicked === 'none' || clicked === 'push') {
    // Guarantee the SPA route actually changes even when no link exists for this symbol.
    await ev(`window.history.pushState({}, '', '/ticker/${ticker}'); true`);
  }

  const marks = { click: 0, route: null, shell: null, chart: null, full: null };
  const deadline = 30000;
  while (Date.now() - t0 < deadline) {
    const s = await ev(`(() => { try { return {
      path: location.pathname,
      shell: ${SHELL}, full: ${FULL}, chart: ${CHART}
    }; } catch { return null; } })()`);
    const now = Date.now() - t0;
    if (s) {
      if (marks.route == null && s.path.toUpperCase() === `/TICKER/${ticker}`) marks.route = now;
      if (marks.shell == null && s.shell) marks.shell = now;
      if (marks.chart == null && s.chart) marks.chart = now;
      if (marks.full == null && s.full) { marks.full = now; break; }
    }
    await sleep(60);
  }

  // The network timeline for this navigation, from the browser's own resource entries.
  const net = await ev(`(() => {
    const t = performance.timeOrigin;
    return performance.getEntriesByType('resource')
      .filter((r) => /\\/api\\//.test(r.name))
      .map((r) => ({ u: r.name.replace(location.origin, '').slice(0, 52), start: Math.round(r.startTime), end: Math.round(r.responseEnd), ms: Math.round(r.duration) }))
      .sort((a, b) => a.start - b.start);
  })()`);
  return { ticker, marks, net: net || [] };
}

console.log(`CLICK → FULL TICKER PAGE INTERACTIVE  (${BASE})\n`);
console.log('ticker   run    route    shell    chart     FULL   | verdict');
const all = [];
for (const t of TICKERS) {
  for (let run = 0; run < RUNS; run++) {
    const r = await measure(t);
    const m = r.marks;
    const v = m.full == null ? '⚠️ NEVER BECAME FULL' : m.full > 3000 ? '⚠️ SLOW' : m.full > 1500 ? '·' : 'ok';
    console.log(
      `${t.padEnd(8)}${String(run).padStart(3)}`
      + String(m.route ?? '—').padStart(9) + String(m.shell ?? '—').padStart(9)
      + String(m.chart ?? '—').padStart(9) + String(m.full ?? '—').padStart(9)
      + '   | ' + v,
    );
    if (run === RUNS - 1) all.push(r);
  }
}

console.log('\n── request timeline for the last run of each ticker (ms from click, API only) ──');
for (const r of all) {
  console.log(`\n${r.ticker}  shell@${r.marks.shell}  FULL@${r.marks.full}`);
  // Only entries that began at/after the click matter; earlier ones belong to the homepage.
  const base = r.net.length ? Math.min(...r.net.map((x) => x.start)) : 0;
  for (const x of r.net.slice(-14)) {
    console.log(`   ${String(x.start).padStart(7)} → ${String(x.end).padStart(7)}  (${String(x.ms).padStart(5)}ms)  ${x.u}`);
  }
}
ws.close(); chrome.kill();
