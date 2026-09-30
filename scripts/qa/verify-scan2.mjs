import { attach, newTab } from './cdp.mjs';
const p = await attach(await newTab());
await p.viewport(1440, 900, false);
await p.goto('https://www.catalystpit.com/scan', { settleMs: 2500 });
await new Promise((r) => setTimeout(r, 2000));

const sections = await p.eval(
  "[...document.querySelectorAll('section')].map(s => (s.innerText||'').replace(/[\\s]+/g,' ').slice(0,180))"
);
console.log('board sections, as rendered:');
for (const s of sections || []) console.log('  •', s);

console.log('\nscan-board requests:');
console.log('  ' + (p.collected.responses.filter((r) => /scan-board/.test(r.url))
  .map((r) => r.status + ' ' + r.url.slice(-45)).join('\n  ') || 'none observed'));

console.log('\nably violations (matching the real endpoint only):',
  p.collected.consoleErrors.filter((e) => /main\.realtime\.ably\.net/.test(e)).length);
console.log('all distinct console errors:');
for (const e of new Set(p.collected.consoleErrors)) console.log('  -', String(e).slice(0, 110));
p.close();
