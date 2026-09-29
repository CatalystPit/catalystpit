// COLD navigation to a ticker page: a fresh document load with an empty browser cache, measured to
// FULL page interactive (the tab bar, which only ValidView renders — the SSR shell has no tabs).
//
//   node scripts/perf-ticker-cold.mjs [--tickers NVDA,AAPL,MSFT,PLAB]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'https://www.catalystpit.com');
const TICKERS = arg('tickers', 'NVDA,AAPL,MSFT,PLAB').split(',');
const PORT = 9412;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${process.env.TEMP}/cp-cold`, 'about:blank'], { stdio: 'ignore' });
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
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

console.log('COLD navigation (empty cache, fresh document) → FULL ticker page\n');
console.log('ticker     shell     FULL   | verdict');
for (const t of TICKERS) {
  await send('Network.clearBrowserCache');
  const t0 = Date.now();
  await send('Page.navigate', { url: `${BASE}/ticker/${t}` });
  let shell = null, full = null;
  while (Date.now() - t0 < 25000) {
    const s = await ev(`(() => { try { return {
      shell: /ABOUT|RECENT INSIDER TRADES/.test(document.body.innerText),
      full: /Press Releases/.test(document.body.innerText) } ; } catch { return null; } })()`);
    const now = Date.now() - t0;
    if (s) { if (shell == null && s.shell) shell = now; if (s.full) { full = now; break; } }
    await sleep(60);
  }
  const v = full == null ? '⚠️ never became full' : full > 2000 ? '⚠️ SLOW' : 'ok';
  console.log(`${t.padEnd(8)}${String(shell ?? '—').padStart(7)}${String(full ?? '—').padStart(9)}   | ${v}`);
}
ws.close(); chrome.kill();
