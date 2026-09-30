// WHO ASKS FOR THE www.google.com FRAME?
//
// ⚠️ DO NOT PERMIT A HOST WITHOUT KNOWING WHAT WANTS IT. www.google.com is a broad, high-value origin;
// allowing it because "an AdSense recipe lists it" is exactly the reasoning this whole task avoided.
// This reads the request's initiator stack straight from the protocol, so the answer is the browser's.
import { attach, newTab } from './cdp.mjs';

const p = await attach(await newTab());
await p.viewport(1440, 900, false);
const before = p.events.length;
await p.goto('https://www.catalystpit.com/', { settleMs: 2200, ceilingMs: 30_000 });
await new Promise((r) => setTimeout(r, 9000));

for (const ev of p.events.slice(before)) {
  if (ev.method !== 'Network.requestWillBeSent') continue;
  const url = ev.params?.request?.url || '';
  if (!/^https:\/\/www\.google\.com\/?$/.test(url)) continue;
  const init = ev.params.initiator || {};
  console.log('REQUEST      ', url);
  console.log('  type       ', ev.params.type);
  console.log('  initiator  ', init.type, init.url || '');
  for (const f of (init.stack?.callFrames || []).slice(0, 6)) {
    console.log(`    at ${f.functionName || '(anon)'} ${f.url}:${f.lineNumber}`);
  }
  console.log('  frameId    ', ev.params.frameId);
  console.log('');
}

// And the DOM's own account of it, as a cross-check.
const dom = await p.eval(`[...document.querySelectorAll('iframe')].map((f) => ({
  src: (f.src || '').slice(0, 60), id: f.id, name: (f.name || '').slice(0, 30),
  parentId: f.parentElement?.id || f.parentElement?.tagName,
  w: Math.round(f.getBoundingClientRect().width), h: Math.round(f.getBoundingClientRect().height)
}))`);
console.log('IFRAMES IN THE DOM:');
for (const f of dom) console.log('  ' + JSON.stringify(f));

const slots = await p.eval(`[...document.querySelectorAll('ins.adsbygoogle')].map((e) => ({
  status: e.getAttribute('data-ad-status'), cls: e.className,
  w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height),
  html: e.innerHTML.length
}))`);
console.log('ins.adsbygoogle SLOTS:');
console.log('  ' + JSON.stringify(slots));
p.close();
