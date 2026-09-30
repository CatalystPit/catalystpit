// PRODUCTION USER-JOURNEY QA — anonymous, desktop and mobile, in a real browser.
//
//   node scripts/qa/journey.mjs [--mobile] [--only=path,path]
//
// Walks the live site the way a reader does and records what a reader would actually see: console
// errors, uncaught exceptions, 4xx/5xx requests, horizontal overflow, broken images, empty panels,
// stuck loading states and the freshness claims on screen.
import { attach, newTab, PAGE_HEALTH } from './cdp.mjs';

const BASE = 'https://www.catalystpit.com';
const MOBILE = process.argv.includes('--mobile');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

const ROUTES = [
  ['/', 'Homepage'],
  ['/markets', 'Markets'],
  ['/news', 'News'],
  ['/screener', 'Screener'],
  ['/insiders', 'Insiders'],
  ['/politicians', 'Politicians'],
  ['/institutions', 'Institutions'],
  ['/consensus', 'Pit Consensus'],
  ['/scan', 'Pit Scan'],
  ['/terminal', 'Terminal'],
  ['/dividends', 'Dividends'],
  ['/heatmap', 'Heatmap'],
  ['/fear-greed', 'Fear & Greed'],
  ['/watchlist', 'Watchlist'],
  ['/leaderboard', 'Leaderboard'],
  ['/feed', 'Feed'],
  ['/charts', 'Charts'],
  ['/crypto', 'Crypto'],
  ['/ticker/AAPL', 'Ticker AAPL'],
  ['/ticker/MSFT', 'Ticker MSFT'],
  ['/ticker/NVDA', 'Ticker NVDA'],
  ['/ticker/MU', 'Ticker MU'],
  ['/ticker/SPY', 'Ticker SPY (ETF)'],
  ['/ticker/UNFI', 'Ticker UNFI (uncommon)'],
  ['/sign-in', 'Sign in'],
  ['/sign-up', 'Sign up'],
  ['/account', 'Account'],
  ['/settings', 'Settings'],
  ['/contact', 'Contact'],
  ['/disclaimer', 'Disclaimer'],
  ['/terms', 'Terms'],
  ['/privacy', 'Privacy'],
];

const routes = ONLY.length ? ROUTES.filter(([p]) => ONLY.includes(p)) : ROUTES;

const tab = await newTab();
const page = await attach(tab);
if (MOBILE) await page.viewport(390, 844, true); else await page.viewport(1440, 900, false);

console.log(`# ${MOBILE ? 'MOBILE 390px' : 'DESKTOP 1440px'} · anonymous · ${new Date().toISOString()}\n`);
const results = [];

for (const [path, name] of routes) {
  let nav, health, err = null;
  try {
    nav = await page.goto(BASE + path);
    health = await page.eval(PAGE_HEALTH);
  } catch (e) { err = e.message?.slice(0, 120); }

  const c = page.collected;
  // ⚠️ THIRD-PARTY NOISE IS NOT OUR DEFECT, and counting it as one buries the real ones. Widget and
  // analytics hosts are excluded from the failed-request tally; our own origin is not.
  const ours = (u) => /catalystpit\.com/.test(u) || u.startsWith('/');
  const ourFailed = [...new Set(c.failed.filter((f) => ours(f)))];
  const thirdPartyFailed = [...new Set(c.failed.filter((f) => !ours(f)))];
  const row = {
    path, name, err,
    ms: nav?.ms ?? null, domMs: nav?.domReadyMs ?? null, reqs: nav?.requests ?? null,
    title: health?.title, h1: health?.h1?.[0] || null,
    textLen: health?.textLen ?? 0,
    overflowPx: health?.overflowPx ?? null, wideEls: health?.wideEls || [],
    brokenImgs: health?.brokenImgs || [], imgCount: health?.imgCount ?? 0,
    sawLoading: health?.sawLoading, sawError: health?.sawError,
    saysRealtime: health?.saysRealtime, saysDelayed: health?.saysDelayed, saysTiingo: health?.saysTiingo,
    consoleErrors: [...new Set(c.consoleErrors)].slice(0, 4),
    pageErrors: [...new Set(c.pageErrors)].slice(0, 4),
    ourFailed, thirdPartyFailed: thirdPartyFailed.length,
  };
  results.push(row);

  const flags = [];
  if (err) flags.push(`NAV-ERR(${err})`);
  if (row.overflowPx > 2) flags.push(`OVERFLOW ${row.overflowPx}px`);
  if (row.textLen < 400) flags.push(`THIN ${row.textLen}ch`);
  if (row.brokenImgs.length) flags.push(`BROKEN-IMG ${row.brokenImgs.length}`);
  if (row.pageErrors.length) flags.push(`EXCEPTION ${row.pageErrors.length}`);
  if (row.consoleErrors.length) flags.push(`CONSOLE ${row.consoleErrors.length}`);
  if (row.ourFailed.length) flags.push(`HTTP ${row.ourFailed.length}`);
  if (row.sawError) flags.push('ERROR-TEXT');
  if (row.sawLoading) flags.push('STILL-LOADING');
  if (MOBILE ? row.ms > 4000 : row.ms > 3500) flags.push(`SLOW ${row.ms}ms`);

  console.log(`${flags.length ? 'FLAG' : ' ok '} ${path.padEnd(22)} ${String(row.ms ?? '-').padStart(5)}ms `
    + `dom=${String(row.domMs ?? '-').padStart(4)} reqs=${String(row.reqs ?? '-').padStart(3)} `
    + `text=${String(row.textLen).padStart(5)} ${flags.join(' · ')}`);
  for (const e of row.pageErrors) console.log(`        EXCEPTION: ${e}`);
  for (const e of row.consoleErrors) console.log(`        console: ${e}`);
  for (const f of row.ourFailed.slice(0, 4)) console.log(`        http: ${f}`);
  for (const w of row.wideEls.slice(0, 3)) console.log(`        wide: ${w}`);
  for (const b of row.brokenImgs.slice(0, 3)) console.log(`        img: ${b}`);
}

const { writeFileSync } = await import('node:fs');
const out = `${process.env.TEMP}/qa-${MOBILE ? 'mobile' : 'desktop'}.json`;
writeFileSync(out, JSON.stringify(results, null, 1));
console.log(`\nwrote ${out}`);

// ── SUMMARY ────────────────────────────────────────────────────────────────
const bad = results.filter((r) => r.err || r.overflowPx > 2 || r.brokenImgs.length || r.pageErrors.length
  || r.consoleErrors.length || r.ourFailed.length || r.sawError || r.textLen < 400);
console.log(`\n${results.length} routes · ${bad.length} with findings`);
const slow = results.filter((r) => r.ms > 2000).sort((a, b) => b.ms - a.ms);
console.log(`slowest: ${slow.slice(0, 5).map((r) => `${r.path} ${r.ms}ms`).join(', ') || 'none over 2s'}`);
page.close();
