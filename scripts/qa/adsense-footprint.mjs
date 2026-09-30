// What does the AdSense loader ACTUALLY request? Measured, not assumed.
//
// ⚠️ WHY MEASURE INSTEAD OF PASTING GOOGLE'S ALLOWLIST. Every "AdSense CSP" recipe online enumerates
// a dozen domains for a full ad-serving integration. This site has ONE script tag and no ad slots, so
// most of that list would be permission we do not need. Page.setBypassCSP lets the script run
// unrestricted for one measurement, and the domains it genuinely contacts are the ones to allow.
import { attach, newTab } from './cdp.mjs';

const p = await attach(await newTab());
await p.viewport(1440, 900, false);
await p.send('Page.setBypassCSP', { enabled: true });

const BASE = 'https://www.catalystpit.com';
const seen = new Map();   // host -> { count, types, samples }

for (const path of ['/', '/screener', '/ticker/AAPL']) {
  await p.goto(BASE + path, { settleMs: 2500, ceilingMs: 25_000 });
  await new Promise((r) => setTimeout(r, 4000));   // the loader is async; give it time to phone home
  for (const r of p.collected.requests) {
    let h;
    try { h = new URL(r.url).host; } catch { continue; }
    if (/catalystpit\.com/.test(h)) continue;
    const e = seen.get(h) || { count: 0, samples: [] };
    e.count++;
    if (e.samples.length < 2) e.samples.push(r.url.slice(0, 110));
    seen.set(h, e);
  }
}

// Which of those are Google/AdSense, and which are the other third parties already allowed.
const GOOGLE = /(googlesyndication|googleadservices|doubleclick|googletagservices|google\.com|gstatic|googleapis)/;
console.log('THIRD-PARTY HOSTS CONTACTED WITH CSP BYPASSED\n');
const rows = [...seen.entries()].sort((a, b) => b[1].count - a[1].count);
for (const [host, e] of rows) {
  const tag = GOOGLE.test(host) ? (/googlesyndication|googleadservices|doubleclick|googletagservices/.test(host) ? 'ADSENSE' : 'google-other') : '';
  console.log(`  ${String(e.count).padStart(3)}x  ${host.padEnd(40)} ${tag}`);
  if (tag === 'ADSENSE') for (const s of e.samples) console.log(`          ${s}`);
}

console.log('\nAdSense-related hosts only:');
const ads = rows.filter(([h]) => /googlesyndication|googleadservices|doubleclick|googletagservices/.test(h)).map(([h]) => h);
console.log('  ' + (ads.join('\n  ') || '(none — the script made no further requests)'));
p.close();
