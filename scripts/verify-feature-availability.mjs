// ARE THE TEMPORARILY-DISABLED MODULES ACTUALLY HIDDEN — AND STILL INTACT?
//
//   node scripts/verify-feature-availability.mjs
//
// Three ticker-page surfaces are switched off pending data: Guidance, Analyst Ratings and the
// "Tools & offers" affiliate strip. Each was finished and each is KEPT; only its availability
// changed. That makes two failure modes worth pinning, and they pull in opposite directions:
//
//   1. It is still reachable. A tab hidden from the bar but honoured from ?tab= is not hidden — it
//      is just harder to find, and the user who finds it gets an empty panel.
//   2. It got deleted. A flag whose feature no longer exists cannot be flipped back, which defeats
//      the entire point of flagging it instead of removing it.
//
// So this asserts the gate AND the preservation. The tab arrays are imported and inspected, not
// pattern-matched: this bundles the real TickerPage and reads the array its tab bar walks.

import { build } from 'esbuild';
import { renderToString } from 'react-dom/server';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FEATURES, featureEnabled, tickerTabEnabled, TICKER_TAB_FEATURES }
  from '../src/lib/feature-availability.mjs';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── 1. the flag registry ──────────────────────────────────────────────────────────────────────
console.log('\n1. the flag registry');

ok('the three disabled modules are all declared in one place',
  ['guidance', 'analystRatings', 'toolsAndOffers'].every((k) => k in FEATURES));

// ⚠️ THESE THREE ARE INTENTIONALLY FALSE TODAY. Flipping one back on is a deliberate act, and it
// should land here as a failing assertion so the restore is reviewed rather than silent.
ok('Guidance is currently off', FEATURES.guidance === false);
ok('Analyst Ratings is currently off', FEATURES.analystRatings === false);
ok('Tools & offers is currently off', FEATURES.toolsAndOffers === false);

ok('an unknown feature name reads as off, never on', featureEnabled('no-such-feature') === false);
// A registry indexed by a caller's string must not inherit anything from Object.prototype.
ok('...and neither does a prototype key', featureEnabled('__proto__') === false
  && featureEnabled('constructor') === false && featureEnabled('toString') === false);
// Only an explicit true counts: a flag left as a truthy string or 1 is a mistake, not an enable.
ok('only an explicit boolean true enables a feature', (() => {
  FEATURES.__probe = 'yes';
  const truthyString = featureEnabled('__probe');
  FEATURES.__probe = 1;
  const truthyNumber = featureEnabled('__probe');
  delete FEATURES.__probe;
  return truthyString === false && truthyNumber === false;
})());

// ── 2. tabs follow the flags ──────────────────────────────────────────────────────────────────
console.log('\n2. tabs follow the flags');

ok('the gated tabs are the two disabled ones',
  Object.keys(TICKER_TAB_FEATURES).sort().join('|') === 'analyst|guidance');
ok('the Guidance tab is unavailable', tickerTabEnabled('guidance') === false);
ok('the Analyst Ratings tab is unavailable', tickerTabEnabled('analyst') === false);

// THE UNTOUCHED TABS. Named individually rather than counted, because "ten tabs are available" also
// passes if the wrong ten are.
const UNAFFECTED = ['overview', 'news', 'press', 'earnings', 'dividends',
  'insider', 'short', 'government', 'institutions', 'financials'];
for (const id of UNAFFECTED) {
  ok(`the ${id} tab is untouched`, tickerTabEnabled(id) === true);
}

// ⚠️ THE GATE READS THE FLAG — it is not a hardcoded false that happens to agree with it. Without
// this, someone could delete the flag entirely and every assertion above would still pass.
ok('flipping the flag restores the tab', (() => {
  FEATURES.guidance = true;
  const on = tickerTabEnabled('guidance');
  FEATURES.guidance = false;
  return on === true && tickerTabEnabled('guidance') === false;
})());

// ── 3. the tab bar walks the filtered list ────────────────────────────────────────────────────
console.log('\n3. the tab bar walks the filtered list');

