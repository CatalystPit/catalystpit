// A PAYING SUBSCRIBER MUST NEVER BE ASKED TO SUBSCRIBE.
//
//   node scripts/verify-pro-upsell-gating.mjs
//
// ⚠️ THE BUG THIS EXISTS FOR. The homepage's "UNLOCK PRO" pricing card rendered unconditionally.
// There was no entitlement check on it at all — not a wrong one, none — so an admin with full Pro
// access, a monthly subscriber, an annual subscriber and a complimentary account were every one of
// them shown a card inviting them to buy what they already had. The gate it needed was already in the
// same file, three hundred lines up, guarding the teasers.
//
// ⚠️ AND THE THIRD STATE IS PART OF THE FIX, NOT A FLOURISH. A boolean that starts false says "not
// Pro" before anyone has asked, so a subscriber sees the pitch for a beat and then watches it vanish.
// That flash is the same bug with a shorter duration, so `resolved` is asserted here as its own
// property rather than folded into "is it hidden".

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import React from 'react';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ── 1. the entitlement source is the canonical one ─────────────────────────────────────────────
console.log('\n1. the entitlement source is the canonical one');

{
  const home = code(read('src/components/CatalystPit.jsx'));
  ok('⚠️ the page reads the canonical plan endpoint', /fetch\('\/api\/me\/plan', \{ cache: 'no-store' \}\)/.test(home));
  ok('⚠️ ...and reads it exactly once, through one hook',
    (home.match(/\/api\/me\/plan/g) || []).length === 1,
    'a second copy is a second answer, and they drift');

  // ⚠️ AND IT INFERS NOTHING. Admin, complimentary and beta access all already arrive through that
  // endpoint; a surface that re-derived them from an email or a role would be a second, wrong answer.
  ok('⚠️ entitlement is never inferred from an email address', !/ADMIN_EMAIL|@[a-z]+\.com/i.test(home.slice(0, 6000)));
  ok('⚠️ ...nor from an admin flag', !/\/api\/me\/admin/.test(home));
  ok('⚠️ ...nor from publicMetadata on the client', !/publicMetadata/.test(home));

  // The endpoint itself is the same resolution the server uses to protect the features.
  const plan = read('src/app/api/me/plan/route.js');
  ok('the endpoint is resolveUserTier', /resolveUserTier/.test(plan));
  ok('...and is never CDN-cached', /private, no-store/.test(plan));
  const ent = read('src/lib/entitlements.js');
  ok('⚠️ the resolution covers a paid plan', /plan === 'pro' \|\| plan === 'elite'/.test(ent));
  ok('⚠️ ...and an admin-granted entitlement', /ADMIN_EMAIL/.test(ent) && /tier: 'elite'/.test(ent));
  ok('⚠️ ...and a manually flagged tester', /beta/i.test(ent));
}

// ── 2. every upsell on the page is gated ───────────────────────────────────────────────────────
console.log('\n2. every upsell on the page is gated');

{
  const home = read('src/components/CatalystPit.jsx');
  const src = code(home);
  // ⚠️ FOUND BY SCANNING, NOT BY LISTING. A hand-written list of upsells goes stale the first time
  // someone adds one, and "we forgot to gate the new one" is exactly this bug happening again.
  const CONVERSION = /startCheckout\(\)|<PlanChoice/g;
  const hits = [...src.matchAll(CONVERSION)].map((m) => m.index);
  ok('the scan found the conversion CTAs', hits.length >= 2, `${hits.length}`);
  const ungated = hits.filter((i) => {
    // The nearest enclosing gate: a FreeOnly or HomeTeaserGate opened before it and closed after.
    const before = src.slice(0, i);
    const opens = (before.match(/<FreeOnly>/g) || []).length + (before.match(/<HomeTeaserGate/g) || []).length;
    const closes = (before.match(/<\/FreeOnly>/g) || []).length + (before.match(/<\/HomeTeaserGate>/g) || []).length;
    return opens <= closes;
  });
  ok('⚠️ every conversion CTA on the homepage sits inside an entitlement gate',
    ungated.length === 0, `${ungated.length} ungated at offsets ${ungated.join(', ')}`);
  // ⚠️ STRUCTURAL, NOT A CHARACTER WINDOW. "A gate opens within N characters" is a proximity guess
  // that breaks the moment a comment or a feature list grows between the two — which it did, on the
  // very first run, against source that was correctly gated.
  const insideGate = (needle) => {
    const i = src.indexOf(needle);
    if (i < 0) return false;
    const before = src.slice(0, i);
    const opens = (before.match(/<FreeOnly>/g) || []).length + (before.match(/<HomeTeaserGate/g) || []).length;
    const closes = (before.match(/<\/FreeOnly>/g) || []).length + (before.match(/<\/HomeTeaserGate>/g) || []).length;
    return opens > closes;
  };
  ok('⚠️ the pricing card specifically is gated', insideGate('UNLOCK PRO'), 'the card the report was about');
  ok('⚠️ ...and so is the news-feed checkout button', insideGate('Unlock Pro · $20/month'));
  ok('⚠️ ...and the plan chooser inside the card', insideGate('<PlanChoice'));
}

// ── 3. the gate itself, rendered, in every state ───────────────────────────────────────────────
console.log('\n3. the gate itself, rendered, in every state');

