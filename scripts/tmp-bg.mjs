import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const PORT = 9376;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/cp-bg`, 'about:blank'], { stdio: 'ignore' });
async function target(){for(let i=0;i<40;i++){try{const t=(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x=>x.type==='page');if(t?.webSocketDebuggerUrl)return t.webSocketDebuggerUrl;}catch{}await sleep(250);}throw new Error('no target');}
const ws=new WebSocket(await target());await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}};
const send=(m,params={})=>new Promise((res,rej)=>{const n=++id;p.set(n,x=>x.error?rej(new Error(x.error.message)):res(x.result));ws.send(JSON.stringify({id:n,method:m,params}));});
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.exceptionDetails?{err:r.exceptionDetails.exception?.description}:r.result.value;};
await send('Page.enable');await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:'https://www.catalystpit.com/'});
await sleep(9000);
console.log(JSON.stringify(await ev(`(() => {
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const el = n.parentElement; if (!el || el.offsetParent === null) continue;
    const cs = getComputedStyle(el);
    if (!cs.color.includes('255, 255, 255')) continue;
    const r = el.getBoundingClientRect(); if (r.width < 4) continue;
    let e = el, chain = [];
    while (e && e !== document.documentElement && chain.length < 6) {
      const c = getComputedStyle(e);
      chain.push(e.tagName.toLowerCase() + '{bg:' + c.backgroundColor + (c.backgroundImage !== 'none' ? ',IMG:' + c.backgroundImage.slice(0, 40) : '') + '}');
      const m = c.backgroundColor.match(/[\d.]+/g);
      if (m && (m.length < 4 || Number(m[3]) > 0.5)) break;
      e = e.parentElement;
    }
    out.push({ t: n.nodeValue.trim().slice(0, 34), opacity: cs.opacity, chain });
    if (out.length > 6) break;
  }
  return out;
})()`), null, 1));
ws.close();chrome.kill();
