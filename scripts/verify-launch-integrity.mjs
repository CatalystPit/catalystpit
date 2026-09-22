// LAUNCH INTEGRITY — the five things that must be true before anyone pays.
//
// These are not feature tests. Each one covers a specific way the product told a visitor something
// untrue: a price we do not charge, a scanner endpoint that answered "nothing" while the boards
// were full, an alert the feed can never fire, and a homepage card dated ten months in the future.
//
// Run: node scripts/verify-launch-integrity.mjs [--mutate=<mode>]

import fs from 'node:fs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

// lib/alerts.js cannot be imported here — it pulls in the Clerk/Next server runtime through ./db.
// The ALERT_TYPES literal is plain data, so it is read out of the source and evaluated on its own.
// That keeps the assertions against the real table rather than a copy that can drift.
function alertTypes() {
  const src = read('../src/lib/alerts.js');
  const start = src.indexOf('export const ALERT_TYPES = [');
  if (start < 0) throw new Error('ALERT_TYPES not found');
  const open = src.indexOf('[', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`return ${src.slice(open, end)}`)();
}
const ALERT_TYPES = alertTypes();
const CREATABLE_ALERT_TYPES = ALERT_TYPES.filter((t) => t.creatable !== false);

// These files document their own rules in prose, so "the code must not say X" has to be asked of
// the CODE. A comment explaining why we no longer render "AWAITING FEED" is not a render of it.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SRC_FILES = [
  '../src/app/consensus/ConsensusClient.jsx',
  '../src/app/insiders/InsidersClient.jsx',
  '../src/app/politicians/CongressTransactions.jsx',
  '../src/app/politicians/PoliticiansList.jsx',
  '../src/app/terminal/TerminalClient.jsx',
  '../src/app/ticker/[symbol]/TickerPage.jsx',
  '../src/components/AccountBilling.jsx',
  '../src/components/CatalystPit.jsx',
  '../src/app/feed/FeedClient.jsx',
];

// ── 1. PRICING ──────────────────────────────────────────────────────────────
//
// Every paywall quoted $12/mo, a price that is not what we charge. Nine occurrences across eight
// files, in two casings.
L('=== PRICING SAYS WHAT WE CHARGE ===');
{
  const all = SRC_FILES.map(read).join('\n');
  const stale = all.match(/\$12\s*\/\s*mo/gi) || [];
  ok('no surface still quotes the old monthly price',
    mut('oldprice') ? false : stale.length === 0, stale.join(', '));
  ok('…in either casing', !/\$12\/MO/i.test(all));
  ok('the monthly price is quoted', /\$20\/month/.test(all));
  ok('the yearly price is quoted where a yearly plan is offered',
    mut('noannual') ? false : /\$199\/year/.test(all));

  // The annual CTA and the annual price must appear together — an "or save yearly" button with no
  // amount, or an amount with no way to buy it, is a half-shipped plan.
  const home = read('../src/components/CatalystPit.jsx');
  const annualCta = /startCheckout\('annual'\)/.test(home);
  ok('the annual CTA exists', annualCta);
  ok('…and names its price', !annualCta || /\$199\/year/.test(home));

  // ⚠️ NO INVENTED PRICES. Stripe price IDs are env-only and are not touched by this ticket; the
  // displayed amount is copy, and the charge is whatever the ID says. Asserted so a future edit
  // does not start hard-coding amounts into the checkout call.
  const checkout = read('../src/app/api/stripe/checkout/route.js');
  ok('checkout still resolves its price from the environment',
    /process\.env\.STRIPE_PRICE_ID/.test(checkout));
  ok('…and hard-codes no amount',
    mut('hardcodedprice') ? false : !/\b(unit_amount|1200|2000|19900)\b/.test(checkout));
}

