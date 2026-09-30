// Root-cause the slow navigations rather than optimising on a number.
import { attach, newTab } from './cdp.mjs';
const BASE = 'https://www.catalystpit.com';
const tab = await newTab();
const p = await attach(tab);
await p.viewport(1440, 900, false);

const SLOW = ['/', '/dividends', '/politicians', '/ticker/SPY', '/leaderboard'];

for (const path of SLOW) {
  // WARM: navigate twice and report the second, which is what a returning reader experiences.
  await p.goto(BASE + path, { settleMs: 600 });
  const nav = await p.goto(BASE + path, { settleMs: 900 });

  // Per-request timing for our own API calls, which is where a multi-second page usually lives.
  const timings = await p.eval(`(() => {
    const es = performance.getEntriesByType('resource')
      .filter((e) => /\\/api\\//.test(e.name))
      .map((e) => ({ u: e.name.replace(location.origin, '').slice(0, 52), ms: Math.round(e.duration) }))
      .sort((a, b) => b.ms - a.ms);
    const nav = performance.getEntriesByType('navigation')[0] || {};
    return {
      ttfb: Math.round((nav.responseStart || 0) - (nav.requestStart || 0)),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
      slowest: es.slice(0, 6),
      apiCount: es.length,
      over500: es.filter((e) => e.ms > 500).length,
    };
  })()`);
  console.log(`\n${path}  warm=${nav.ms}ms  dom=${nav.domReadyMs}ms  ttfb=${timings.ttfb}ms  apiCalls=${timings.apiCount}  over500ms=${timings.over500}`);
  for (const s of timings.slowest) console.log(`    ${String(s.ms).padStart(5)}ms  ${s.u}`);
}

p.close();
