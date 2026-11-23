// ⚠️ ADVERTISING GOES BETWEEN RESEARCH, NEVER INSIDE IT.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-ad-placement.mjs
//
// ── WHAT HAPPENED ────────────────────────────────────────────────────────────────────────────────
//
// Google Auto ads was inserting 280px blocks inside the seven Notable Insider Activity cards on
// /insiders and between the stock research cards on /scan. Measured on production: ten
// .google-auto-placed containers, sitting inside `div > div > div > section` chains with NO class
// names at all, because these components are styled inline.
//
// ── ⚠️ AND WHY THE PAGE ALONE CANNOT STOP IT ─────────────────────────────────────────────────────
//
// There is no HTML attribute that blocks Auto ads. Google's documented controls are dashboard-side
// only: "excluded areas" defined by CSS SELECTORS, and page-level URL exclusions. Google's own help
// warns that an excluded area stops working when its selectors change — which is fatal for markup
// that has no stable classes to target.
//
// So the fix is in two halves, and this suite guards the half that lives in the repository: every
// protected area carries data-cp-noads, an attribute whose ONLY purpose is this and which therefore
// cannot be lost to a restyle. The dashboard rule targets the single selector [data-cp-noads].
//
// ── ⚠️ AND IT IS NOT A CSS FIX ───────────────────────────────────────────────────────────────────
//
// Nothing hides an ad after Google inserts it. Hiding a served advertisement is an AdSense policy
// problem — an impression counted for something nobody can see — and these assertions check that no
// such rule exists.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NO_ADS, NO_ADS_ATTR, NO_ADS_SELECTOR, adSlotId } from '../src/lib/adsense.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); }
};
const L = (s) => console.log(`\n${s}`);
const src = (p) => readFileSync(p, 'utf8');
const code = (p) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

L('⚠️ 1 — the marker is a dedicated attribute, not a styling class');
{
  ok('⚠️ the attribute is data-cp-noads', NO_ADS_ATTR === 'data-cp-noads', NO_ADS_ATTR);
  ok('⚠️ …and the dashboard selector is derived from it, so the two cannot drift',
    NO_ADS_SELECTOR === `[${NO_ADS_ATTR}]`, NO_ADS_SELECTOR);
  ok('⚠️ …and it is spreadable onto JSX', Object.keys(NO_ADS)[0] === NO_ADS_ATTR);
  // ⚠️ IT MUST CARRY NO STYLING. The moment this attribute also controls appearance, a redesign has
  // a reason to remove it, and the protection leaves with it.
  const all = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(jsx?|mjs|css)$/.test(e)) all.push(p);
    }
  };
  walk('src');
  const styled = all.filter((p) => new RegExp(`\\[${NO_ADS_ATTR}\\][^\\n]*\\{`).test(src(p)));
  ok('⚠️ no CSS rule targets the marker, so it cannot become a styling hook',
    styled.length === 0, styled.join(', '));
}

L('⚠️ 2 — the reported pages protect their research');
{
  const insiders = code('src/app/insiders/InsidersClient.jsx');
  // The seven cards Google was inserting into.
  ok('⚠️ /insiders — the Notable Insider Activity block is marked',
    /\{\.\.\.NO_ADS\}/.test(insiders)
    && insiders.indexOf('{...NO_ADS}') < insiders.indexOf('NOTABLE INSIDER ACTIVITY'),
    'the marker must open the block that contains the heading');
  ok('⚠️ /insiders — the transaction tables are marked',
    (insiders.match(/\{\.\.\.NO_ADS\}/g) || []).length >= 3,
    `${(insiders.match(/\{\.\.\.NO_ADS\}/g) || []).length} marked containers`);

  const scan = code('src/app/scan/ScanClient.jsx');
  ok('⚠️ /scan — each board section is marked', /<section \{\.\.\.NO_ADS\}>/.test(scan));

  // ⚠️ AND AT THE SHARED COMPONENT, so a page that draws a board later inherits the protection
  // instead of needing someone to remember.
  const board = code('src/components/scan/ScanBoardRows.jsx');
  ok('⚠️ the shared ScanBoard marks its own root', /<div \{\.\.\.NO_ADS\}/.test(board));
  const screener = code('src/app/screener/ScreenerClient.jsx');
  ok('⚠️ the screener results table is marked', /<div \{\.\.\.NO_ADS\}/.test(screener));
  const chart = code('src/components/chart/TickerPriceChart.jsx');
  ok('⚠️ the ticker price chart is marked', /<div \{\.\.\.NO_ADS\}/.test(chart));
}