// ── 2. ONE SCAN API ─────────────────────────────────────────────────────────
//
// /api/pitscan returned `rows: []` — a literal empty list — while /api/scan-board read the real
// board. The Terminal panel called the empty one. An empty table reads as a quiet market.
L('\n=== THE SCAN ENDPOINT THE TERMINAL USES IS NOT AN EMPTY LIST ===');
{
  const pitscan = read('../src/app/api/pitscan/route.js');
  const scanBoard = read('../src/app/api/scan-board/route.js');
  const payload = read('../src/lib/scan/board-payload.js');

  ok('pitscan no longer returns a hard-coded empty rows list',
    mut('emptyrows') ? false : !/rows:\s*\[\s*\]\s*,[\s\S]{0,40}events:\s*\[\s*\]\s*,\s*\n\s*asOf/.test(pitscan));
  ok('…it builds rows from the shared board builder',
    mut('emptyrows') ? false : /buildScanBoardPayload/.test(pitscan), 'pitscan must call the builder');
  ok('…and serves those rows, not scanState\'s',
    /rows:\s*boardPayload\.rows/.test(pitscan));

  ok('scan-board uses the same builder', /buildScanBoardPayload/.test(scanBoard));
  ok('there is exactly ONE place a board is built',
    mut('twobuilders') ? false
      : /buildBoard\(/.test(payload) && !/buildBoard\(/.test(pitscan) && !/buildBoard\(/.test(scanBoard));

  // Both endpoints must agree about freshness, or the Terminal and the page disagree on screen.
  for (const [name, src] of [['pitscan', pitscan], ['scan-board', scanBoard]]) {
    ok(`${name} is never shared-cacheable`, /private, no-store/.test(src) && !/s-maxage/.test(src));
  }
  ok('pitscan carries the freshness of what it served', /freshnessLabel/.test(pitscan));

  // ⚠️ A READ NEVER COMPUTES. A Scan visitor must not be able to trigger a Consensus rebuild.
  ok('the builder reads the published board and never rebuilds it',
    mut('readcomputes') ? false
      : /readPublishedBoard\(\)/.test(payload) && !/rebuildBoard\(/.test(code(payload)));
}

// ── 3. THE TERMINAL PANEL NEVER CLAIMS LIVE ─────────────────────────────────
L('\n=== THE PANEL STATES THE FRESHNESS IT HAS ===');
{
  const panel = code(read('../src/components/scan/PitScanPanel.jsx'));
  ok('the panel never renders a LIVE badge',
    mut('claimslive') ? false : !/'LIVE'|>LIVE</.test(panel));
  ok('…nor still says it is awaiting a feed it now has',
    mut('awaitingfeed') ? false : !/AWAITING FEED/.test(panel));
  ok('…it prints the freshness the rows carry', /freshnessLabel/.test(panel));
}

// ── 4. ALERTS WE CANNOT FIRE ────────────────────────────────────────────────
//
// rvol_above and volume_above need consolidated live volume, which this entitlement does not
// carry. Offering them creates rules that sit forever without triggering — worse than not
// offering them, because the trader believes they are covered.
L('\n=== NO ALERT IS OFFERED THAT CANNOT FIRE ===');
{
  const unfireable = ['rvol_above', 'volume_above'];
  const creatableKeys = CREATABLE_ALERT_TYPES.map((t) => t.key);

  for (const k of unfireable) {
    ok(`${k} is not offered`, mut('offersunfireable') ? false : !creatableKeys.includes(k));
    const meta = ALERT_TYPES.find((t) => t.key === k);
    ok(`…${k} is still a known type, so stored rules survive`, !!meta);
    ok(`…and says why it is unavailable`, !!meta?.unavailable, meta?.unavailable);
  }

  // The ones that CAN fire must still be offered — this must not quietly empty the picker.
  for (const k of ['price_above', 'price_below', 'change_above', 'change_below', 'news', 'halt']) {
    ok(`${k} is still offered`, mut('overfilters') ? false : creatableKeys.includes(k));
  }
  ok('the picker is not empty', creatableKeys.length >= 6);

  // The API serves the creatable set, so a stale client cannot repopulate the picker.
  const route = read('../src/app/api/alerts/route.js');
  ok('the API serves only creatable types',
    mut('servesall') ? false : /types: CREATABLE_ALERT_TYPES/.test(route) && !/types: ALERT_TYPES/.test(route));

  // ⚠️ AND ENFORCED SERVER-SIDE. A direct POST must not be able to store an unfireable rule.
  const lib = read('../src/lib/alerts.js');
  ok('creation is refused server-side, not only hidden in the UI',
    mut('uionly') ? false : /CREATABLE_KEYS\.has\(type\)/.test(lib));

  // ⚠️ NO FAKE RVOL. The fix is to remove the offer, never to synthesise the number.
  ok('no relative-volume figure is fabricated to make them work',
    !/rvol\s*=\s*[\d.]/i.test(lib) && !/estimatedRvol|approxRvol|fakeRvol/i.test(lib));
}

// ── 5. THE HOMEPAGE CONGRESS CARD ───────────────────────────────────────────
//
// It ordered and displayed transaction_date, which is both a point-in-time violation and the
// reason the homepage led with SONY / Hon. Steve Cohen: transaction 2026-12-26 against a
// disclosure of 2026-02-09, a trade dated ten months after it was disclosed.
L('\n=== NO FUTURE-DATED CONGRESS ROW REACHES THE HOMEPAGE ===');
{
  const cron = read('../src/app/api/cron/pit-snapshot/route.js');
  const api = read('../src/app/api/politicians/route.js');
  const home = read('../src/components/CatalystPit.jsx');

  // Both paths — the snapshot cron and the live fallback the homepage uses when it is cold.
  for (const [name, src] of [['the snapshot cron', cron], ['the feed API', api]]) {
    ok(`${name} orders by disclosure, not transaction`,
      mut('sortbytransaction') ? false
        : /disclosureDate\} desc nulls last/.test(src) && !/transactionDate\} desc nulls last/.test(src));
    ok(`…${name} refuses a disclosure in the future`,
      mut('allowfuture') ? false : /disclosureDate\} <= current_date/.test(src));
    ok(`…${name} refuses a trade dated after its own disclosure`,
      mut('allowimpossible') ? false
        : /transactionDate\} <= \$\{congressTrades\.disclosureDate\}/.test(src));
  }

  ok('the hero card is dated by disclosure',
    mut('carddatestransaction') ? false : /date: cong\.disclosureDate/.test(cron));
  ok('…and so is the client fallback card', /date: pol\.disclosed/.test(home));
  ok('…which is skipped entirely when there is no disclosure date',
    mut('cardwithoutdate') ? false : /p\?\.sym && p\?\.disclosed/.test(home));

  // ⚠️ THE COLUMN MUST NAME THE DATE IT SHOWS. Rendering a disclosure date under "TRADED" would
  // swap one false claim for another.
  ok('the table column is labelled Disclosed',
    mut('mislabelled') ? false : /"Amount","Disclosed"/.test(home));
  ok('…and renders the disclosure date', /\{p\.disclosed\}/.test(home));
  ok('both dates are carried, each under its own name',
    /traded: p\.transactionDate/.test(home) && /disclosed: p\.disclosureDate/.test(home));
}

