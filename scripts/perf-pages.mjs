// PAGE TIMINGS — what a user actually waits for, measured in real Chrome against production.
//
//   node scripts/perf-pages.mjs [--routes /,/screener] [--runs 2] [--nav]
//
// ⚠️ API TIMINGS DO NOT EXPLAIN A SLOW PAGE. Every endpoint can answer in 100ms and the page still
// take six seconds, because what a user waits for is paint — which depends on how much JavaScript
// has to arrive and execute before anything renders, and on whether the page's requests run in
// parallel or in a chain. So this measures FCP/LCP, the bytes needed to get there, and the request
// waterfall, not just endpoint latency.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'https://www.catalystpit.com');
const RUNS = Number(arg('runs', 2));
const ROUTES = (arg('routes', '/,/ticker/AAPL,/screener,/terminal,/scan,/feed,/watchlist,/consensus,/insiders,/institutions,/politicians,/heatmap')).split(',');
const PORT = 9400;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${process.env.TEMP}/cp-perf`, 'about:blank'], { stdio: 'ignore' });

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

const METRICS = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
  const res = performance.getEntriesByType('resource');
  const byType = {};
  for (const r of res) {
    const t = /\\.js(\\?|$)/.test(r.name) ? 'js' : /\\.css(\\?|$)/.test(r.name) ? 'css'
      : /\\/api\\//.test(r.name) ? 'api' : /fonts|\\.woff/.test(r.name) ? 'font'
      : /\\.(png|jpe?g|svg|webp|ico)(\\?|$)/.test(r.name) ? 'img' : 'other';
    byType[t] = byType[t] || { n: 0, bytes: 0, ms: 0 };
    byType[t].n++; byType[t].bytes += r.transferSize || 0; byType[t].ms += r.duration;
  }
  // ⚠️ THE API CHAIN, NOT THE API TOTAL. Six 100ms calls in parallel cost 100ms; the same six in a
  // chain cost 600ms, and only the second is a bug worth fixing. Measured as the span from the first
  // api request starting to the last one finishing, against the sum of their durations.
  const api = res.filter((r) => /\\/api\\//.test(r.name));
  const apiSpan = api.length ? Math.round(Math.max(...api.map((r) => r.responseEnd)) - Math.min(...api.map((r) => r.startTime))) : 0;
  const apiSum = Math.round(api.reduce((a, r) => a + r.duration, 0));
  const slowest = api.map((r) => ({ u: r.name.replace(location.origin, '').split('?')[0], ms: Math.round(r.duration), start: Math.round(r.startTime) }))
    .sort((a, b) => b.ms - a.ms).slice(0, 4);
  // Duplicate calls to the same path within one page view.
  const counts = {};
  for (const r of api) { const k = r.name.replace(location.origin, ''); counts[k] = (counts[k] || 0) + 1; }
  const dupes = Object.entries(counts).filter(([, n]) => n > 1).map(([k, n]) => k.slice(0, 58) + ' x' + n);
  return {
    ttfb: Math.round(nav.responseStart || 0),
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
    load: Math.round(nav.loadEventEnd || 0),
    fcp: paints['first-contentful-paint'] ?? null,
    byType, apiCount: api.length, apiSpan, apiSum, slowest, dupes,
    textLen: (document.body.innerText || '').length,
  };
})()`;

const LCP = `(() => new Promise((resolve) => {
  let v = 0;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) v = Math.round(e.startTime); })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* unsupported */ }
  setTimeout(() => resolve(v), 200);
}))()`;

console.log(`base ${BASE} · ${RUNS} runs per route (first run is cold)\n`);
console.log('route                  run   TTFB    FCP    LCP    DCL   load  |  JS kb  API n/span/sum  | dupes');
const summary = [];
for (const route of ROUTES) {
  for (let run = 0; run < RUNS; run++) {
    evs = [];
    await send('Network.clearBrowserCache');
    await send('Page.navigate', { url: BASE + route });
    await sleep(9000);
    const m = await ev(METRICS);
    const lcp = await ev(LCP);
    if (!m) { console.log(`${route.padEnd(22)} ${run}  (no metrics)`); continue; }
    const js = Math.round((m.byType.js?.bytes || 0) / 1024);
    console.log(
      route.padEnd(22) + String(run).padStart(4)
      + String(m.ttfb).padStart(7) + String(m.fcp ?? '—').padStart(7) + String(lcp || '—').padStart(7)
      + String(m.domContentLoaded).padStart(7) + String(m.load).padStart(7)
      + '  |' + String(js + 'kb').padStart(7)
      + String(`${m.apiCount}/${m.apiSpan}/${m.apiSum}`).padStart(15)
      + '  | ' + (m.dupes.join(', ') || '-'),
    );
    if (run === RUNS - 1) summary.push({ route, ...m, lcp, js });
  }
}

console.log('\n── slowest by LCP (warm) ──');
for (const s of [...summary].sort((a, b) => (b.lcp || 0) - (a.lcp || 0)).slice(0, 6)) {
  console.log(`  ${String((s.lcp || 0) + 'ms').padStart(8)}  ${s.route.padEnd(20)} js=${s.js}kb api=${s.apiCount} span=${s.apiSpan}ms`);
  for (const q of s.slowest) console.log(`             ${String(q.ms + 'ms').padStart(7)} @${q.start}ms  ${q.u}`);
}
ws.close(); chrome.kill();
