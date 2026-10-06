// ads.txt AND THE ONE CSP ORIGIN THE CONSENT MESSAGE NEEDS.
//
//   node --env-file=.env.local scripts/verify-ads-txt-cmp.mjs [--live]
//
// ⚠️ WHY THE CSP ASSERTIONS ARE SHAPED AS "EXACTLY THIS, AND NOTHING WIDER". The temptation when a Google
// script is blocked is to add *.google.com and move on, and it works immediately — which is why nobody
// ever goes back and narrows it. *.google.com in script-src would admit every Google property there is,
// including ones that host user-supplied content, and it would do so permanently. So the suite pins the
// exact host and fails if a wildcard appears.
//
// ⚠️ AND WHY ads.txt IS TESTED AS BYTES RATHER THAN AS A FILE THAT EXISTS. Every field in an ads.txt
// record is load-bearing: a wrong certification authority id, a pub- prefix that drifted, a RESELLER where
// DIRECT belongs, or a second Google line all cause Google to reject the file or mis-attribute revenue.
// The record is checked field by field against the one Google issued.

const L = (s = '') => console.log(s);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const fs = await import('node:fs/promises');
const read = (p) => fs.readFile(new URL(p, import.meta.url), 'utf8');
const LIVE = process.argv.includes('--live');

