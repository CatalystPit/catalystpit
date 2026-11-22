// WHY ARE THE SLOTS UNFILLED? Site-side, or account-side?
//
// The distinction matters before building placements: twenty slots that return no ad earn exactly
// what one slot that returns no ad earns, and a dense layout built on an account-level block is
// clutter with no upside. So this reads the actual ad-request traffic rather than the DOM.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'https://www.catalystpit.com';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9100 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'cp-ad-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--window-size=1600,1200'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let v = null;
for (let i = 0; i < 40 && !v; i++) { await sleep(500); try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {} }
if (!v) { console.error('no chrome'); chrome.kill(); process.exit(1); }

const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map();
const net = [];
const adLogs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (/googlesyndication|doubleclick|adtrafficquality|googleads|adservice/i.test(u)) {
      net.push({
        url: u.slice(0, 150), status: m.params.response.status,
        len: m.params.response.encodedDataLength,
        type: m.params.type,
        hdrs: Object.fromEntries(Object.entries(m.params.response.headers || {})
          .filter(([k]) => /google|ad-|x-|status/i.test(k)).slice(0, 6)),
      });
    }
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const s = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (/ad|google/i.test(s)) adLogs.push(`[${m.params.type}] ${s.slice(0, 200)}`);
  }
};
const send = (me, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');

console.log(`== ${BASE}/markets ==\n`);
await send('Page.navigate', { url: `${BASE}/markets` });
await sleep(18000);
// Scroll: auto ads and lazy units often only request after the viewport moves.
await ev('window.scrollTo(0, document.body.scrollHeight/2)');
await sleep(6000);
await ev('window.scrollTo(0, document.body.scrollHeight)');
await sleep(8000);

console.log('— ad network traffic —');
for (const r of net) {
  const tag = /\/pagead\/ads|\/pagead\/adview|aclk/i.test(r.url) ? ' <== AD REQUEST' : '';
  console.log(`  ${r.status}  ${String(r.len).padStart(7)}B  ${r.url}${tag}`);
  if (Object.keys(r.hdrs).length) console.log(`         hdrs: ${JSON.stringify(r.hdrs)}`);
}
if (!net.length) console.log('  (none — the loader never ran)');

console.log('\n— slots in the DOM —');
console.log(await ev(`JSON.stringify({
  loader: !!document.querySelector('script[src*="pagead2.googlesyndication.com"]'),
  insTotal: document.querySelectorAll('ins.adsbygoogle').length,
  statuses: [...document.querySelectorAll('ins.adsbygoogle')].map(e => ({
    status: e.getAttribute('data-ad-status'),
    slot: e.getAttribute('data-ad-slot'),
    fmt: e.getAttribute('data-ad-format'),
    h: e.offsetHeight, w: e.offsetWidth,
    autoAd: e.hasAttribute('data-google-query-id') || e.className.includes('google-auto-placed')
  })),
  autoPlaced: document.querySelectorAll('.google-auto-placed').length,
  frames: document.querySelectorAll('iframe[src*="doubleclick"], iframe[src*="googlesyndication"]').length
}, null, 1)`));

console.log('\n— what adsbygoogle itself reports —');
console.log(await ev(`JSON.stringify({
  queueLen: Array.isArray(window.adsbygoogle) ? window.adsbygoogle.length : 'not array',
  loadedFlag: window.adsbygoogle && window.adsbygoogle.loaded,
  pageLevel: !!(window.adsbygoogle && window.adsbygoogle.push_ && true),
  gaGlobal: typeof window.google_ad_client,
  autoAdsOn: !!document.querySelector('.google-auto-placed, ins[data-anchor-status], ins[data-vignette-loaded]')
})`));

if (adLogs.length) { console.log('\n— console (ad-related) —'); console.log(adLogs.slice(0, 8).join('\n')); }

ws.close(); await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`); chrome.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
