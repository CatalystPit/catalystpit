// DOES THE LIVE ADSENSE LOADER SET COOKIES OR BROWSER STORAGE?
//
// ⚠️ THIS DECIDES HOW MUCH OF THE PRIVACY POLICY IS NOW WRONG, AND NOTHING ELSE SHOULD DECIDE IT.
// Section 2.2 says "We use two kinds of browser storage, and only two" and reasons from that to "we do
// not ask you for cookie consent". If the loader is already setting third-party advertising cookies,
// that reasoning is contradicted today and the correction has to reach 2.2 as well as 2.4. If it sets
// nothing while placements are unfilled, 2.2 is still accurate and touching it would be the speculative
// legal drafting the brief rules out.
//
// So: read the actual cookie jar and the actual storage, per origin, from a clean profile.
import { attach, newTab } from './cdp.mjs';

const BASE = 'https://www.catalystpit.com';
const p = await attach(await newTab());
await p.viewport(1440, 900, false);

await p.send('Network.clearBrowserCookies');
await p.goto(BASE + '/', { settleMs: 2200, ceilingMs: 30_000 });
await new Promise((r) => setTimeout(r, 9000));   // the loader phones home late
// A second navigation, because some vendors only set on the second impression.
await p.goto(BASE + '/screener', { settleMs: 2200, ceilingMs: 30_000 });
await new Promise((r) => setTimeout(r, 9000));

const { cookies } = await p.send('Network.getAllCookies');
const AD = /googlesyndication|doubleclick|adtrafficquality|googleadservices|google\.com$/;
const byDomain = new Map();
for (const c of cookies) {
  const key = c.domain;
  if (!byDomain.has(key)) byDomain.set(key, []);
  byDomain.get(key).push(`${c.name}${c.session ? ' (session)' : ''}`);
}

console.log('COOKIES PRESENT AFTER TWO PAGE VIEWS, FROM A CLEAN PROFILE\n');
for (const [domain, names] of [...byDomain.entries()].sort()) {
  const tag = AD.test(domain.replace(/^\./, '')) ? '  ← ADVERTISING VENDOR' : '';
  console.log(`  ${domain.padEnd(34)} ${names.join(', ').slice(0, 90)}${tag}`);
}
const adCookies = cookies.filter((c) => AD.test(c.domain.replace(/^\./, '')));
console.log(`\n  total cookies: ${cookies.length}`);
console.log(`  advertising-vendor cookies: ${adCookies.length}`);

// First-party storage, which is what section 2.2's "functional" category describes.
const storage = await p.eval(`(() => {
  const keys = (s) => { try { return Object.keys(s); } catch { return ['(blocked)']; } };
  return { localStorage: keys(localStorage), sessionStorage: keys(sessionStorage) };
})()`);
console.log(`\n  first-party localStorage keys: ${storage.localStorage.length}`);
console.log(`    ${storage.localStorage.join(', ').slice(0, 220)}`);
const adKeys = storage.localStorage.filter((k) => /google|ads|adsense|gpt|sodar/i.test(k));
console.log(`  ad-related first-party keys: ${adKeys.length}${adKeys.length ? ' → ' + adKeys.join(', ') : ''}`);

console.log('\nVERDICT:');
console.log(adCookies.length > 0
  ? '  Advertising-vendor cookies ARE being set → section 2.2\'s "only two kinds" and its no-consent reasoning are contradicted today.'
  : '  No advertising-vendor cookie is set while placements are unfilled → section 2.2 remains accurate; only the "we do not display advertising" claims need correcting.');
p.close();