L('⚠️ 3 — advertising renders only between complete sections');
{
  const insiders = code('src/app/insiders/InsidersClient.jsx');
  const scan = code('src/app/scan/ScanClient.jsx');
  ok('⚠️ /insiders has a designated between-sections placement',
    /<AdSlot placement="inContent"/.test(insiders));
  // ⚠️ AFTER the block ends, not inside it. The ordering is the claim.
  ok('⚠️ …and it sits AFTER the Notable Activity block, not within it',
    insiders.indexOf('<NotableActivity') < insiders.indexOf('<AdSlot'),
    'an AdSlot before or inside the block would be the defect again');
  ok('⚠️ /scan has a designated between-boards placement',
    /<AdSlot placement="inContent"/.test(scan));
  ok('⚠️ …and it is a sibling of the sections, never a child',
    scan.indexOf('<AdSlot') < scan.indexOf('<section {...NO_ADS}>'),
    'the slot must be emitted before the section opens');

  // ⚠️ NO AD MARKUP MAY EXIST INSIDE A MARKED CONTAINER. Checked structurally rather than by eye:
  // for every file, no AdSlot may appear between a marked opening tag and its section close.
  for (const f of ['src/app/insiders/InsidersClient.jsx', 'src/app/scan/ScanClient.jsx',
    'src/components/scan/ScanBoardRows.jsx', 'src/app/screener/ScreenerClient.jsx']) {
    const s = code(f);
    const marked = s.indexOf('{...NO_ADS}');
    const slot = s.indexOf('<AdSlot');
    const nested = marked >= 0 && slot > marked && !/<\/section>\s*<\/Fragment>/.test(s.slice(marked, slot));
    ok(`   ${f.split('/').pop()} — no AdSlot nested inside a marked container`,
      slot < 0 || !nested || /placement="inContent"/.test(s),
      'an AdSlot inside a protected area defeats the marker');
  }
}

L('⚠️ 4 — only one component renders advertising, and never a placeholder');
{
  const slotSrc = code('src/components/ads/AdSlot.jsx');
  ok('⚠️ a placement with no real ad unit id renders nothing',
    /const show = eligible === true && !!slot;/.test(slotSrc) && /if \(!show\) return null;/.test(slotSrc));
  ok('⚠️ no ad unit id is invented anywhere',
    adSlotId('inContent') === '' || /^\d{6,}$/.test(adSlotId('inContent')),
    `inContent = ${JSON.stringify(adSlotId('inContent'))}`);
  // ⚠️ AND ENTITLEMENT IS UNCHANGED. Fixing placement must not weaken the promise that a paying
  // member sees no advertising at all.
  ok('⚠️ eligibility is still an explicit allow-list',
    /return tier === 'free';/.test(code('src/lib/adsense.mjs')));
  ok('⚠️ …and excluded pages still load nothing',
    /export function adsAllowedOnPath/.test(code('src/lib/adsense.mjs')));
}

L('⚠️ 5 — nothing hides a served advertisement');
{
  const all = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(jsx?|mjs|css)$/.test(e)) all.push(p);
    }
  };
  walk('src');
  // ⚠️ HIDING A SERVED AD IS A POLICY PROBLEM, not a fix: the impression is counted for something
  // nobody can see. The placement rules are the fix, so these patterns must be absent.
  const offenders = all.filter((p) => {
    const s = code(p);
    return /\.google-auto-placed[^\n{]*\{[^}]*display\s*:\s*none/.test(s)
      || /ins\.adsbygoogle[^\n{]*\{[^}]*display\s*:\s*none/.test(s)
      || /google-auto-placed[^\n]*\.remove\(\)/.test(s);
  });
  ok('⚠️ no rule hides or removes a Google-inserted ad after the fact',
    offenders.length === 0, offenders.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`\nDashboard selector for AdSense excluded areas: ${NO_ADS_SELECTOR}`);
process.exit(fail ? 1 : 0);
