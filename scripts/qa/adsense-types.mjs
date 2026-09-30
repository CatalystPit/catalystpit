// Which CSP DIRECTIVE does each AdSense host need? Determined from the browser's own resource type,
// so each host lands in script-src / frame-src / connect-src / img-src because that is what it is —
// not because a blog post said so.
import { attach, newTab } from './cdp.mjs';

const p = await attach(await newTab());
await p.viewport(1440, 900, false);
await p.send('Page.setBypassCSP', { enabled: true });

const byHost = new Map();
const ADS = /googlesyndication|googleadservices|doubleclick|adtrafficquality|googletagservices/;

for (const path of ['/', '/ticker/AAPL']) {
  const before = p.events.length;
  await p.goto('https://www.catalystpit.com' + path, { settleMs: 2500, ceilingMs: 30_000 });
  await new Promise((r) => setTimeout(r, 6000));
  for (const ev of p.events.slice(before)) {
    if (ev.method !== 'Network.requestWillBeSent') continue;
    const url = ev.params?.request?.url || '';
    let host; try { host = new URL(url).host; } catch { continue; }
    if (!ADS.test(host)) continue;
    const type = ev.params.type || ev.params.initiator?.type || '?';
    const key = `${host} :: ${type}`;
    const e = byHost.get(key) || { n: 0, sample: url.slice(0, 95) };
    e.n++; byHost.set(key, e);
  }
}

const DIRECTIVE = { Script: 'script-src', Document: 'frame-src', XHR: 'connect-src', Fetch: 'connect-src',
  Image: 'img-src', Ping: 'connect-src', Other: 'connect-src', Stylesheet: 'style-src' };

console.log('ADSENSE HOSTS BY RESOURCE TYPE → REQUIRED DIRECTIVE\n');
const needed = new Map();
for (const [key, e] of [...byHost.entries()].sort()) {
  const [host, type] = key.split(' :: ');
  const dir = DIRECTIVE[type] || `(unmapped: ${type})`;
  console.log(`  ${String(e.n).padStart(3)}x  ${type.padEnd(11)} ${dir.padEnd(12)} ${host}`);
  console.log(`         ${e.sample}`);
  if (!needed.has(dir)) needed.set(dir, new Set());
  needed.get(dir).add(host);
}

console.log('\nMINIMUM ADDITIONS REQUIRED:');
for (const [dir, hosts] of needed) console.log(`  ${dir}: ${[...hosts].map((h) => 'https://' + h).join(' ')}`);
p.close();