const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-features');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// Next's router and Clerk are not what is under test; stubbed so the tab definitions are.
const stub = (name, body) => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, body);
  return f;
};
const NEXT_STUB = stub('next-stub.mjs', `
export const useRouter = () => ({ push() {}, replace() {} });
export const useSearchParams = () => new URLSearchParams();
export const usePathname = () => '/';
export const useParams = () => ({});
export const redirect = () => {}; export const permanentRedirect = () => {}; export const notFound = () => {};
export default {};
`);
const CLERK_STUB = stub('clerk-stub.mjs', `
export const SignedIn = () => null; export const SignedOut = ({ children }) => children ?? null;
export const UserButton = () => null;
export const useAuth = () => ({ isLoaded: true, isSignedIn: false, userId: null });
export const useUser = () => ({ isLoaded: true, isSignedIn: false, user: null });
export const useClerk = () => ({ signOut: async () => {}, openUserProfile: () => {} });
export const ClerkProvider = ({ children }) => children ?? null;
export default {};
`);

let TABS = null, VISIBLE_TABS = null, TabBar = null;
const out = path.join(TMP, 'TickerPage.mjs');
try {
  await build({
    entryPoints: [path.join(ROOT, 'src/app/ticker/[symbol]/TickerPage.jsx')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent', absWorkingDir: ROOT,
    alias: { 'next/navigation': NEXT_STUB, '@clerk/nextjs': CLERK_STUB },
  });
  const mod = await import(pathToFileURL(out).href);
  TABS = mod.TABS; VISIBLE_TABS = mod.VISIBLE_TABS; TabBar = mod.TabBar;
  ok('the ticker page bundles and exposes its tab definitions', Array.isArray(TABS) && Array.isArray(VISIBLE_TABS));
} catch (e) {
  ok('the ticker page bundles and exposes its tab definitions', false, `${e.name}: ${e.message}`);
}

// ⚠️ THE MARKUP, NOT THE ARRAY. VISIBLE_TABS being correct proves nothing if the bar still maps over
// TABS — which is exactly the mutation that slipped past an earlier version of this suite. So the
// real tab bar is rendered and its buttons are read back.
if (TabBar) {
  let html = '';
  try { html = renderToString(React.createElement(TabBar, { active: 'overview', onSelect: () => {} })); }
  catch (e) { ok('the tab bar renders', false, `${e.name}: ${e.message}`); }

  if (html) {
    // React splits adjacent text nodes with `<!-- -->` in SSR; stripped before matching.
    const text = html.replace(/<!--\s*-->/g, '');
    const labels = [...html.matchAll(/transparent[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
    ok('the rendered bar carries one button per available tab', labels.length === 10,
      `${labels.length}: ${labels.join(', ')}`);
    ok('...and they are exactly the ten unaffected tabs',
      labels.join('|') === 'Overview|News|Press Releases|Earnings|Dividends|Insider Trades|Short Interest|Government Trades|Institutions|Financials',
      labels.join('|'));
    // The two hidden labels must not appear ANYWHERE in the bar's markup — not as a button, not as
    // a title, not as disabled text.
    ok('the word Guidance does not appear in the rendered bar', !/Guidance/i.test(text));
    ok('the words Analyst Ratings do not appear in the rendered bar', !/Analyst/i.test(text));
    // And the tabs that stayed are genuinely still rendered, so "nothing appears" cannot pass by
    // the bar having rendered nothing at all.
    ok('the tabs that stayed are still in the bar',
      /Insider Trades/.test(text) && /Institutions/.test(text) && /Financials/.test(text));
  }
}

if (TABS && VISIBLE_TABS) {
  // PRESERVED: the full definition still describes all twelve tabs, so a restore puts the tab back
  // in its original position with its original label rather than appending a new one.
  ok('the full tab definition still describes all twelve tabs', TABS.length === 12);
  ok('...including Guidance, with its label intact',
    TABS.some((t) => t.id === 'guidance' && t.label === 'Guidance'));
  ok('...and Analyst Ratings, with its label intact',
    TABS.some((t) => t.id === 'analyst' && t.label === 'Analyst Ratings'));

  // HIDDEN: the list the bar actually renders.
  ok('the tab bar renders ten tabs, not twelve', VISIBLE_TABS.length === 10,
    `got ${VISIBLE_TABS.length}`);
  ok('Guidance is not among them', !VISIBLE_TABS.some((t) => t.id === 'guidance'));
  ok('Analyst Ratings is not among them', !VISIBLE_TABS.some((t) => t.id === 'analyst'));
  ok('and the ten are exactly the unaffected tabs, in the locked order',
    VISIBLE_TABS.map((t) => t.id).join('|') === UNAFFECTED.join('|'),
    VISIBLE_TABS.map((t) => t.id).join('|'));
  // The label text is what a reader scans for, so its absence is asserted too.
  ok('neither label survives anywhere in the rendered bar',
    !VISIBLE_TABS.some((t) => /guidance|analyst/i.test(t.label)));
}

// ── 4. nothing was deleted ────────────────────────────────────────────────────────────────────
console.log('\n4. nothing was deleted');

const page = read('src/app/ticker/[symbol]/TickerPage.jsx');

// The placeholder copy for both tabs is still here, so a restore has its wording back.
ok('the Guidance placeholder copy is preserved', /guidance:\s*'Company-issued forward guidance/.test(page));
ok('the Analyst Ratings placeholder copy is preserved', /analyst:\s*'Wall Street analyst ratings/.test(page));

// The affiliate strip is a component, not a block of inline markup, and it is still imported and
// still referenced — gated, not excised.
const stripExists = fs.existsSync(path.join(ROOT, 'src/components/AffiliateStrip.jsx'));
ok('AffiliateStrip.jsx is still on disk', stripExists);
// Guarded: a deleted component must be reported as the one failing assertion it is, not crash the
// suite on the next read and take every assertion after it down with it.
const strip = stripExists ? read('src/components/AffiliateStrip.jsx') : '';
ok('...with all three partner slots still configured',
  ['NEXT_PUBLIC_AFF_TRADINGVIEW', 'NEXT_PUBLIC_AFF_BROKER', 'NEXT_PUBLIC_AFF_UNUSUAL_WHALES']
    .every((k) => strip.includes(k)));
ok('...and its FTC disclosure still intact', /affiliate/i.test(strip));
ok('...and the ticker page still imports it', /import AffiliateStrip from/.test(page));

// The affiliate DISCLOSURE on /disclaimer is a standing statement about the business, not about this
// placement, and must not have been removed with the strip.
ok('the affiliate disclosure on /disclaimer is untouched',
  /may receive affiliate compensation/.test(read('src/app/disclaimer/DisclaimerClient.jsx')));

// ⚠️ THE `guidance` EVENT TYPE IS A DIFFERENT FEATURE. The news and evidence pipelines classify
// headlines as guidance events; that is live, unrelated, and must not have been gated by mistake.
for (const f of ['src/lib/x-relevance.mjs', 'src/lib/headline-compose.mjs', 'src/lib/impact.js']) {
  const src = read(f);
  ok(`${path.basename(f)} still classifies guidance events`, /guidance/.test(src)
    && !src.includes('feature-availability'));
}

// ── 5. the direct URL does not reach an empty page ────────────────────────────────────────────
console.log('\n5. the direct URL does not reach an empty page');

// Client side: a ?tab= naming a disabled module resolves to Overview, and the URL is corrected.
ok('a disabled ?tab= resolves to Overview', /tickerTabEnabled\(requested\) \? requested : 'overview'/.test(page));
ok('...and the address bar is corrected rather than left lying',
  /if \(tab !== requested\) router\.replace\(/.test(page));
// replace, not push: a URL the page refuses must not become a back-button stop.
ok('...by replacing the history entry, not pushing one',
  !/if \(tab !== requested\) router\.push\(/.test(page));

// Server side: the canonicalising 308 must not carry a disabled tab across the hop either.
const route = read('src/app/ticker/[symbol]/page.jsx');
ok('the canonicalising redirect drops a disabled tab',
  /tickerTabEnabled\(sp\.tab\) \? sp\.tab : undefined/.test(route));

// ⚠️ AND THE URL GRAMMAR STAYS PURE. ticker-symbol.mjs is asserted elsewhere to have no imports at
// all so it is safe in a client bundle; availability is a product question, not a grammar one, and
// answering it in there would break that contract.
ok('the URL grammar module took no dependency on the flags',
  !read('src/lib/ticker-symbol.mjs').includes('feature-availability'));

// ── 6. the affiliate strip render is gated ────────────────────────────────────────────────────
console.log('\n6. the affiliate strip render is gated');

ok('the strip is not rendered while the placement is off',
  /featureEnabled\('toolsAndOffers'\) \? <AffiliateStrip \/> : null/.test(page));
// Prevented from rendering, NOT hidden with CSS: a display:none strip still fetches /api/me/plan and
// still ships the partner URLs to the client.
ok('...by not rendering it, not by hiding it with CSS',
  !/AffiliateStrip[\s\S]{0,120}display:\s*'none'/.test(page));
ok('the strip is referenced exactly once, so there is no ungated second copy',
  (page.match(/<AffiliateStrip/g) || []).length === 1,
  `found ${(page.match(/<AffiliateStrip/g) || []).length}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
