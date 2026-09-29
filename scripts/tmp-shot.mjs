// Capture what a contrast finding actually looks like, so a computed ratio is confirmed by eye.
//   node scripts/tmp-shot.mjs <route> <light|dark> <needle> <out.png> [viewport]
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const [route, theme, needle, out, vp = '1440x900'] = process.argv.slice(2);
const [VW, VH] = vp.split('x').map(Number);
const PORT = 9372;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${process.env.TEMP}/cp-shot`, 'about:blank'], { stdio: 'ignore' });
async function target() {
  for (let i = 0; i < 40; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page');
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl; } catch { /* wait */ }
    await sleep(250);
  } throw new Error('no target');
}
const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id: n, method: m, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { err: r.exceptionDetails.exception?.description } : r.result.value; };
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 2, mobile: VW < 500 });
await send('Page.addScriptToEvaluateOnNewDocument', { source: theme === 'dark'
  ? "try{localStorage.setItem('cp_theme','dark');document.documentElement.setAttribute('data-theme','dark');}catch(e){}"
  : "try{localStorage.removeItem('cp_theme');}catch(e){}" });
await send('Page.navigate', { url: `https://www.catalystpit.com${route}` });
await sleep(9000);

const FIND = `(() => {
  const n = ${JSON.stringify(needle)};
  const els = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').includes(n));
  const el = els[0];
  if (!el) return { found: false, sample: document.body.innerText.slice(0, 300) };
  const box = el.closest('div,section,article,header,nav') || el;
  box.scrollIntoView({ block: 'center' });
  const r = box.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { found: true, fg: cs.color, fontSize: cs.fontSize, opacity: cs.opacity,
    transition: cs.transition, animation: cs.animationName,
    clip: { x: Math.max(0, r.left - 16), y: Math.max(0, r.top - 16), width: Math.min(${VW}, r.width + 32), height: Math.min(600, r.height + 32) } };
})()`;
const d = await ev(FIND);
console.log(JSON.stringify(d, null, 1));
if (d.found) {
  await sleep(500);
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...d.clip, scale: 2 } });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`wrote ${out}`);
}
ws.close(); chrome.kill();
