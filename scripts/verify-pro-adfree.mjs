// THE PRO AD-FREE GUARD — EXECUTED, NOT READ.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-pro-adfree.mjs
//
// ⚠️ WHY A SUITE OF ITS OWN, AND WHY IT RUNS THE CODE. The Terms sell this: "Pro subscribers will not be
// shown advertising for as long as their subscription is active. This is part of what a Pro subscription
// buys." For the whole time that sentence has been published the loader was unconditional in the root
// layout, and the promise held only because Google's auto-ad placements happened to come back unfilled.
//
// A suite that greps for `if (!isLoaded) return` would have passed on the broken version too, because the
// broken version had no such line to contradict. So the gate is called here with a stub document and the
// question asked of every branch is the only one that matters: WAS A SCRIPT ELEMENT CREATED?
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import {
  runAdsGate, adsEligibleTier, ADSENSE_SRC, ADS_LOADER_SELECTOR,
  adsAllowedOnPath, AD_EXCLUDED_PREFIXES, adSlotId,
} from '../src/lib/adsense.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// ⚠️ COMMENTS STRIPPED FOR EVERY "IS ABSENT" CHECK. These files document what they replaced by quoting
// it, so an absence assertion against raw source fails on its own changelog. Learned the hard way twice.
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── a document just real enough to answer "was a script created?" ──────────────────────────────────
function stubDoc() {
  const created = [];
  const appended = [];
  return {
    created, appended,
    querySelector(sel) {
      // ⚠️ DEDUPE IS BY src NOW, not by a custom attribute. The attribute made AdSense warn, in
      // the live console on production: "AdSense head tag doesn't support data-cp-adsense
      // attribute." It was the only site-side complaint Google made about this integration, and it
      // was self-inflicted.
      return sel === ADS_LOADER_SELECTOR
        ? appended.find((e) => e.src === ADSENSE_SRC) || null : null;
    },
    createElement(tag) {
      const el = { tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
      created.push(el);
      return el;
    },
    head: { appendChild(el) { appended.push(el); } },
  };
}
const jsonRes = (body) => ({ ok: true, json: async () => body });
// ⚠️ A FAITHFUL HANG, WHICH MEANS IT HONOURS THE ABORT SIGNAL. A stub that simply never settles does not
// model fetch — real fetch REJECTS when its signal aborts, and that rejection is what the gate's timeout
// relies on to fail closed. Writing the stub the lazy way made this suite itself hang, which was a fair
// warning: a test that cannot terminate is not evidence of anything.
const never = (u, o) => new Promise((_, reject) => {
  o.signal.addEventListener('abort', () => reject(new Error('aborted')));
});

/** Run the gate and report what actually happened. */
async function gate(opts) {
  const doc = opts.doc || stubDoc();
  const calls = [];
  const fetchImpl = opts.fetchImpl || ((u, o) => { calls.push(u); return Promise.resolve(jsonRes({ tier: opts.tier })); });
  const { decision } = runAdsGate({
    isLoaded: opts.isLoaded !== false, isSignedIn: !!opts.isSignedIn,
    doc, fetchImpl, timeoutMs: opts.timeoutMs || 150,
  });
  const result = await decision;
  return { result, doc, calls, loaded: doc.appended.length > 0, created: doc.created.length };
}

L('⚠️ 1 — a Pro subscriber never gets a script element. The whole task, executed.');
{
  for (const tier of ['pro', 'elite']) {
    const r = await gate({ isSignedIn: true, tier });
    ok(`⚠️ ${tier}: decision is deny`, r.result === 'deny', r.result);
    ok(`⚠️ ${tier}: NO script element was created`, r.created === 0, `${r.created} created`);
    ok(`⚠️ ${tier}: …and nothing was appended to head`, !r.loaded);
    ok(`⚠️ ${tier}: …and no client-side entitlement state is left behind to go stale`,
      !/sessionStorage|localStorage/.test(code('src/lib/adsense.mjs')));
  }
  // ⚠️ REPEATED PAGE VIEWS MUST NOT DRIFT. Every load asks again, and every answer is deny.
  for (let i = 0; i < 3; i++) {
    const again = await gate({ isSignedIn: true, tier: 'pro' });
    ok(`⚠️ page view ${i + 1} of a Pro session still creates nothing`,
      again.result === 'deny' && again.created === 0);
  }
}

L('⚠️ 2 — unknown entitlement means no advertising');
{
  // ⚠️ THE RACE THE BRIEF NAMES: load the script, then discover the user is Pro. Once an advertising
  // script executes there is nothing to take back.
  const hydrating = await gate({ isLoaded: false, isSignedIn: true, tier: 'free' });
  ok('⚠️ mid-hydration: decision is wait', hydrating.result === 'wait');
  ok('⚠️ mid-hydration: nothing created even though the tier would allow it', hydrating.created === 0);
  ok('⚠️ …and no plan request was made either', hydrating.calls.length === 0);

  // Every way the lookup can fail must end in deny, not in a permissive default.
  const cases = {
    'endpoint 500': { fetchImpl: () => Promise.resolve({ ok: false, json: async () => ({ tier: 'free' }) }) },
    'endpoint offline': { fetchImpl: () => Promise.reject(new Error('network')) },
    'endpoint hangs past the ceiling': { fetchImpl: never },
    'endpoint returns junk': { fetchImpl: () => Promise.resolve(jsonRes({ nope: 1 })) },
    'endpoint returns null body': { fetchImpl: () => Promise.resolve(jsonRes(null)) },
    'endpoint returns unparseable json': { fetchImpl: () => Promise.resolve({ ok: true, json: async () => { throw new Error('bad json'); } }) },
    'endpoint returns a tier we do not know': { fetchImpl: () => Promise.resolve(jsonRes({ tier: 'enterprise' })) },
    'endpoint returns an empty tier': { fetchImpl: () => Promise.resolve(jsonRes({ tier: '' })) },
  };
  for (const [label, o] of Object.entries(cases)) {
    const r = await gate({ isSignedIn: true, ...o });
    ok(`⚠️ ${label} → deny, nothing created`, r.result === 'deny' && r.created === 0, `${r.result}/${r.created}`);
  }
  // ⚠️ AND A FAILURE IS NOT REMEMBERED AS PRO. Caching one bad response would cost a Free user a whole
  // session of advertising, so only a recognised paid tier is written.
  const failed = await gate({ isSignedIn: true, fetchImpl: () => Promise.reject(new Error('x')) });
  ok('⚠️ a failed lookup leaves no state behind at all', failed.result === 'deny' && failed.created === 0);
  const unknown = await gate({ isSignedIn: true, fetchImpl: () => Promise.resolve(jsonRes({ tier: 'enterprise' })) });
  ok('⚠️ …nor does an unrecognised tier', unknown.result === 'deny' && unknown.created === 0);
}

L('⚠️ 3 — and advertising is NOT broken for the people who should see it');
{
  const anon = await gate({ isSignedIn: false });
  ok('⚠️ signed out: decision is allow', anon.result === 'allow');
  ok('⚠️ signed out: the loader is created', anon.created === 1 && anon.loaded);
  ok('⚠️ signed out: …with the real AdSense src', anon.doc.appended[0].src === ADSENSE_SRC);
  ok('signed out: …async, so it cannot block paint', anon.doc.appended[0].async === true);
  ok('signed out: …anonymous crossOrigin, as Google\'s own snippet has',
    anon.doc.appended[0].crossOrigin === 'anonymous');
  ok('⚠️ signed out: …and it costs no plan request', anon.calls.length === 0);

  const free = await gate({ isSignedIn: true, tier: 'free' });
  ok('⚠️ free: decision is allow', free.result === 'allow');
  ok('⚠️ free: the loader is created', free.created === 1 && free.loaded);
  ok('free: …after exactly one plan request', free.calls.length === 1 && free.calls[0] === '/api/me/plan');

}

L('⚠️ 4 — entitlement transitions, in both directions');
{
  // ⚠️ THIS SECTION EXISTS BECAUSE THE FIRST IMPLEMENTATION FAILED IT. It cached the Pro deny in
  // sessionStorage to save a request; the cache was consulted before the fetch, so the branch that
  // cleared it on "free" was unreachable and a downgrade could not become eligible again for the rest of
  // the browser session. Mutation testing found it — deleting the clearing code changed nothing, which
  // is the signature of dead code. The cache is gone; every page load asks.
  const doc1 = stubDoc();
  const upgrade = [await gate({ isSignedIn: true, tier: 'free', doc: doc1 })];
  ok('FREE → PRO: while free, the loader is created', upgrade[0].created === 1);
  // A fresh document, as a real navigation gives.
  const afterUpgrade = await gate({ isSignedIn: true, tier: 'pro' });
  ok('⚠️ FREE → PRO: after the upgrade, the next page view creates nothing',
    afterUpgrade.result === 'deny' && afterUpgrade.created === 0);

  const beforeDowngrade = await gate({ isSignedIn: true, tier: 'pro' });
  ok('PRO → FREE: while pro, nothing is created', beforeDowngrade.created === 0);
  const afterDowngrade = await gate({ isSignedIn: true, tier: 'free' });
  ok('⚠️ PRO → FREE: after the downgrade, advertising is eligible again immediately',
    afterDowngrade.result === 'allow' && afterDowngrade.created === 1);

  // ⚠️ AND A RUN CANCELLED MID-FLIGHT DENIES. An identity change re-runs the effect; the outgoing run
  // must not inject on its way out, when we no longer know whose entitlement it answered for.
  const doc2 = stubDoc();
  let release;
  const { decision, cancel } = runAdsGate({
    isLoaded: true, isSignedIn: true, doc: doc2, timeoutMs: 5000,
    fetchImpl: () => new Promise((res) => { release = () => res(jsonRes({ tier: 'free' })); }),
  });
  // The gate reaches fetchImpl on a microtask, so give it one before cancelling — otherwise this
  // measures "cancelled before it started", which is a different and much weaker thing.
  await new Promise((r) => setTimeout(r, 0));
  ok('the in-flight request really is in flight', typeof release === 'function');
  cancel();
  release();   // the answer arrives AFTER the cancel, which is the case that matters
  ok('⚠️ a cancelled run denies even when the late answer would have allowed',
    (await decision) === 'deny' && doc2.created.length === 0);
}

L('⚠️ 5 — nothing is loaded twice, and nothing is loaded then removed');
{
  // ⚠️ THE BRIEF IS EXPLICIT THAT REMOVAL IS NOT A FIX: once the script runs, the request is made and
  // the cookie is set. So the gate must have no removal path at all — its presence would mean the real
  // mechanism was load-then-undo.
  const gateSrc = code('src/lib/adsense.mjs');
  const compSrc = code('src/components/AdSenseLoader.jsx');
  ok('⚠️ the gate never removes a script element', !/removeChild|\.remove\(\)/.test(gateSrc));
  ok('⚠️ …never hides ad DOM instead of preventing it',
    !/display\s*[:=]\s*['"]none/.test(gateSrc) && !/visibility/.test(gateSrc));
  ok('⚠️ …and never tries to disable ads by talking to the loaded script',
    !/pauseAdRequests/.test(gateSrc) && !/adsbygoogle\.push/.test(gateSrc));
  // Executed: a second run on the same document must not add a second loader.
  const doc = stubDoc();
  await gate({ isSignedIn: false, doc });
  await gate({ isSignedIn: false, doc });
  await gate({ isSignedIn: true, tier: 'free', doc });
  ok('⚠️ three eligible runs on one document create exactly one loader',
    doc.appended.length === 1, `${doc.appended.length} appended`);
}

L('⚠️ 6 — eligibility is an explicit allow-list, so a new tier defaults to no ads');
{
  // ⚠️ `tier !== 'pro'` WOULD HAVE BEEN THE OBVIOUS WAY TO WRITE THIS, and it fails in the direction
  // that breaks a promise we sell: add a tier, forget this line, and the new subscribers get ads.
  ok('free is eligible', adsEligibleTier('free') === true);
  ok('⚠️ pro is not', adsEligibleTier('pro') === false);
  ok('⚠️ elite is not', adsEligibleTier('elite') === false);
  for (const v of [undefined, null, '', 'Free', 'FREE', 'pro ', 'trial', 'enterprise', 0, false, {}, []]) {
    ok(`⚠️ ${JSON.stringify(v)} is not eligible`, adsEligibleTier(v) === false);
  }
  ok('⚠️ …and it is not written as a negation of pro',
    /return tier === 'free';/.test(code('src/lib/adsense.mjs'))
    && !/tier !== 'pro'/.test(code('src/lib/adsense.mjs')));
}

L('⚠️ 7 — the loader is not rendered unconditionally any more');
{
  const layoutCode = code('src/app/layout.jsx');
  // ⚠️ THE DEFECT ITSELF: an async script tag in the root layout head reached every visitor, Pro
  // included. Nothing about a Pro subscription touched it.
  ok('⚠️ no AdSense script tag is rendered in the root layout',
    !/<script[^>]*adsbygoogle/.test(layoutCode) && !/<script[^>]*ADSENSE_SRC/.test(layoutCode));
  ok('⚠️ …and no page or component renders one anywhere in src/',
    adScriptTags().length === 0, adScriptTags().join(', '));
  ok('the gated loader is mounted instead, exactly once',
    (layoutCode.match(/<AdSenseLoader \/>/g) || []).length === 1);
  // Ownership must survive for everyone, including the users who never load advertising.
  ok('⚠️ ownership is asserted by a meta tag, which makes no request and sets no cookie',
    /<meta name="google-adsense-account" content=\{ADSENSE_CLIENT\} \/>/.test(layoutCode));
  ok('…and the publisher id has one definition, shared',
    /export const ADSENSE_CLIENT/.test(code('src/lib/adsense.mjs'))
    && !/const ADSENSE_CLIENT = 'ca-pub/.test(layoutCode));
}

L('⚠️ 8 — one Pro detection system, and advertising never blocks the product');
{
  const gateSrc = code('src/lib/adsense.mjs');
  const compSrc = code('src/components/AdSenseLoader.jsx');
  const layoutCode = code('src/app/layout.jsx');
  ok('⚠️ the tier comes from the server endpoint', /'\/api\/me\/plan'/.test(gateSrc));
  ok('⚠️ …and not from the client session object',
    !/publicMetadata/.test(gateSrc) && !/publicMetadata/.test(compSrc));
  ok('…and it is not CDN-cached', /cache: 'no-store'/.test(gateSrc));
  const planRoute = code('src/app/api/me/plan/route.js');
  ok('⚠️ /api/me/plan resolves through the shared entitlement system',
    /resolveUserTier/.test(planRoute) && /lib\/entitlements/.test(planRoute));
  ok('…and never CDN-caches a per-user answer', /private, no-store/.test(planRoute));
  ok('⚠️ no second plan lookup was invented for advertising',
    !/clerkClient/.test(gateSrc) && !/getUser/.test(gateSrc) && !/stripe/i.test(gateSrc));
  // ⚠️ AND THE LAYOUT MUST NOT HAVE BECOME DYNAMIC. Resolving entitlement server-side in the root
  // layout would opt every page into dynamic rendering and put a Clerk round-trip in front of first
  // byte — the reason this is a client component at all.
  ok('⚠️ the root layout does not resolve entitlement',
    !/\bauth\(\)/.test(layoutCode) && !/resolveUserAccess|resolveUserTier/.test(layoutCode));
  ok('…and does not force dynamic rendering', !/force-dynamic/.test(layoutCode));
  ok('…the decision runs in an effect, after paint', /useEffect\(\(\) => \{/.test(compSrc));
  ok('…the component renders nothing', /return null;/.test(compSrc));
  ok('…the loader is mounted at the end of body, not in head',
    layoutCode.indexOf('<AdSenseLoader />') > layoutCode.indexOf('</head>'));
  // ⚠️ THE CLEANUP NOW DOES TWO THINGS, AND BOTH ARE LOAD-BEARING. It still cancels the in-flight
  // lookup, and it also marks the run superseded so the cancelled gate's late 'deny' is discarded
  // rather than published. Asserting only the cancel would let the second half be deleted silently.
  ok('…and the effect cancels in-flight work on unmount',
    /cancel\(\);/.test(compSrc) && /active = false;\s*cancel\(\);/.test(compSrc));
  // ⚠️ userId MUST BE IN THE DEPENDENCIES even though the gate no longer takes it: it is what makes an
  // identity change re-run the decision. Without it a session that changed under us keeps the
  // entitlement answer belonging to whoever was signed in before — a Free answer surviving into a Pro
  // session is precisely the failure this whole file exists to prevent. Mutation testing caught its
  // absence; nothing else would have.
  ok('⚠️ an identity change re-runs the decision',
    /\}, \[isLoaded, isSignedIn, userId, pathname\]\);/.test(compSrc));
  // ⚠️ AND SO DOES A NAVIGATION. Exclusion is per-page and an App Router navigation does not
  // remount this component, so without pathname a visitor who lands on /markets and then opens
  // /account keeps the eligible verdict from the page they left.
  ok('⚠️ …and so does a navigation to a different page',
    /usePathname\(\)/.test(compSrc) && /pathname\]\);/.test(compSrc));
}

/**
 * ⚠️ EVERY PLACE THAT RENDERS AD MARKUP, not just the one I remember writing.
 *
 * The entitlement gate is worth nothing if a second component grows its own ins element without
 * consulting it — the same shape of mistake as the loader that used to sit unconditionally in the
 * root layout, and the reason adScriptTags() below exists.
 */
function adInsElements() {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(new URL(`../${rel}`, import.meta.url))) {
      const q = `${rel}/${e}`;
      if (fs.statSync(new URL(`../${q}`, import.meta.url)).isDirectory()) { walk(q); continue; }
      if (!/\.(jsx?|mjs)$/.test(e)) continue;
      if (/className="adsbygoogle"|class="adsbygoogle"/.test(code(q))) out.push(q);
    }
  };
  walk('src');
  return out;
}

