// WHAT DOES THE REAL TICKER PAGE ACTUALLY RENDER?
//
//   node scripts/verify-ticker-composition.mjs
//
// ⚠️ WHY THIS EXISTS. verify-feature-availability renders TabBar on its own and asserts the array it
// walks. That is a real assertion, but it is not the page: production composes
//
//     TickerPage → Suspense → TickerBody → fetch('/api/ticker') → ValidView → TabBar + TabContent
//
// and NOTHING in the suite exercised that chain. A tab bar can be perfect in isolation while
// ValidView renders a second one, or while OverviewTab renders a section the flag was supposed to
// gate. This mounts the real default export with a real /api/ticker payload, lets the effects run,
// and reads the text a person would actually see.
//
// It is the client render on purpose. The ticker page server-renders a loading shell — every tab
// label and the whole Overview arrive after the fetch resolves — so SSR markup cannot answer this
// question, and asserting against it would pass while the live page showed all three modules. That
// is exactly the false negative that let this ship.

import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-composition');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// A REAL PAYLOAD, captured from /api/ticker rather than invented, so the page takes the same
// branches it takes in production. A hand-written stub is how you end up asserting against the
// error state and calling it a pass.
const PAYLOAD = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/ticker-aapl.json'), 'utf8'));

const stub = (name, body) => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, body);
  return f;
};

// The router records what it was asked to do, so the disabled-tab redirect can be asserted as
// BEHAVIOUR rather than as a source pattern.
//
// ⚠️ ITS STATE LIVES ON globalThis, NOT IN MODULE SCOPE. esbuild inlines this stub into the bundle,
// so importing it separately here hands back a DIFFERENT instance — setting the query string on that
// one changed nothing the page could see, and the call log I read stayed empty. Both failures looked
// exactly like "the redirect never fired". A single shared object cannot desynchronise that way.
const NAV_STUB = stub('next-nav.mjs', `
const bus = (globalThis.__cpNav ||= { search: '', calls: { push: [], replace: [] } });
// ⚠️ ONE STABLE ROUTER OBJECT, because that is what next/navigation gives you — it comes from
// context, so its identity holds across renders. Returning a fresh literal per call made every
// effect with the router in its dependency array re-run on every render, and the redirect assertion
// then reported two calls where the browser makes one. The stub was wrong, not the page.
const router = {
  push: (u) => bus.calls.push.push(u),
  replace: (u) => bus.calls.replace.push(u),
  refresh() {}, prefetch() {}, back() {},
};
export const useRouter = () => router;
export const useSearchParams = () => new URLSearchParams(bus.search);
export const usePathname = () => '/ticker/AAPL';
export const useParams = () => ({ symbol: 'AAPL' });
export const redirect = () => {}; export const permanentRedirect = () => {}; export const notFound = () => {};
export default {};
`);

const CLERK_STUB = stub('clerk.mjs', `
export const SignedIn = () => null; export const SignedOut = ({ children }) => children ?? null;
export const UserButton = () => null;
export const useAuth = () => ({ isLoaded: true, isSignedIn: false, userId: null });
export const useUser = () => ({ isLoaded: true, isSignedIn: false, user: null });
export const useClerk = () => ({ signOut: async () => {}, openUserProfile: () => {} });
export const ClerkProvider = ({ children }) => children ?? null;
export default {};
`);

const out = path.join(TMP, 'TickerPage.mjs');
await build({
  entryPoints: [path.join(ROOT, 'src/app/ticker/[symbol]/TickerPage.jsx')],
  bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  logLevel: 'silent', absWorkingDir: ROOT,
  alias: { 'next/navigation': NAV_STUB, '@clerk/nextjs': CLERK_STUB },
  define: { 'process.env.NEXT_PUBLIC_AFF_TRADINGVIEW': '"https://example.test/tv"',
    'process.env.NEXT_PUBLIC_AFF_BROKER': '"https://example.test/broker"',
    'process.env.NEXT_PUBLIC_AFF_UNUSUAL_WHALES': '"https://example.test/uw"' },
});

/**
 * Render the real page in a DOM and return the visible text.
 *
 * ⚠️ ALL THREE AFFILIATE PARTNER URLS ARE CONFIGURED above, deliberately. AffiliateStrip renders
 * nothing when none is set, so with an empty environment "Tools & offers is absent" would pass for
 * the wrong reason — it would be absent because it had no offers, not because the flag hid it. The
 * /api/me/plan probe is answered as a signed-out free user for the same reason: the strip hides
 * itself for Pro, which is another way to pass without the flag doing anything.
 */
