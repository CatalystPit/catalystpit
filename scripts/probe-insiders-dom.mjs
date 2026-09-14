// What does the Insiders page actually render here? Full body text + console errors.
// Run: node scripts/probe-insiders-dom.mjs [baseUrl]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const BASE = process.argv[2] || 'http://localhost:3100';
const PORT = 9336;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/cp-dom-profile`, 'about:blank'], { stdio: 'ignore' });
async function target() {
  for (let i = 0; i < 40; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page');
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl; } catch { /* wait */ }
    await sleep(250);
  }
  throw new Error('no target');
}
const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(m.params.args.map((a) => a.value || a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 300));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id; pending.set(n, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/insiders` });
await sleep(12000);
console.log('--- body text ---');
console.log(await ev('document.body.innerText.slice(0, 1200)'));
console.log('\n--- tables ---', await ev("document.querySelectorAll('table').length"));
console.log('--- .cp-hbar ---', await ev("document.querySelectorAll('.cp-hbar').length"));
console.log('--- buttons ---', await ev("[...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')).filter(Boolean).join(' | ')"));
console.log('\n--- console errors ---');
console.log(logs.slice(0, 12).join('\n') || '(none)');
ws.close(); chrome.kill();
