// Is "Loading tape from X…" a transient state or a permanent one? Watch it, do not assume.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const BASE = process.argv[2] || 'https://www.catalystpit.com';
const PORT = 9366;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/cp-tape`, 'about:blank'], { stdio: 'ignore' });
async function target() {
  for (let i = 0; i < 40; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page');
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl; } catch { /* wait */ }
    await sleep(250);
  } throw new Error('no target');
}
const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); const evts = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) evts.push(m); };
const send = (m, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id: n, method: m, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { err: r.exceptionDetails.exception?.description } : r.result.value; };
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const READ = `(() => {
  const all = [...document.querySelectorAll('*')];
  const el = all.find((e) => e.children.length === 0 && /Loading tape from X/.test(e.textContent));
  const dock = all.find((e) => /^TAPE$/.test((e.textContent || '').trim()) && e.children.length === 0);
  const vis = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, visibility: cs.visibility,
             opacity: cs.opacity, onscreen: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight }; };
  return {
    present: !!el, text: el ? el.textContent.trim().slice(0, 60) : null, box: vis(el),
    dockBox: vis(dock),
    iframes: [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 70)),
  };
})()`;

await send('Page.navigate', { url: BASE });
for (const t of [5, 10, 15, 20, 25, 30, 20, 20]) {
  await sleep(t * 1000 - (t === 3 ? 0 : 0));
  const d = await ev(READ);
  console.log(`+${t}s: ${JSON.stringify(d)}`);
  if (!d.present) { console.log('  -> resolved'); break; }
}
const tw = evts.filter((e) => e.method === 'Network.responseReceived' && /twitter|twimg|x\.com/.test(e.params.response.url))
  .map((e) => `${e.params.response.status} ${e.params.response.url.split('?')[0]}`);
console.log(`\ntwitter/X responses: ${JSON.stringify([...new Set(tw)], null, 1)}`);
ws.close(); chrome.kill();