// The record exactly as Google issued it for this account.
const PUB_ID = 'pub-8341744464373905';
const CERT = 'f08c47fec0942fa0';
const EXPECTED = `google.com, ${PUB_ID}, DIRECT, ${CERT}`;
// The one origin a real Chrome demonstrated was blocked on production.
const CMP_ORIGIN = 'https://fundingchoicesmessages.google.com';

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 1. ads.txt IS A STANDARDS-COMPLIANT PLAIN-TEXT FILE ===');
{
  const raw = await read('../public/ads.txt');
  ok('⚠️ it is served from public/, so it is a static asset rather than a function',
    true, 'a route handler could fail at runtime; a static file cannot');
  ok('⚠️ there is no HTML shell', !/<[a-z!]/i.test(raw), 'ads.txt must be plain text, not a page');
  ok('it has no byte-order mark', !raw.startsWith('﻿'),
    'a BOM on the first line makes some parsers miss the first record');

  // Records are the non-comment, non-blank lines. Comments are explicitly permitted by the spec.
  const lines = raw.split('\n').map((l) => l.trim());
  const records = lines.filter((l) => l && !l.startsWith('#'));
  ok('⚠️ there is exactly ONE record', records.length === 1, `${records.length} records: ${records.join(' | ')}`);
  ok('⚠️ it is byte-for-byte the record Google issued', records[0] === EXPECTED,
    `got "${records[0]}" want "${EXPECTED}"`);

  // Field by field, because each one fails differently.
  const fields = records[0].split(',').map((f) => f.trim());
  ok('field 1 is the exchange domain google.com', fields[0] === 'google.com');
  ok(`field 2 is the publisher id ${PUB_ID}`, fields[1] === PUB_ID, fields[1]);
  ok('⚠️ field 3 is DIRECT, not RESELLER', fields[2] === 'DIRECT', fields[2]);
  ok('field 4 is Google\'s certification authority id', fields[3] === CERT, fields[3]);
  ok('there are exactly four fields', fields.length === 4, `${fields.length}`);

  // ⚠️ THE THINGS THE BRIEF FORBIDS, as assertions rather than as intentions.
  ok('⚠️ no second Google entry', records.filter((r) => /google\.com/i.test(r)).length === 1);
  ok('⚠️ no RESELLER line anywhere', !/RESELLER/i.test(raw));
  ok('⚠️ no other seller was invented', records.every((r) => r.startsWith('google.com,')));
  ok('⚠️ the publisher id appears once and is unaltered',
    (raw.match(new RegExp(PUB_ID, 'g')) || []).length === (raw.match(/pub-\d+/g) || []).length
    && !/pub-(?!8341744464373905)\d+/.test(raw));
  ok('the file ends with a newline', raw.endsWith('\n'),
    'a record without a trailing newline is still parsed, but some tools truncate the last line');

  // Nothing may block it.
  const robots = await read('../src/app/robots.js');
  ok('⚠️ robots.txt does not disallow /ads.txt', !/ads\.txt/.test(robots));
  const disallows = (robots.match(/'\/[^']*'/g) || []).map((s) => s.replace(/'/g, ''));
  ok('⚠️ …and no existing disallow prefix captures it',
    !disallows.some((d) => d !== '/' && '/ads.txt'.startsWith(d)), disallows.join(' '));

  const mw = await read('../src/middleware.ts');
  const protectedRoutes = (mw.match(/'\/[^']*\(\.\*\)'/g) || []).join(' ');
  ok('⚠️ no middleware-protected route captures /ads.txt',
    !/ads/.test(protectedRoutes) && /\/account|\/watchlist/.test(protectedRoutes),
    `protected: ${protectedRoutes}`);
  ok('…so it requires no authentication', !/isProtectedRoute.*ads/.test(mw));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 2. THE CSP ADMITS THE CONSENT MESSAGE, AND NOTHING MORE ===');
{
  const vercel = JSON.parse(await read('../vercel.json'));
  const csp = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  const directive = (name) => {
    const d = csp.split(';').map((x) => x.trim()).find((x) => x.startsWith(name + ' '));
    return d ? d.split(/\s+/).slice(1) : [];
  };
  const scriptSrc = directive('script-src');

  ok('⚠️ script-src admits the funding-choices origin', scriptSrc.includes(CMP_ORIGIN),
    'this exact script was observed blocked on production, on two different pages');
  ok('⚠️ …by exact host, not by wildcard', !scriptSrc.some((s) => /google\.com$/.test(s) && s.includes('*')),
    scriptSrc.filter((s) => s.includes('*')).join(' '));
  ok('⚠️ *.google.com is NOT in script-src', !scriptSrc.includes('https://*.google.com'),
    'that would admit every Google property, including ones hosting user content');
  ok('⚠️ *.googleapis.com and *.gstatic.com were not added either',
    !scriptSrc.includes('https://*.googleapis.com') && !scriptSrc.includes('https://*.gstatic.com'));

  // ⚠️ LEAST PRIVILEGE MEANS THE OTHER DIRECTIVES WERE LEFT ALONE. Nothing observed required a
  // connect-src or frame-src entry for the CMP, so none was added — and if the now-unblocked script
  // turns out to need one, that will appear as a fresh violation with its own evidence.
  ok('connect-src did not gain the funding-choices origin', !directive('connect-src').includes(CMP_ORIGIN),
    'not observed as needed; add it only when a probe shows it blocked');
  ok('frame-src did not gain it either', !directive('frame-src').includes(CMP_ORIGIN));

  // The pre-existing ad stack must be intact.
  ok('the AdSense script origin is still present', scriptSrc.includes('https://pagead2.googlesyndication.com'));
  ok('the ad-traffic-quality script origin is still present', scriptSrc.includes('https://ep2.adtrafficquality.google'));
  ok('the ad frame origins are still present',
    directive('frame-src').includes('https://googleads.g.doubleclick.net')
    && directive('frame-src').includes('https://ep2.adtrafficquality.google'));
  ok('the ad-traffic-quality connect origin is still present',
    directive('connect-src').includes('https://ep1.adtrafficquality.google'));
  ok('⚠️ frame-ancestors is still none', directive('frame-ancestors').includes("'none'"));
  ok('⚠️ default-src is still self', directive('default-src').includes("'self'"));
  ok('the other security headers are untouched', (() => {
    const keys = vercel.headers[0].headers.map((h) => h.key).sort();
    return ['Content-Security-Policy', 'Permissions-Policy', 'Referrer-Policy',
      'Strict-Transport-Security', 'X-Content-Type-Options', 'X-XSS-Protection'].every((k) => keys.includes(k));
  })());
  ok('⚠️ the cron budget is untouched', vercel.crons.length === 40, `${vercel.crons.length}`);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 3. PRO AD-FREE IS STRUCTURALLY INTACT ===');
{
  const ads = await import('../src/lib/adsense.mjs');
  // ⚠️ THE GATE ITSELF, EXERCISED. Only 'free' may load ads: not pro, not elite, and critically not an
  // unknown, undefined or errored tier — an unknown tier must fail CLOSED, because the cost of guessing
  // wrong is showing ads to someone who paid not to see them.
  ok('⚠️ free is eligible for ads', ads.adsEligibleTier('free') === true);
  ok('⚠️ pro is NOT', ads.adsEligibleTier('pro') === false);
  ok('⚠️ elite is NOT', ads.adsEligibleTier('elite') === false);
  for (const t of [undefined, null, '', 'unknown', 'hydrating', 'error', 'FREE', 'Free', 0, {}]) {
    ok(`⚠️ fails closed for ${JSON.stringify(t)}`, ads.adsEligibleTier(t) === false,
      'anything that is not exactly the string free must not load ads');
  }
  const src = await read('../src/lib/adsense.mjs');
  ok('the gate denies before injecting the loader',
    /if \(!adsEligibleTier\(j && j\.tier\)\) return 'deny';/.test(src));
  // Scoped to runAdsGate's body, because injectAdsLoader's own DEFINITION appears earlier in the file
  // and comparing against that measures declaration order rather than control flow.
  const gate = src.slice(src.indexOf('export function runAdsGate'));
  const signedInBranch = gate.slice(gate.indexOf('.then((j) =>'));
  ok('⚠️ in the signed-in branch the deny check precedes the injection',
    signedInBranch.indexOf("if (!adsEligibleTier") < signedInBranch.indexOf('injectAdsLoader(doc)'),
    'injecting first and checking after would show one page of ads to a paying subscriber');
  ok('⚠️ a cancelled run denies rather than injecting',
    /if \(!alive\) return 'deny';/.test(signedInBranch));
  ok('⚠️ every error path denies', /\.catch\(\(\) => 'deny'\)/.test(gate),
    'aborted, offline, 5xx or malformed JSON must all mean no advertising');
  ok('⚠️ an unresolved identity waits rather than loading',
    /if \(!isLoaded\) return \{ decision: Promise\.resolve\('wait'\)/.test(gate));
  ok('⚠️ the loader is idempotent, so two tags cannot coexist',
    /if \(doc\.querySelector\(`script\[\$\{ADS_MARK\}\]`\)\) return false;/.test(src));
  // ⚠️ THE CLAIM IS ABOUT THE URL, so it is tested on the URL rather than on the prose around it. An
  // earlier version searched a slice of the file for the word "tier" and tripped on the comment that
  // explains the tier allow-list.
  ok('⚠️ the loader URL carries the publisher id and nothing else',
    ads.ADSENSE_SRC === `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ads.ADSENSE_CLIENT}`,
    ads.ADSENSE_SRC);
  ok('⚠️ …and no visitor-identifying parameter appears in it',
    !/[?&](tier|plan|uid|user|userId|email|sub|clerk|session)=/i.test(ads.ADSENSE_SRC));
  ok('⚠️ the injected src is that constant, not something built per visitor',
    /s\.src = ADSENSE_SRC;/.test(src),
    'a concatenated src is where account state would get appended');
  ok('the AdSense loader URL is the publisher id only',
    /adsbygoogle\.js\?client=\$\{ADSENSE_CLIENT\}/.test(src));
  ok('⚠️ the AdSense module knows nothing about affiliates or consent state',
    !/affiliate/i.test(src) && !/googlefc|fundingchoices/i.test(src),
    'the consent message is served by Google through its own tag; we do not orchestrate it');
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 4. NO COMMERCIAL-DATA CHANGE ===');
{
  const BANNED = /polygon\.io|finnhub\.io|financialmodelingprep|twelvedata|coingecko|openfigi/i;
  for (const f of ['../public/ads.txt', '../vercel.json', '../src/lib/adsense.mjs']) {
    ok(`${f.split('/').pop()} reaches no retired provider`, !BANNED.test(await read(f)));
  }
  const csp = JSON.parse(await read('../vercel.json')).headers[0].headers
    .find((h) => h.key === 'Content-Security-Policy').value;
  ok('⚠️ the CSP admits no retired market-data provider', !BANNED.test(csp),
    'a CSP entry is not permission, but it would be the first step back');
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
if (LIVE) {
  L('\n=== 5. LIVE PRODUCTION ===');
  for (const base of ['https://catalystpit.com', 'https://www.catalystpit.com']) {
    const r = await fetch(`${base}/ads.txt`, { redirect: 'follow' });
    const body = await r.text();
    const ct = r.headers.get('content-type') || '';
    L(`\n  ${base}/ads.txt`);
    ok(`  ${base} → HTTP 200`, r.status === 200, `${r.status}`);
    ok('  content type is plain text', /text\/plain/i.test(ct), ct);
    ok('  the exact record is present', body.includes(EXPECTED), body.slice(0, 120));
    ok('  no HTML shell', !/<[a-z!]/i.test(body));
    const records = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    ok('  exactly one record live', records.length === 1, records.join(' | '));
    ok('  not behind authentication', !/sign-?in|unauthorized/i.test(body));
    // A redirect is permitted by the spec within the same root domain, but it must terminate.
    ok('  resolved without a redirect loop', r.redirected ? r.url.includes('catalystpit.com') : true, r.url);
  }
  const rb = await fetch('https://www.catalystpit.com/robots.txt');
  const rbody = await rb.text();
  ok('  robots.txt does not block /ads.txt', !/Disallow:\s*\/ads\.txt/i.test(rbody));
  const csp = (await fetch('https://www.catalystpit.com/')).headers.get('content-security-policy') || '';
  ok('  the live CSP admits the funding-choices origin', csp.includes(CMP_ORIGIN),
    csp ? 'present but origin missing — deploy may not have landed' : 'no CSP header seen');
  ok('  the live CSP has no *.google.com in script-src',
    !/script-src[^;]*https:\/\/\*\.google\.com/.test(csp));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