async function renderPage({ search = '' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'https://catalystpit.test/ticker/AAPL', pretendToBeVisual: true });
  const { window } = dom;

  const fetched = [];
  window.fetch = async (url) => {
    fetched.push(String(url));
    const u = String(url);
    if (u.includes('/api/ticker')) return { ok: true, status: 200, json: async () => PAYLOAD };
    // A FREE viewer, so the ad-light perk cannot be what hides the strip.
    if (u.includes('/api/me/plan')) return { ok: true, status: 200, json: async () => ({ tier: 'free' }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'IntersectionObserver',
    'MutationObserver', 'CustomEvent', 'Event', 'DOMParser', 'SVGElement', 'Image',
    'localStorage', 'sessionStorage', 'matchMedia', 'devicePixelRatio', 'fetch']) {
    if (k === 'ResizeObserver' || k === 'IntersectionObserver') {
      window[k] = window[k] || class { observe() {} unobserve() {} disconnect() {} };
    }
    if (k === 'matchMedia') {
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    }
    // Node 24 defines `navigator` as a getter-only global, so it is assigned through
    // defineProperty rather than plain assignment, which throws on it.
    try { globalThis[k] = window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const bus = (globalThis.__cpNav ||= { search: '', calls: { push: [], replace: [] } });
  bus.search = search;
  bus.calls.push.length = 0; bus.calls.replace.length = 0;

  const mod = await import(`${pathToFileURL(out).href}?t=${Date.now()}`);
  const ReactDOMClient = await import('react-dom/client');
  const { act } = await import('react');

  let mountError = null;
  const container = window.document.getElementById('root');
  const root = ReactDOMClient.createRoot(container, {
    onUncaughtError: (e) => { mountError = mountError || e; },
  });
  await act(async () => { root.render(React.createElement(mod.default, { symbol: 'AAPL' })); });
  // The fetches resolve on microtasks; a couple of flushes lets TickerBody reach ValidView.
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });

  const text = container.textContent || '';
  return { text, mountError, fetched, calls: bus.calls, dom };
}

// ── 1. the real page mounts and reaches its loaded state ──────────────────────────────────────
console.log('\n1. the real page mounts and reaches its loaded state');

const main = await renderPage();
ok('the ticker page mounts without throwing', !main.mountError,
  main.mountError ? `${main.mountError.name}: ${main.mountError.message}` : '');
ok('...and asks /api/ticker for its data, as production does',
  main.fetched.some((u) => u.includes('/api/ticker')));
// ⚠️ THE POSITIVE CONTROL. Everything below is an absence, and an absence passes trivially if the
// page never got past its loading shell. This proves it did.
ok('...and rendered the LOADED page, not the loading shell',
  /Insider Trades/.test(main.text) && /Institutions/.test(main.text),
  `text was ${main.text.length} chars`);

// ── 2. the ten available tabs are all present ─────────────────────────────────────────────────
console.log('\n2. the ten available tabs are all present');

for (const label of ['Overview', 'News', 'Press Releases', 'Earnings', 'Dividends',
  'Insider Trades', 'Short Interest', 'Government Trades', 'Institutions', 'Financials']) {
  ok(`"${label}" is in the rendered page`, main.text.includes(label));
}

// ── 3. the three disabled modules render nowhere ───────────────────────────────────────────────
console.log('\n3. the three disabled modules render nowhere');

ok('"Guidance" appears nowhere in the rendered page', !/Guidance/i.test(main.text));
ok('"Analyst Ratings" appears nowhere in the rendered page', !/Analyst Ratings/i.test(main.text));
ok('"Tools & offers" appears nowhere in the rendered page', !/Tools\s*&\s*offers/i.test(main.text));
// The strip's own copy, in case the heading is ever reworded.
ok('no affiliate offer copy is rendered',
  !/Advanced charts on TradingView/i.test(main.text)
  && !/Fund a brokerage account/i.test(main.text)
  && !/Unusual Whales/i.test(main.text));
// ⚠️ AND IT IS NOT RENDERED-THEN-HIDDEN. A gated component must not be in the tree at all, so its
// links must not exist either — a display:none strip still ships the partner URLs to the client.
const anchors = [...main.dom.window.document.querySelectorAll('a[rel~="sponsored"]')];
ok('no sponsored links are in the DOM at all', anchors.length === 0, `found ${anchors.length}`);

// ── 4. a disabled tab in the URL lands on Overview ────────────────────────────────────────────
console.log('\n4. a disabled tab in the URL lands on Overview');

for (const [param, label] of [['tab=guidance', 'Guidance'], ['tab=analyst', 'Analyst Ratings']]) {
  const r = await renderPage({ search: param });
  ok(`?${param} still renders the loaded page`, /Insider Trades/.test(r.text));
  // The placeholder panel is what a reachable disabled tab looks like; its copy must not appear.
  ok(`?${param} does not render the ${label} panel`,
    !/Company-issued forward guidance/i.test(r.text) && !/Wall Street analyst ratings/i.test(r.text));
  // The Overview's own content is what it lands on instead.
  ok(`?${param} lands on Overview`, /Government trades/i.test(r.text) || /Insider/i.test(r.text));
  // And the address bar is corrected, without adding a history entry.
  ok(`?${param} replaces the URL rather than pushing one`,
    r.calls.replace.length === 1 && r.calls.push.length === 0,
    `replace=${JSON.stringify(r.calls.replace)} push=${JSON.stringify(r.calls.push)}`);
}

// A tab that IS available must be left alone — the redirect must not fire for everything.
const okTab = await renderPage({ search: 'tab=insider' });
ok('an available tab is not redirected', okTab.calls.replace.length === 0,
  JSON.stringify(okTab.calls.replace));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
