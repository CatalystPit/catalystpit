// PRODUCTION VERIFICATION OF THE ADSENSE CSP CHANGE.
//
// ⚠️ THE ONLY QUESTION THAT MATTERS IS WHETHER A REAL BROWSER STILL REPORTS VIOLATIONS. A CSP is
// enforced by the browser, so reading the header back and eyeballing it proves the deploy landed and
// nothing else. This loads the live pages and counts what Chrome actually blocked.
//
// It also re-checks the things a CSP edit is most likely to have broken on the way past: the Ably
// realtime connection, the Pit Wire feed, and /api/health.
import { attach, newTab } from './cdp.mjs';

const BASE = 'https://www.catalystpit.com';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);

// ⚠️ A VIOLATION IS IDENTIFIED BY THE BLOCKED URL, NOT BY ANY URL IN THE MESSAGE. Chrome's violation
// message quotes the entire offending directive after the blocked URL, so the message text contains
// every host in that directive. The first version of this function fell back to "first url anywhere in
// the string" and duly reported csi.gstatic.com and pagead2.googlesyndication.com as blocked on mobile
// when the only blocked resource was a Google frame. That is the same mistake, twice: a parser inventing
// findings out of the policy it is reading.
//
// The blocked URL is always inside the first pair of single quotes, and the directive name always follows
// the phrase "Content Security Policy directive:". Anchor on both, and accept nothing else.
const violations = (errs) => {
  const out = [];
  for (const e of errs) {
    if (!/Content Security Policy directive/i.test(e)) continue;
    const blocked = (e.match(/^[^']*'([^']+)'/) || [])[1];
    const directive = (e.match(/Content Security Policy directive: "([a-z-]+)/i) || [])[1] || '(unknown)';
    let host = blocked || '(unparsed)';
    try { host = new URL(blocked).host; } catch { /* keep the raw value */ }
    out.push({ host, directive, text: e.slice(0, 180) });
  }
  return out;
};

const p = await attach(await newTab());
await p.viewport(1440, 900, false);

L('the deployed header is the one that was committed');
{
  const r = await fetch(BASE + '/', { redirect: 'follow' });
  const csp = r.headers.get('content-security-policy') || '';
  ok('the response carries a CSP at all', csp.length > 100);
  ok('⚠️ pagead2.googlesyndication.com is in script-src',
    /script-src[^;]*https:\/\/pagead2\.googlesyndication\.com/.test(csp));
  ok('ep2.adtrafficquality.google is in script-src', /script-src[^;]*https:\/\/ep2\.adtrafficquality\.google/.test(csp));
  ok('googleads.g.doubleclick.net is in frame-src', /frame-src[^;]*https:\/\/googleads\.g\.doubleclick\.net/.test(csp));
  ok('ep2.adtrafficquality.google is in frame-src', /frame-src[^;]*https:\/\/ep2\.adtrafficquality\.google/.test(csp));
  ok('ep1.adtrafficquality.google is in connect-src', /connect-src[^;]*https:\/\/ep1\.adtrafficquality\.google/.test(csp));
  ok('⚠️ the Ably endpoints from the previous fix survived', /wss:\/\/\*\.ably\.net/.test(csp));
  ok('⚠️ no wildcard ad host was shipped',
    !/https:\/\/\*\.(googlesyndication|doubleclick|adtrafficquality|googleadservices)/.test(csp));
  ok('⚠️ unsafe-eval appears exactly once, as before', (csp.match(/'unsafe-eval'/g) || []).length === 1);
  ok('the directive count is nine', csp.split(';').map((d) => d.trim()).filter(Boolean).length === 9);
}

L('⚠️ a real browser reports no CSP violations on the public pages');
const seenHosts = new Map();
for (const path of ['/', '/screener', '/ticker/AAPL', '/insiders', '/politicians', '/terminal']) {
  await p.goto(BASE + path, { settleMs: 2200, ceilingMs: 30_000 });
  await new Promise((r) => setTimeout(r, 6500));   // the AdSense loader and Ably both connect late
  const v = violations(p.collected.consoleErrors);
  for (const x of v) seenHosts.set(x.host, (seenHosts.get(x.host) || 0) + 1);
  ok(`${path} — zero CSP violations`, v.length === 0, v.map((x) => x.host).join(', '));
  if (v.length) for (const x of v.slice(0, 4)) console.error(`         ${x.text}`);
  // Nothing may have thrown either: a blocked script often surfaces as an exception, not a CSP message.
  const hard = p.collected.pageErrors.filter((e) => !/ResizeObserver|Hydration/i.test(e));
  ok(`${path} — no uncaught page exception`, hard.length === 0, hard.slice(0, 2).join(' | '));
}
ok('⚠️ specifically, nothing from the AdSense hosts was blocked',
  ![...seenHosts.keys()].some((h) => /googlesyndication|doubleclick|adtrafficquality/.test(h)),
  [...seenHosts.keys()].join(', '));
ok('⚠️ and nothing from Ably was blocked',
  ![...seenHosts.keys()].some((h) => /ably/.test(h)), [...seenHosts.keys()].join(', '));

L('the AdSense verification tag now actually runs');
{
  await p.goto(BASE + '/', { settleMs: 2200, ceilingMs: 30_000 });
  await new Promise((r) => setTimeout(r, 7000));
  const r = await p.eval(`(() => ({
    tag: document.querySelectorAll('script[src*="adsbygoogle.js"]').length,
    globalDefined: typeof window.adsbygoogle !== 'undefined'
  }))()`);
  ok('the loader tag is on the page exactly once', r.tag === 1, String(r.tag));
  // ⚠️ THE REAL PROOF THE SCRIPT EXECUTED: adsbygoogle.js defines this global. A present <script> tag
  // proves only that the HTML shipped it; the CSP failure was that it never ran.
  ok('⚠️ …and it executed — window.adsbygoogle is defined', r.globalDefined === true);
  const gotLoader = p.collected.responses.filter((x) => /pagead2\.googlesyndication\.com.*adsbygoogle\.js/.test(x.url));
  ok('⚠️ …and the browser fetched it successfully, not blocked',
    gotLoader.length >= 1 && gotLoader.every((x) => x.status === 200),
    JSON.stringify(gotLoader.map((x) => x.status)));

  // ⚠️ AND NO AD IS ACTUALLY DISPLAYED, so Terms section 10 ("We do not display advertising on the
  // Service at this time") stays accurate. This is the check that catches the change turning ads on.
  //
  // Note what "not displayed" means here, precisely, because it is not "nothing exists": now that the
  // loader runs, auto-ads DO create one placement — an ins.adsbygoogle carrying
  // data-ad-status="unfilled" and a 0x0 aswift iframe. Nothing paints and nothing occupies layout. But
  // that is the account not filling, not the site declining to ask. If AdSense starts filling, ads WILL
  // render and that Terms sentence stops being true — an owner decision, flagged rather than assumed.
  const ads = await p.eval(`(() => {
    const f = [...document.querySelectorAll('iframe')].filter((x) => /aswift|google_ads/i.test(x.id + ' ' + (x.name || '') + ' ' + (x.src || '')));
    const big = (e) => { const b = e.getBoundingClientRect(); return b.width > 20 && b.height > 20; };
    const slots = [...document.querySelectorAll('ins.adsbygoogle')];
    return {
      frames: f.length, visibleFrames: f.filter(big).length,
      slots: slots.length, visibleSlots: slots.filter(big).length,
      statuses: slots.map((e) => e.getAttribute('data-ad-status'))
    };
  })()`);
  ok('⚠️ no ad frame is visible', ads.visibleFrames === 0, JSON.stringify(ads));
  ok('⚠️ no ad slot occupies any layout', ads.visibleSlots === 0, JSON.stringify(ads));
  ok('⚠️ every placement is unfilled — Terms §10 remains accurate today',
    ads.statuses.every((s) => s === 'unfilled' || s === null), JSON.stringify(ads.statuses));
}

L('the things a CSP edit could have broken on the way past');
{
  // ⚠️ THERE IS NO /wire ROUTE. The first version of this check fetched /wire, got the 404 page, and
  // called Pit Wire broken on a 938-character body. Pit Wire is a Terminal panel; its data comes from
  // /api/wire. Check both, at the places they actually exist.
  const api = await fetch(BASE + '/api/wire');
  const feed = await api.json().catch(() => null);
  const items = Array.isArray(feed) ? feed : (feed?.items || feed?.events || []);
  ok('/api/wire answers 200', api.status === 200, String(api.status));
  ok('⚠️ …with actual items, not an empty list dressed as success',
    Array.isArray(items) && items.length > 0, `${items?.length} items`);
  ok('…and the newest item carries a public timestamp',
    !!(items?.[0]?.published_at || items?.[0]?.publishedAt || items?.[0]?.publicTime),
    JSON.stringify(Object.keys(items?.[0] || {})).slice(0, 140));

  await p.goto(BASE + '/terminal', { settleMs: 2500, ceilingMs: 35_000 });
  await new Promise((r) => setTimeout(r, 8000));
  const wire = await p.eval(`(() => {
    const t = document.body.innerText;
    return {
      chars: t.length,
      saysBroken: /unavailable right now|failed to load|something went wrong/i.test(t),
      hasDated: /\\d{1,2}:\\d{2}|\\bago\\b|[A-Z][a-z]{2} \\d{1,2}/.test(t)
    };
  })()`);
  ok('the Terminal renders', wire.chars > 400, `${wire.chars} chars`);
  ok('…and nothing on it reports itself broken', wire.saysBroken === false);
  ok('…and it shows dated content', wire.hasDated === true);

  // Ably: the SDK connects from the chat surface. Confirm nothing was refused.
  const ablyResponses = p.collected.responses.filter((x) => /ably/.test(x.url));
  const ablyBlocked = p.collected.failed.filter((x) => /ably/.test(x));
  ok('⚠️ no Ably request failed', ablyBlocked.length === 0, ablyBlocked.slice(0, 2).join(' | '));
  const ablyState = await p.eval(`(() => ({
    sdk: typeof window.Ably,
    cdn: [...document.querySelectorAll('script')].some((s) => /cdn\\.ably\\.com/.test(s.src))
  }))()`);
  console.log(`         ably: ${JSON.stringify(ablyState)}, ably responses: ${ablyResponses.length}`);

  const h = await (await fetch(BASE + '/api/health')).json();
  ok('⚠️ /api/health reports healthy', h.ok === true && h.status === 'healthy',
    `${h.status} failing=${JSON.stringify(h.failing)}`);
  ok('…with nothing failing', Array.isArray(h.failing) && h.failing.length === 0, JSON.stringify(h.failing));
}

L('mobile, at the width the brief names');
{
  await p.viewport(390, 844, true);
  for (const path of ['/', '/ticker/MU']) {
    await p.goto(BASE + path, { settleMs: 2200, ceilingMs: 30_000 });
    await new Promise((r) => setTimeout(r, 6000));
    const v = violations(p.collected.consoleErrors);
    ok(`${path} @390px — zero CSP violations`, v.length === 0, v.map((x) => x.host).join(', '));
    const overflow = await p.eval('Math.max(0, document.documentElement.scrollWidth - window.innerWidth)');
    ok(`${path} @390px — no horizontal overflow`, overflow <= 1, `${overflow}px`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
p.close();
process.exit(fail ? 1 : 0);