/** Any AdSense script TAG rendered in JSX anywhere in src/ — the gated injection is not a tag. */
function adScriptTags() {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(new URL(`../${rel}`, import.meta.url))) {
      const p = `${rel}/${e}`;
      if (fs.statSync(new URL(`../${p}`, import.meta.url)).isDirectory()) { walk(p); continue; }
      if (!/\.(jsx?|mjs)$/.test(e)) continue;
      if (/<script[^>]*(adsbygoogle|ADSENSE_SRC)/.test(code(p))) out.push(p);
    }
  };
  walk('src');
  return out;
}

L('⚠️ 9 — advertising is excluded from pages where it does not belong');
{
  // ⚠️ EXECUTED, NOT READ. A denylist is the kind of thing that looks right and matches nothing:
  // an exact-equality check passes every assertion written against '/account' and still serves an
  // ad on '/account/billing' — the one page where it would matter most, because that is where a
  // member goes to manage the subscription that removes advertising.
  for (const path of ['/account', '/account/billing', '/sign-in', '/sign-up/verify', '/checkout',
    '/billing/portal', '/api/me/plan']) {
    ok(`⚠️ no advertising on ${path}`, adsAllowedOnPath(path) === false);
  }
  // …and it must not have become a blanket refusal, which would satisfy every check above while
  // quietly removing advertising from the entire product.
  for (const path of ['/', '/markets', '/screener', '/insiders', '/politicians', '/institutions',
    '/news', '/scan', '/consensus', '/ticker/AAPL', '/fear-greed', '/heatmap', '/dividends',
    '/leaderboard', '/feed', '/crypto', '/charts']) {
    ok(`research page ${path} remains eligible`, adsAllowedOnPath(path) === true);
  }
  ok('⚠️ a prefix match, so sub-routes of an excluded page are excluded too',
    AD_EXCLUDED_PREFIXES.every((x) => adsAllowedOnPath(`${x}/anything/deeper`) === false));
  ok('…and a lookalike path is NOT excluded by accident',
    adsAllowedOnPath('/accounts-receivable') === true && adsAllowedOnPath('/billings') === true);
  ok('garbage in means no advertising, not a crash',
    adsAllowedOnPath(null) === false && adsAllowedOnPath('') === false
    && adsAllowedOnPath(undefined) === false);
}

