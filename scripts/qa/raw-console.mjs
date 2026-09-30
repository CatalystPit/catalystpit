// Dump the RAW console errors, unfiltered, so a parser cannot hide or invent a finding.
import { attach, newTab } from './cdp.mjs';

const p = await attach(await newTab());
const path = process.argv[2] || '/';
const mobile = process.argv[3] === 'mobile';
await p.viewport(mobile ? 390 : 1440, mobile ? 844 : 900, mobile);
await p.goto('https://www.catalystpit.com' + path, { settleMs: 2200, ceilingMs: 30_000 });
await new Promise((r) => setTimeout(r, 9000));

console.log(`=== ${path} ${mobile ? '@390px' : '@1440px'} — ${p.collected.consoleErrors.length} console errors ===`);
p.collected.consoleErrors.forEach((e, i) => console.log(`\n[${i}] ${e}`));
console.log(`\n=== ${p.collected.failed.length} failed requests ===`);
p.collected.failed.forEach((f) => console.log('  ' + f.slice(0, 160)));
p.close();
