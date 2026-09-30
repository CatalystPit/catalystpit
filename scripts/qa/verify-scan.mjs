import { attach, newTab } from './cdp.mjs';
const p = await attach(await newTab());
await p.viewport(1440, 900, false);
await p.goto('https://www.catalystpit.com/scan', { settleMs: 2000 });
await new Promise((r) => setTimeout(r, 1500));
const s = await p.eval(`(() => {
  const t = (document.body.innerText || '').replace(/\s+/g, ' ');
  return {
    saysUnavailable: /Pit Scan is unavailable right now/.test(t),
    unavailableCount: (t.match(/unavailable right now/g) || []).length,
    saysPitPro: /Live Pit Scan boards are part of Pit Pro/.test(t),
    stuckLoading: /Loading Pit Scan/.test(t),
    ctas: [...document.querySelectorAll('a,button')].filter((e) => /unlock pro|start free|sign in/i.test(e.textContent||'')).map((e)=>e.textContent.trim().slice(0,26)),
    rowsRendered: document.querySelectorAll('a[href^="/ticker/"]').length,
  };
})()`);
console.log('/scan anonymous:', JSON.stringify(s, null, 1));
const ablyErrs = p.collected.consoleErrors.filter((e) => /ably/i.test(e));
console.log('ably CSP violations on /scan:', ablyErrs.length);
await p.goto('https://www.catalystpit.com/', { settleMs: 2500 });
await new Promise((r) => setTimeout(r, 2500));
console.log('ably CSP violations on homepage:', p.collected.consoleErrors.filter((e) => /ably/i.test(e)).length);
console.log('total console errors on homepage:', new Set(p.collected.consoleErrors).size);
for (const e of new Set(p.collected.consoleErrors)) console.log('   ', String(e).slice(0, 130));
p.close();