// ─── THE HOMEPAGE TEASER GATES KNOW WHO IS LOOKING ──────────────────────────
//
// ⚠️ THE BUG THESE COVER WAS NOT A BROKEN AUTH CHECK — IT WAS THE ABSENCE OF ONE. Both lock
// overlays were unconditional JSX. CatalystPit.jsx never imported Clerk, never read a session and
// never touched the `loggedIn` / `lockedCount` its own APIs returned, so a signed-in subscriber
// was told to sign in and no amount of upgrading changed the markup. Nothing failed, which is why
// nothing caught it: the component rendered exactly what it was written to render.
//
// So these assert the three states are DISTINGUISHED, not that a particular one looks right.
L('\n=== HOMEPAGE TEASER GATES ===');
{
  const home = read('../src/components/CatalystPit.jsx');
  const code = home.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok('the homepage reads the session at all',
    mut('noauth') ? false : /import\s*\{[^}]*\buseAuth\b[^}]*\}\s*from\s*["']@clerk\/nextjs["']/.test(code));
  ok('…through the canonical Clerk hook, not a second auth system',
    /const\s*\{\s*isLoaded\s*,\s*isSignedIn\s*\}\s*=\s*useAuth\(\)/.test(code));
  ok('…and the canonical per-user plan endpoint for entitlement',
    mut('noplan') ? false : /fetch\(\s*['"]\/api\/me\/plan['"]/.test(code));
  ok('…which is never cached across users', /\/api\/me\/plan['"]\s*,\s*\{\s*cache:\s*['"]no-store['"]/.test(code));

  // ⚠️ THE CORE OF THE BUG: "not Pro" must not be answered with "not signed in".
  ok('a signed-in user is never shown the sign-in call to action',
    mut('anonfallback') ? false
      : /const anon = !isSignedIn;/.test(code) && /anon \? ['"]\/sign-in['"]/.test(code));
  ok('…and the signed-out copy is reached only when actually signed out',
    /anon \? anonTitle/.test(code) && /anon \? ['"]Sign in['"]/.test(code));

  // Resolving is its own state. A flash of "sign in" at a signed-in user is the same lie, briefer.
  ok('the gate renders nothing while the session is resolving',
    mut('flashgate') ? false : /if \(!isLoaded\) return null;/.test(code));
  ok('…and nothing while the plan is still resolving',
    /if \(isSignedIn && tier === null\) return null;/.test(code));
  ok('a Pro subscriber sees no lock at all',
    mut('progated') ? false : /tier === ['"]pro['"] \|\| tier === ['"]elite['"]\)\) return null/.test(code));

  // ONE GATE, NOT TWO. The overlay existed twice as copied markup, which is how one bug shipped
  // to two sections; the fix only holds if they keep sharing the component.
  ok('the gate is a single shared component', /function HomeTeaserGate\(/.test(code));
  ok('…used by both Insider Trades and Politician Trades',
    (code.match(/<HomeTeaserGate/g) || []).length === 2);
  ok('…with no unconditional lock overlay left behind',
    mut('rawoverlay') ? false : !/Sign in to explore all (insider|politician) trades/.test(
      code.replace(/anonTitle="[^"]*"/g, '')));

  // Server-side entitlement is not weakened by any of this — the gate is presentation only.
  ok('the homepage still does not fetch gated rows itself',
    !/lockedCount\s*[:=]/.test(code));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
