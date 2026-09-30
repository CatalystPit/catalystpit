// PRODUCTION VERIFICATION OF THE ADVERTISING COPY CHANGE.
//
// ⚠️ READ THE RENDERED TEXT, NOT THE HTML. Both legal pages are client components; string-matching the
// served HTML can pass on markup a reader never sees and fail on copy that renders fine. This reads
// document.innerText after hydration, on desktop and at 390px, which is what a customer actually reads.
import { attach, newTab } from './cdp.mjs';

const BASE = 'https://www.catalystpit.com';
const DURABLE = 'The Service may display advertising provided by third-party advertising partners, including Google AdSense';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);

const p = await attach(await newTab());

const textOf = async (path, mobile) => {
  await p.viewport(mobile ? 390 : 1440, mobile ? 844 : 900, mobile);
  await p.goto(BASE + path, { settleMs: 1500, ceilingMs: 30_000 });
  await new Promise((r) => setTimeout(r, 2500));
  return p.eval('document.body.innerText.replace(/\\s+/g, " ")');
};

for (const mobile of [false, true]) {
  const label = mobile ? '@390px' : '@1440px';

  L(`/terms ${label}`);
  const terms = await textOf('/terms', mobile);
  ok('the durable sentence is rendered', terms.includes(DURABLE));
  ok('⚠️ the retired claim is gone', !/do not display advertising on the Service at this time/i.test(terms));
  ok('…and it does not claim ads are being shown now',
    /you may or may not see advertising on any particular visit/.test(terms));
  ok('the list intro is no longer conditional',
    /Where advertising appears:/.test(terms) && !/If and when advertising becomes active/i.test(terms));
  // ⚠️ THE TERMS OF SALE MUST BE UNTOUCHED — the brief ruled them out of scope explicitly.
  ok('⚠️ the Pro no-advertising promise is intact',
    /Pro subscribers will not be shown advertising for as long as their subscription is active/.test(terms));
  ok('…and separation from content is intact',
    /Advertisers do not influence our data, rankings, scores, or editorial content/.test(terms));
  ok('…and pricing is untouched', /\$20 per month/.test(terms) && /\$200 per year/.test(terms));
  ok('…and the affiliate and referral terms are untouched',
    /is not yet open/.test(terms) && /labelled as affiliate links at the point of display/.test(terms));
  ok('the document is re-dated', /Last updated: September 30, 2026/.test(terms));

  L(`/privacy ${label}`);
  const priv = await textOf('/privacy', mobile);
  ok('the durable sentence is rendered', priv.includes(DURABLE));
  ok('⚠️ the retired claims are gone',
    !/We do not currently display advertising/i.test(priv) && !/No ads are served to you today/i.test(priv));
  ok('⚠️ …including in the sharing section',
    !/no advertising vendor receives anything about you today/i.test(priv));
  ok('§2.4 explains the integration as advertising, not verification',
    /Google AdSense is integrated on Catalyst Pit/.test(priv) && !/verification script/i.test(priv));
  // ⚠️ THE MEASURED FACT: a .doubleclick.net cookie lands with nothing filled, so an empty placement
  // must not read as "no tracking".
  ok('⚠️ vendor cookies are disclosed even with no ad shown',
    /whether or not an advertisement is displayed to you/.test(priv));
  L(`  §2.2 cookies ${label}`);
  ok('⚠️ the false no-consent inference is gone',
    !/we do not ask you for cookie consent/i.test(priv)
    && !/Because the storage we use today is limited to the two categories above/i.test(priv));
  ok('⚠️ …replaced by the claim that is true', /We do not set advertising or cross-site tracking cookies ourselves/.test(priv));
  ok('⚠️ …and §2.2 discloses vendor cookies itself',
    /Third-party advertising partners, including Google, may set and read their own cookies/.test(priv));
  ok('⚠️ the consent commitment survives',
    /the law requires your consent before advertising or similar non-essential cookies are set, we will obtain it/.test(priv));
  ok('the two categories are still named', /Strictly necessary:/.test(priv) && /Functional:/.test(priv));
  // ⚠️ AND EVERYTHING THE BRIEF RULED OUT OF SCOPE IS STILL THERE.
  ok('⚠️ the opt-out routes are intact',
    /adssettings\.google\.com/.test(priv) && /optout\.aboutads\.info/.test(priv));
  ok('…the no-sale statement is intact', /We do not sell your personal information to third parties/.test(priv));
  ok('…the Pro promise is intact', /Pro subscribers will not be shown advertising/.test(priv));
  ok('…cookieless analytics is still disclosed accurately',
    /Vercel Web Analytics/.test(priv) && /It sets no cookies/.test(priv));
  ok('…and retention and the vendor list are untouched',
    /within 30 days/.test(priv) && /Ably/.test(priv) && /Resend/.test(priv));
  ok('the document is re-dated', /Last updated: September 30, 2026/.test(priv));

  L(`the pages a narrow change must not have touched ${label}`);
  const disc = await textOf('/disclaimer', mobile);
  ok('the Disclaimer still carries no advertising claim', !/advertis/i.test(disc));
  ok('…and is unchanged', /Last updated: May 17, 2026/.test(disc));
  const aff = await textOf('/affiliates', mobile);
  ok('the Affiliate terms carry no advertising claim', !/advertis/i.test(aff));

  L(`rendering and layout ${label}`);
  for (const path of ['/terms', '/privacy']) {
    await p.viewport(mobile ? 390 : 1440, mobile ? 844 : 900, mobile);
    await p.goto(BASE + path, { settleMs: 1500, ceilingMs: 30_000 });
    await new Promise((r) => setTimeout(r, 2000));
    const m = await p.eval(`(() => ({
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      chars: document.body.innerText.length,
      bold: document.querySelectorAll('strong').length
    }))()`);
    ok(`${path} — no horizontal overflow`, m.overflow <= 1, `${m.overflow}px`);
    ok(`${path} — the document renders in full`, m.chars > 6000, `${m.chars} chars`);
    ok(`${path} — emphasis styling survived`, m.bold > 10, `${m.bold} <strong>`);
    const hard = p.collected.pageErrors.filter((e) => !/ResizeObserver|Hydration/i.test(e));
    ok(`${path} — no uncaught exception`, hard.length === 0, hard.slice(0, 1).join(''));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
p.close();
process.exit(fail ? 1 : 0);
