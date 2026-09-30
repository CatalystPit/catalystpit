import { attach, newTab } from './cdp.mjs';
const BASE = 'https://www.catalystpit.com';
const tab = await newTab();
const p = await attach(tab);
await p.viewport(1440, 900, false);

// Count what a reader can actually see, by counting the ticker links inside the main record list
// rather than assuming a <table>. Insiders and Institutions render rows as divs.
console.log('ANONYMOUS RECORD CAPS — counted from the rendered DOM');
for (const [path, label] of [['/insiders', 'Insiders'], ['/politicians', 'Politicians'], ['/institutions', 'Institutions']]) {
  await p.goto(BASE + path, { settleMs: 2000 });
  await new Promise((r) => setTimeout(r, 1200));
  const r = await p.eval(`(() => {
    const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
    // Distinct /ticker/ links is the closest honest proxy for "records shown".
    const tickerLinks = new Set([...document.querySelectorAll('a[href^="/ticker/"]')].map((a) => a.getAttribute('href')));
    const memberLinks = new Set([...document.querySelectorAll('a[href^="/politicians/"], a[href^="/institutions/"]')].map((a) => a.getAttribute('href')));
    return {
      tickerLinks: tickerLinks.size,
      entityLinks: memberLinks.size,
      tableRows: Math.max(0, ...[...document.querySelectorAll('table')].map((x) => x.querySelectorAll('tbody tr').length)),
      lockedCopy: (t.match(/[\\d,]+\\s*(?:more|locked|hidden)/i) || [])[0] || null,
      cta: (t.match(/Start Free|Unlock Pro|Sign up/i) || [])[0] || null,
      saysDelayedOrClose: /LAST CLOSE|DELAYED|End of day|end-of-day/i.test(t),
      saysRealtime: /REAL-TIME|\\bLIVE\\b/.test(t),
    };
  })()`);
  console.log(`  ${label.padEnd(13)} tickerLinks=${String(r.tickerLinks).padStart(3)} entityLinks=${String(r.entityLinks).padStart(3)} tableRows=${String(r.tableRows).padStart(3)} locked="${r.lockedCopy}" cta="${r.cta}" claimsLive=${r.saysRealtime}`);
}

// Mobile navigation, measured directly on the opened menu.
await p.viewport(390, 844, true);
await p.goto(`${BASE}/`, { settleMs: 1500 });
console.log('\nMOBILE NAV (390px)');
const before = await p.eval(`[...document.querySelectorAll('a')].filter(a=>a.getBoundingClientRect().height>0).length`);
await p.click('[aria-label="Menu"]');
await new Promise((r) => setTimeout(r, 800));
const after = await p.eval(`(() => {
  const vis = [...document.querySelectorAll('a,button')].filter((a) => {
    const r = a.getBoundingClientRect();
    return r.height > 0 && r.top >= 0 && r.top < innerHeight && r.left >= 0;
  });
  const nav = vis.filter((a) => /^\\/(terminal|consensus|insiders|politicians|institutions|news|screener|scan|watchlist|dividends|heatmap|markets|leaderboard|feed|charts|crypto|fear-greed)/.test(a.getAttribute('href') || ''));
  const heights = nav.map((a) => Math.round(a.getBoundingClientRect().height));
  return { visible: vis.length, navLinks: nav.length, heights: heights.sort((a, b) => a - b).slice(0, 8),
    under32: heights.filter((h) => h < 32).length, under24: heights.filter((h) => h < 24).length,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
})()`);
console.log(`   links before tap: ${before}`);
console.log(`   after tap: ${JSON.stringify(after)}`);

p.close();
