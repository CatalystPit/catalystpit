// CLIENT-SIDE NAVIGATION — the flows a user actually performs, not full page loads.
//
//   node scripts/perf-nav.mjs
//
// ⚠️ A FULL LOAD IS NOT WHAT USERS DO AFTER THE FIRST PAGE. The App Router navigates client-side,
// so FCP/LCP never fire again and every full-load metric says the site is fast while the person
// stares at a half-empty page. What matters here is: after the click, how long until the DESTINATION
// PAGE'S OWN DATA is on screen. That is measured by polling for a marker that only appears once the
// real content has rendered — not a skeleton, and not the heading, which renders immediately.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const BASE = 'https://www.catalystpit.com';
const PORT = 9404;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${process.env.TEMP}/cp-nav`, 'about:blank'], { stdio: 'ignore' });
async function target() {
  for (let i = 0; i < 60; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page');
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl; } catch { /* wait */ }
    await sleep(250);
  } throw new Error('no target');
}
const ws = new WebSocket(await target());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id: n, method: m, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? null : r.result.value; };
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// Each step: where to go, and the marker proving the destination's OWN data has rendered.
const FLOWS = [
  ['/', 'homepage', `document.body.innerText.includes('MARKET BREADTH') && /\\d,\\d{3}/.test(document.body.innerText)`],
  ['/ticker/AAPL', 'ticker AAPL', `document.body.innerText.includes('Apple') && document.querySelectorAll('table tr, [class*=row]').length > 5`],
  ['/insiders', 'insiders', `document.querySelectorAll('table tbody tr').length > 3`],
  ['/institutions', 'institutions', `document.querySelectorAll('table tbody tr, a[href^="/institutions/"]').length > 5`],
  ['/politicians', 'politicians', `document.querySelectorAll('table tbody tr, a[href^="/politicians/"]').length > 5`],
  ['/screener', 'screener', `document.querySelectorAll('table tbody tr').length > 5`],
  ['/scan', 'pit scan', `document.body.innerText.length > 3000`],
  ['/consensus', 'consensus', `document.body.innerText.includes('Pit Consensus') && document.body.innerText.length > 3000`],
  ['/heatmap', 'heatmap', `document.querySelectorAll('.cp-tkr').length > 10`],
  ['/feed', 'pit wire / feed', `document.body.innerText.length > 1200`],
  ['/watchlist', 'watchlist', `document.body.innerText.length > 700`],
  ['/terminal', 'terminal', `document.body.innerText.length > 900`],
];

/** Navigate client-side (pushState via a real link click where possible) and wait for the marker. */
async function navigateAndWait(path, marker, budgetMs = 20000) {
  const t0 = Date.now();
  // Prefer a real in-app link so the App Router handles it; fall back to history navigation.
  const clicked = await ev(`(() => {
    const a = [...document.querySelectorAll('a[href]')].find((x) => x.getAttribute('href') === ${JSON.stringify(path)});
    if (a) { a.click(); return true; }
    return false;
  })()`);
  if (!clicked) await ev(`window.next?.router?.push(${JSON.stringify(path)}) ?? (location.href = ${JSON.stringify(path)}), true`);
  let ready = false, urlOk = false;
  while (Date.now() - t0 < budgetMs) {
    urlOk = await ev(`location.pathname === ${JSON.stringify(path)}`);
    if (urlOk) { ready = await ev(`(() => { try { return !!(${marker}); } catch { return false; } })()`); if (ready) break; }
    await sleep(100);
  }
  return { ms: Date.now() - t0, ready, clicked };
}

console.log('CLIENT-SIDE NAVIGATION — time from click to the destination\'s own data being on screen\n');
console.log('flow                                   click→data   via');

// Warm the app once so we measure navigation, not the first cold load.
await send('Page.navigate', { url: BASE });
await sleep(8000);

const results = [];
for (const [path, label, marker] of FLOWS) {
  const r = await navigateAndWait(path, marker);
  results.push({ label, path, ...r });
  console.log(`${label.padEnd(38)}${String(r.ms + 'ms').padStart(9)}   ${r.clicked ? 'link' : 'href'}${r.ready ? '' : '  ⚠️ TIMED OUT / marker never true'}`);
  // Return home between flows so each is measured from the same starting point.
  await send('Page.navigate', { url: BASE });
  await sleep(4000);
}

console.log('\n── slowest navigations ──');
for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, 6)) {
  console.log(`  ${String(r.ms + 'ms').padStart(8)}  ${r.label}${r.ready ? '' : '  (never rendered)'}`);
}
ws.close(); chrome.kill();
