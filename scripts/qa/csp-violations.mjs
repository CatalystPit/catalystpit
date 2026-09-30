// WHICH DIRECTIVE BLOCKED WHAT, ACCORDING TO THE BROWSER ITSELF.
//
// ⚠️ WHY THIS AND NOT ANOTHER setBypassCSP SWEEP. The bypass sweep I ran before shipping filtered hosts
// through a regex of ad-network domain names — so it silently dropped www.google.com and csi.gstatic.com,
// which the AdSense loader also contacts. Under-measuring is exactly how an allowlist ends up incomplete.
//
// Chrome's violation message names the offending directive verbatim ("violates the following Content
// Security Policy directive: \"frame-src ...\""), so the browser is the authority on both the blocked URL
// and the directive that needs it. No guessing, no recipe, no filter to get wrong.
import { attach, newTab } from './cdp.mjs';

const BASE = 'https://www.catalystpit.com';
const PATHS = ['/', '/screener', '/ticker/AAPL', '/wire'];

const p = await attach(await newTab());

const found = new Map();   // "directive :: host" -> { n, sample, paths:Set }

for (const mobile of [false, true]) {
  await p.viewport(mobile ? 390 : 1440, mobile ? 844 : 900, mobile);
  for (const path of PATHS) {
    await p.goto(BASE + path, { settleMs: 2200, ceilingMs: 30_000 });
    await new Promise((r) => setTimeout(r, 8000));   // the loader's later phases are slow
    for (const e of p.collected.consoleErrors) {
      if (!/Content Security Policy directive/i.test(e)) continue;
      // The blocked URL is inside the FIRST pair of quotes; the directive text follows the phrase.
      const blocked = (e.match(/^Refused to [a-z ]*(?:the )?[a-z ]*'([^']+)'/i)
        || e.match(/(?:Framing|load(?:ing)? of|connect to) '([^']+)'/i)
        || e.match(/'(https?:\/\/[^']+)'/))?.[1];
      const directive = e.match(/Content Security Policy directive: "([a-z-]+)/i)?.[1] || '(unknown)';
      let host = blocked || '(unparsed)';
      try { host = new URL(blocked).host; } catch { /* keep raw */ }
      const key = `${directive} :: ${host}`;
      const rec = found.get(key) || { n: 0, sample: (blocked || e).slice(0, 110), paths: new Set() };
      rec.n++; rec.paths.add((mobile ? 'm' : 'd') + path);
      found.set(key, rec);
    }
  }
}

console.log('CSP VIOLATIONS ON LIVE PRODUCTION, AS THE BROWSER ATTRIBUTES THEM\n');
if (!found.size) console.log('  (none)');
for (const [key, r] of [...found.entries()].sort()) {
  const [directive, host] = key.split(' :: ');
  console.log(`  ${String(r.n).padStart(3)}x  ${directive.padEnd(12)} ${host}`);
  console.log(`         ${r.sample}`);
  console.log(`         seen on: ${[...r.paths].join(' ')}`);
}

console.log('\nADDITIONS THAT WOULD CLEAR THESE:');
const byDir = new Map();
for (const key of found.keys()) {
  const [d, h] = key.split(' :: ');
  if (!byDir.has(d)) byDir.set(d, new Set());
  byDir.get(d).add(h);
}
for (const [d, hosts] of byDir) console.log(`  ${d}: ${[...hosts].map((h) => 'https://' + h).join(' ')}`);
p.close();
