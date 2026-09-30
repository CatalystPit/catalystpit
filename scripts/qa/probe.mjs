// Targeted follow-ups on the findings the journey sweep surfaced.
import { attach, newTab } from './cdp.mjs';

const BASE = 'https://www.catalystpit.com';
const tab = await newTab();
const p = await attach(tab);
await p.viewport(390, 844, true);

// 1 ── Does a 404 logo end up as a visible broken image, or as the initials fallback?
await p.goto(`${BASE}/dividends`, { settleMs: 1500 });
await new Promise((r) => setTimeout(r, 2500));   // let React re-render the onError fallback
console.log('1. LOGO FALLBACK after settling');
console.log('  ', JSON.stringify(await p.eval(`(() => {
  const imgs = [...document.images];
  const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0);
  return {
    images: imgs.length,
    stillBroken: broken.length,
    brokenSrcs: broken.map((i) => (i.currentSrc || i.src).slice(-40)).slice(0, 4),
    // The fallback renders initials in a badge instead of an img.
    initialBadges: [...document.querySelectorAll('span,div')].filter((e) =>
      /^[A-Z0-9?]{1,2}$/.test((e.textContent || '').trim()) && e.children.length === 0).length,
  };
})()`)));

// 2 ── What does an anonymous reader actually see on /scan?
await p.goto(`${BASE}/scan`, { settleMs: 1200 });
console.log('\n2. /scan ANONYMOUS — the copy a reader sees');
console.log('  ', JSON.stringify(await p.eval(`(() => {
  const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
  return {
    len: t.length,
    text: t.slice(0, 420),
    hasUpgradeCta: /Upgrade|Go Pro|Start|Subscribe|Pit Pro/i.test(t),
    hasErrorWord: /(something went wrong|unavailable right now|could not load|failed to load|unexpected error)/i.test(t),
  };
})()`)));

// 3 ── Consensus and Terminal, the other two Pro surfaces.
for (const path of ['/consensus', '/terminal']) {
  await p.goto(`${BASE}${path}`, { settleMs: 1200 });
  console.log(`\n3. ${path} ANONYMOUS`);
  console.log('  ', JSON.stringify(await p.eval(`(() => {
    const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
    return { len: t.length, text: t.slice(0, 300), hasUpgradeCta: /Upgrade|Go Pro|Sign in|Start|Pit Pro/i.test(t) };
  })()`)));
}

// 4 ── Mobile navigation: does the hamburger open a usable menu?
await p.goto(`${BASE}/`, { settleMs: 1200 });
console.log('\n4. MOBILE NAV');
const burger = await p.eval(`(() => {
  const b = document.querySelector('.cp-nav-burger, [aria-label*="menu" i], [aria-label*="Menu"]');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { found: true, w: Math.round(r.width), h: Math.round(r.height), label: b.getAttribute('aria-label') };
})()`);
console.log('   burger:', JSON.stringify(burger));
if (burger) {
  await p.click('.cp-nav-burger, [aria-label*="menu" i], [aria-label*="Menu"]');
  await new Promise((r) => setTimeout(r, 700));
  console.log('   after tap:', JSON.stringify(await p.eval(`(() => {
    const links = [...document.querySelectorAll('a')].filter((a) => {
      const r = a.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < innerHeight;
    });
    // Tap targets under 40px tall are the mobile complaint worth measuring.
    const small = links.filter((a) => a.getBoundingClientRect().height < 32).length;
    return { visibleLinks: links.length, under32px: small,
      sample: links.slice(0, 8).map((a) => a.textContent.trim().slice(0, 18)) };
  })()`)));
}

// 5 ── Ticker page on mobile: does the identity render, and is the chart present?
await p.goto(`${BASE}/ticker/SPY`, { settleMs: 2000 });
console.log('\n5. /ticker/SPY MOBILE');
console.log('  ', JSON.stringify(await p.eval(`(() => {
  const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
  return {
    h1: [...document.querySelectorAll('h1')].map((h) => h.innerText.trim()).slice(0, 2),
    saysSpdr: /SPDR/i.test(t),
    saysNyse: /NYSE/i.test(t),
    hasChartFrame: !!document.querySelector('iframe[src*="tradingview"], canvas'),
    tabs: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((x) => x && x.length < 16).slice(0, 10),
  };
})()`)));

p.close();
