// Post-deploy verification of the three QA fixes, in the browser, against production.
import { attach, newTab } from './cdp.mjs';
const BASE = 'https://www.catalystpit.com';
const tab = await newTab();
const p = await attach(tab);
await p.viewport(1440, 900, false);

console.log('1. CSP — are the Ably violations gone?');
await p.goto(`${BASE}/`, { settleMs: 2500 });
await new Promise((r) => setTimeout(r, 2000));
const ably = p.collected.consoleErrors.filter((e) => /ably/i.test(e));
const adsense = p.collected.consoleErrors.filter((e) => /googlesyndication/i.test(e));
console.log(`   ably CSP violations: ${ably.length} ${ably.length ? '— STILL BLOCKED' : '— clear'}`);
console.log(`   adsense CSP violations: ${adsense.length} (separate, reported not fixed)`);
console.log(`   total console errors on homepage: ${new Set(p.collected.consoleErrors).size}`);

console.log('\n2. /scan anonymous — locked state, not an outage?');
await p.goto(`${BASE}/scan`, { settleMs: 1800 });
console.log('  ', JSON.stringify(await p.eval(`(() => {
  const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
  return {
    saysUnavailable: /Pit Scan is unavailable right now/.test(t),
    saysPitPro: /Live Pit Scan boards are part of Pit Pro/.test(t),
    hasUpgradeCta: !!/Unlock Pro|Start Free|Upgrade/i.exec(t),
    unavailableCount: (t.match(/unavailable right now/g) || []).length,
  };
})()`)));

console.log('\n3. /api/ticker identity for ETFs');
for (const t of ['SPY', 'QQQ', 'VOO', 'AAPL']) {
  const j = await p.eval(`fetch('/api/ticker?symbol=${t}').then(r => r.json()).then(j => ({ name: j.name, exchange: j.exchange }))`);
  console.log(`   ${t.padEnd(5)} name="${j.name}" exchange=${JSON.stringify(j.exchange)} ${j.name === t ? '<-- STILL THE BARE TICKER' : ''}`);
}

console.log('\n4. regression sweep — the surfaces the fixes touched');
for (const path of ['/', '/scan', '/consensus', '/terminal', '/ticker/SPY', '/ticker/AAPL', '/screener', '/dividends']) {
  const nav = await p.goto(BASE + path, { settleMs: 900 });
  const errs = new Set(p.collected.consoleErrors.filter((e) => !/googlesyndication/i.test(e)));
  const ours = p.collected.failed.filter((f) => /catalystpit\.com/.test(f) && !/\/api\/logo/.test(f));
  const h = await p.eval(`(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    textLen: (document.body.innerText||'').length }))()`);
  console.log(`   ${path.padEnd(16)} dom=${String(nav.domReadyMs).padStart(4)}ms text=${String(h.textLen).padStart(6)} overflow=${h.overflow}px consoleErr=${errs.size} httpFail=${ours.length}`);
  for (const e of [...errs].slice(0, 2)) console.log(`        ${e.slice(0, 150)}`);
  for (const f of ours.slice(0, 2)) console.log(`        ${f.slice(0, 120)}`);
}

p.close();