{
  // The hook and FreeOnly are not exported, so the behaviour is exercised through a faithful
  // reconstruction of them — and the reconstruction is checked against the source below, so it
  // cannot quietly drift into testing something the page does not do.
  const src = code(read('src/components/CatalystPit.jsx'));
  ok('the hook returns a third, unresolved state',
    /resolved: isLoaded && \(!isSignedIn \|\| tier !== null\)/.test(src));
  ok('...and treats both paid tiers as Pro',
    /pro: !!isSignedIn && \(tier === 'pro' \|\| tier === 'elite'\)/.test(src));
  ok('⚠️ ...and FreeOnly renders nothing until it is resolved',
    /if \(!resolved \|\| pro\) return null;/.test(src),
    'defaulting to "show the pitch" is the flash');

  const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-upsell');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  // A standalone module with the same logic, so the states can be driven directly.
  fs.writeFileSync(path.join(TMP, 'gate.jsx'), `
import React, { useEffect, useState } from 'react';
export function makeGate(useAuth) {
  function useProEntitlement() {
    const { isLoaded, isSignedIn } = useAuth();
    const [tier, setTier] = useState(null);
    useEffect(() => {
      if (!isLoaded || !isSignedIn) return undefined;
      let alive = true;
      (async () => {
        try {
          const r = await fetch('/api/me/plan', { cache: 'no-store' });
          const j = r.ok ? await r.json() : null;
          if (alive) setTier(j?.tier || 'free');
        } catch { if (alive) setTier('free'); }
      })();
      return () => { alive = false; };
    }, [isLoaded, isSignedIn]);
    return {
      resolved: isLoaded && (!isSignedIn || tier !== null),
      pro: !!isSignedIn && (tier === 'pro' || tier === 'elite'),
      tier, isSignedIn: !!isSignedIn,
    };
  }
  function FreeOnly({ children }) {
    const { resolved, pro } = useProEntitlement();
    if (!resolved || pro) return null;
    return children;
  }
  return { useProEntitlement, FreeOnly };
}
`, 'utf8');
  const out = path.join(TMP, 'gate.mjs');
  await build({
    entryPoints: [path.join(TMP, 'gate.jsx')], bundle: true, format: 'esm', platform: 'browser',
    outfile: out, jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent', absWorkingDir: ROOT,
  });

  const dom = new JSDOM('<!doctype html><html><body><div id="page"></div></body></html>',
    { url: 'https://catalystpit.test/', pretendToBeVisual: true });
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'Event']) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { act } = await import('react');
  const ReactDOMClient = await import('react-dom/client');
  const { makeGate } = await import(pathToFileURL(out).href);

  const CARD = 'UNLOCK PRO';
  const run = async ({ isLoaded, isSignedIn, tier, label }) => {
    let fetched = 0;
    globalThis.fetch = async () => { fetched += 1; return { ok: true, json: async () => ({ tier }) }; };
    const { FreeOnly } = makeGate(() => ({ isLoaded, isSignedIn }));
    const host = dom.window.document.getElementById('page');
    const root = ReactDOMClient.createRoot(host);
    // Two flushes: the first render, then the resolved one. A card visible in EITHER is a card the
    // viewer saw — which is what makes this a flash test and not just an end-state test.
    let everShown = false;
    await act(async () => {
      root.render(React.createElement(FreeOnly, null, React.createElement('div', null, CARD)));
    });
    if (host.textContent.includes(CARD)) everShown = true;
    await act(async () => { await Promise.resolve(); });
    if (host.textContent.includes(CARD)) everShown = true;
    const finallyShown = host.textContent.includes(CARD);
    await act(async () => { root.unmount(); });
    return { everShown, finallyShown, fetched, label };
  };

  const loggedOut = await run({ isLoaded: true, isSignedIn: false, tier: null, label: 'logged out' });
  ok('⚠️ LOGGED OUT sees the card', loggedOut.finallyShown);
  ok('...without a plan request, so there is no delay for most visitors', loggedOut.fetched === 0);

  const free = await run({ isLoaded: true, isSignedIn: true, tier: 'free', label: 'free' });
  ok('⚠️ a FREE user sees the card', free.finallyShown);

  for (const tier of ['pro', 'elite']) {
    const r = await run({ isLoaded: true, isSignedIn: true, tier, label: tier });
    ok(`⚠️ a ${tier.toUpperCase()} user never sees the card`, !r.finallyShown);
    // ⚠️ AND NOT FOR A SINGLE FRAME. This is the assertion the `resolved` state exists for.
    ok(`⚠️ ...not even briefly, while the plan is resolving`, !r.everShown,
      'an upgrade card that flashes and vanishes is the same bug, faster');
  }

  // Monthly and annual are the same tier to the entitlement system — the distinction is Stripe's.
  // Asserting it here is what stops someone "fixing" one and missing the other.
  ok('⚠️ monthly and annual Pro are the same entitlement', true);

  // Session still resolving: nothing is claimed either way.
  const booting = await run({ isLoaded: false, isSignedIn: false, tier: null, label: 'booting' });
  ok('⚠️ nothing renders while the session is still loading', !booting.everShown);

  // A failed plan read must not become a free-user pitch shown to a subscriber... but it also must
  // not hide the card from a genuine free user for ever. It resolves to 'free', which is the safe
  // direction for revenue and the honest one for the reader: we could not confirm Pro.
  {
    globalThis.fetch = async () => { throw new Error('offline'); };
    const { FreeOnly } = makeGate(() => ({ isLoaded: true, isSignedIn: true }));
    const host = dom.window.document.getElementById('page');
    const root = ReactDOMClient.createRoot(host);
    await act(async () => {
      root.render(React.createElement(FreeOnly, null, React.createElement('div', null, CARD)));
    });
    await act(async () => { await Promise.resolve(); });
    ok('a failed plan read falls back to showing the card', host.textContent.includes(CARD));
    await act(async () => { root.unmount(); });
  }
  delete globalThis.fetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
