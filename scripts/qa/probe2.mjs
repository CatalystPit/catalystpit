import { attach, newTab } from './cdp.mjs';
const BASE = 'https://www.catalystpit.com';
const tab = await newTab();
const p = await attach(tab);
await p.viewport(1440, 900, false);

// 1 ── The ticker page identity over TIME. The SSR shell may render the master's name and then be
// replaced by the client's /api/ticker answer — which is the difference between "the page is fine and
// only the API is wrong" and "the reader watches the name change to a bare ticker".
console.log('1. /ticker/SPY identity over time (production, pre-deploy)');
await p.send('Page.navigate', { url: `${BASE}/ticker/SPY` });
for (const wait of [400, 900, 1500, 2500, 4000]) {
  await new Promise((r) => setTimeout(r, wait === 400 ? 400 : 500));
  const s = await p.eval(`(() => {
    const h = document.querySelector('h1');
    return { t: ${wait}, h1: h ? h.innerText.replace(/\\n/g, ' | ').slice(0, 60) : null,
      exchangeLine: (() => {
        const el = [...document.querySelectorAll('div')].find((d) => /NASDAQ|NYSE|·/.test(d.textContent||'') && (d.textContent||'').length < 90 && d.children.length === 0);
        return el ? el.textContent.trim().slice(0, 60) : null;
      })() };
  })()`).catch(() => null);
  console.log('  ', JSON.stringify(s));
}

// 2 ── What exactly triggered the error-word match on /scan?
await p.goto(`${BASE}/scan`, { settleMs: 1500 });
console.log('\n2. /scan full anonymous text');
console.log(await p.eval(`(document.body.innerText || '').replace(/\\n+/g, ' \\u00b7 ').slice(0, 900)`));

// 3 ── Upgrade CTA presence on the Pro surfaces, measured as real clickable elements.
console.log('\n3. Pro-surface CTAs (anonymous)');
for (const path of ['/scan', '/consensus', '/terminal']) {
  await p.goto(`${BASE}${path}`, { settleMs: 1200 });
  const cta = await p.eval(`(() => {
    const els = [...document.querySelectorAll('a,button')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && /upgrade|go pro|pit pro|subscribe|start free|sign up|sign in|unlock/i.test(e.textContent || '');
    });
    return els.slice(0, 6).map((e) => (e.tagName + ':' + e.textContent.trim().slice(0, 28) + (e.getAttribute('href') ? ' -> ' + e.getAttribute('href') : '')));
  })()`);
  console.log(`   ${path}: ${cta.length ? cta.join(' | ') : 'NO upgrade/sign-in CTA found'}`);
}

// 4 ── Mobile menu tap targets, measured on the MENU only rather than the whole page.
await p.viewport(390, 844, true);
await p.goto(`${BASE}/`, { settleMs: 1200 });
await p.click('.cp-nav-burger, [aria-label="Menu"]');
await new Promise((r) => setTimeout(r, 700));
console.log('\n4. Mobile menu tap targets (the opened panel only)');
console.log('  ', JSON.stringify(await p.eval(`(() => {
  // The menu panel is whatever contains the nav links and sits above the fold after the tap.
  const panel = [...document.querySelectorAll('div')].filter((d) => {
    const links = d.querySelectorAll('a');
    return links.length >= 6 && links.length <= 30 && d.getBoundingClientRect().width <= 420;
  }).sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
  if (!panel) return { found: false };
  const links = [...panel.querySelectorAll('a,button')].map((a) => {
    const r = a.getBoundingClientRect();
    return { t: (a.textContent || '').trim().slice(0, 16), h: Math.round(r.height), w: Math.round(r.width) };
  }).filter((x) => x.h > 0);
  return { found: true, count: links.length,
    under32: links.filter((l) => l.h < 32).length,
    under24: links.filter((l) => l.h < 24).length,
    smallest: links.sort((a, b) => a.h - b.h).slice(0, 5) };
})()`)));

p.close();