L('⚠️ 10 — a placement with no ad unit id renders nothing');
{
  // ⚠️ AN AD UNIT ID CANNOT BE INVENTED. A fabricated data-ad-slot does not fail loudly: it renders
  // an empty ins that never fills, which is indistinguishable from the fill problem we are trying to
  // diagnose, and an empty unit is a policy smell besides. An unconfigured placement must therefore
  // be ABSENT from the page, not present and empty.
  const slotSrc = code('src/components/ads/AdSlot.jsx');
  ok('⚠️ the slot requires BOTH eligibility and a configured unit id',
    /const show = eligible === true && !!slot;/.test(slotSrc));
  ok('⚠️ …and renders nothing when either is missing', /if \(!show\) return null;/.test(slotSrc));
  ok('⚠️ no ad unit id is hardcoded in the component',
    !/data-ad-slot=["'][0-9]{6,}["']/.test(slotSrc));
  ok('…ids come from the environment, so none is invented in code',
    /process\.env\.NEXT_PUBLIC_ADSENSE_SLOT_/.test(code('src/lib/adsense.mjs')));
  ok('an unknown placement reports no id', adSlotId('definitely-not-a-placement') === '');
  ok('…and the publisher id is the shared one, not a second copy',
    /data-ad-client=\{ADSENSE_CLIENT\}/.test(slotSrc));
  // ⚠️ ONE PUSH PER ELEMENT. Pushing twice for one ins is the documented cause of "All ins elements
  // in the DOM with class=adsbygoogle already have ads in them", and in React a remount or a Strict
  // Mode double-effect gets you there without trying.
  ok('⚠️ it pushes at most once per element',
    /pushed\.current/.test(slotSrc) && /data-adsbygoogle-status/.test(slotSrc));
  ok('⚠️ …and a failed push cannot throw into a research page', /catch \{/.test(slotSrc));
  // ⚠️ NO RESERVED EMPTY BOX. A placeholder sized for an ad is the normal anti-CLS trick and is
  // wrong here: it would give a paying member a permanent empty gap as the visible residue of
  // advertising they pay not to have.
  ok('⚠️ nothing is reserved when no ad renders',
    slotSrc.indexOf('if (!show) return null;') < slotSrc.indexOf('<ins'));
}

L('⚠️ 11 — the shared decision is fail-closed, and no prerendered page carries ad markup');
{
  const store = code('src/lib/ads-eligibility.mjs');
  ok('⚠️ the server snapshot is always null, so static HTML never ships an ad',
    /export function getAdsEligibleServerSnapshot\(\) \{\s*return null;/.test(store));
  ok('⚠️ unknown is distinct from denied, and both render nothing',
    /value === null \? null : value === true/.test(store));
  ok('…the store imports nothing, so it adds no bootstrap cost', !/^\s*import\s/m.test(store));
  ok('⚠️ one subscriber throwing cannot strand the others on a stale answer',
    /try \{ fn\(\); \} catch/.test(store));

  const loaderSrc = code('src/components/AdSenseLoader.jsx');
  ok('⚠️ the page is checked before the visitor', /adsAllowedOnPath\(pathname\)/.test(loaderSrc));
  ok('⚠️ …and an excluded page publishes FALSE rather than leaving a stale verdict',
    /setAdsEligible\(false\);/.test(loaderSrc) && /return undefined;/.test(loaderSrc));
  // ⚠️ A SUPERSEDED RUN MUST PUBLISH NOTHING. cancel() makes the gate resolve 'deny' — right for
  // the run being torn down, wrong to publish. Navigating between two eligible pages would otherwise
  // be: new run publishes true, cancelled run's late 'deny' publishes false, and advertising is off
  // for the rest of the session with nothing in the page to explain why.
  ok('⚠️ a cancelled run cannot publish its late denial',
    /let active = true;/.test(loaderSrc) && /if \(!active\) return;/.test(loaderSrc));
  ok('⚠️ exactly one component in the product renders advertising markup',
    adInsElements().length === 1 && /AdSlot/.test(adInsElements()[0] || ''),
    adInsElements().join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
