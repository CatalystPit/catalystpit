import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const route = process.argv[2] || '/heatmap';
const VW = Number(process.argv[3] || 390);
const PORT = 9380;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${process.env.TEMP}/cp-ovf`, 'about:blank'], { stdio: 'ignore' });
async function target(){for(let i=0;i<40;i++){try{const t=(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x=>x.type==='page');if(t?.webSocketDebuggerUrl)return t.webSocketDebuggerUrl;}catch{}await sleep(250);}throw new Error('no target');}
const ws=new WebSocket(await target());await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}};
const send=(m,params={})=>new Promise((res,rej)=>{const n=++id;p.set(n,x=>x.error?rej(new Error(x.error.message)):res(x.result));ws.send(JSON.stringify({id:n,method:m,params}));});
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.exceptionDetails?{err:r.exceptionDetails.exception?.description}:r.result.value;};
await send('Page.enable');await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:VW,height:844,deviceScaleFactor:1,mobile:VW<500});
await send('Page.navigate',{url:'https://www.catalystpit.com'+route});
for (const t of [2800]) { await sleep(t);
const desc = (e) => e;
console.log(JSON.stringify(await ev(`(() => {
  const de = document.documentElement;
  const limit = de.clientWidth;
  const id = (e) => e.tagName.toLowerCase() + (e.id ? '#'+e.id : '') + (e.className && typeof e.className === 'string' && e.className.trim() ? '.'+e.className.trim().split(/\s+/).join('.') : '');
  const out = [];
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect();
    if (r.right <= limit + 1 || r.height < 3) continue;
    const cs = getComputedStyle(e);
    if (cs.position === 'fixed') continue;
    // Is any ancestor actually clipping this? If so it is not the page-level cause.
    let clipped = false, a = e.parentElement;
    while (a && a !== de) { const ac = getComputedStyle(a); if (ac.overflowX !== 'visible') { clipped = true; break; } a = a.parentElement; }
    out.push({ el: id(e).slice(0,70), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
               overflowX: cs.overflowX, whiteSpace: cs.whiteSpace, minWidth: cs.minWidth, clippedByAncestor: clipped,
               parent: e.parentElement ? id(e.parentElement).slice(0,60) : null,
               text: (e.textContent||'').trim().slice(0,40) });
  }
  return { viewport: limit, scrollWidth: de.scrollWidth, overflow: de.scrollWidth - limit, offenders: out.slice(0, 14) };
})()`), null, 1));
}
ws.close();chrome.kill();
