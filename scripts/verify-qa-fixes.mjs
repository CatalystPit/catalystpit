// THE THREE DEFECTS THE PRE-LAUNCH BROWSER QA FOUND, pinned so they cannot return.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-qa-fixes.mjs
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

L('⚠️ 1 — the realtime CSP allows the endpoint the SDK actually uses');
{
  const csp = JSON.parse(read('vercel.json')).headers
    .flatMap((h) => h.headers || []).find((h) => /Content-Security-Policy/i.test(h.key)).value;
  const connect = csp.split(';').find((d) => d.includes('connect-src'));
  // ⚠️ MEASURED FROM THE BROWSER, NOT GUESSED. ably-js 2.29 connects to main.realtime.ably.net; the
  // allowlist named only *.ably.io and *.ably-realtime.com, so every page logged two CSP violations
  // and the community chat could never connect. Both schemes matter — the token is https, the
  // connection is wss.
  ok('⚠️ https://*.ably.net is allowed', /https:\/\/\*\.ably\.net/.test(connect), connect);
  ok('⚠️ wss://*.ably.net is allowed', /wss:\/\/\*\.ably\.net/.test(connect));
  ok('…and the older fallback domains are kept', /\*\.ably\.io/.test(connect) && /\*\.ably-realtime\.com/.test(connect));
  ok('the SDK is still loaded from the allowed CDN', /https:\/\/cdn\.ably\.com/.test(csp)
    && /cdn\.ably\.com\/lib\/ably\.min-2\.js/.test(read('src/components/PitChat.jsx')));
  // Nothing else in the CSP was loosened.
  ok('default-src is still self', /default-src 'self'/.test(csp));
  ok('frame-ancestors is still none', /frame-ancestors 'none'/.test(csp));
}

L('⚠️ 2 — a Pro refusal renders as an entitlement state, never as an outage');
{
  const c = code('src/components/scan/ScanBoardRows.jsx');
  // ⚠️ THE MEASURED SYMPTOM: an anonymous visitor to /scan saw "Pit Scan is unavailable right now.
  // Try again" three times — once per board — because a 403 pro_required fell into the same branch as
  // a timed-out function. The first thing a prospective customer saw was the product calling itself
  // broken.
  ok('⚠️ a 401/403/pro_required is handled before the failure branch',
    /if \(r\.status === 401 \|\| r\.status === 403 \|\| j\?\.error === 'pro_required'\) \{/.test(c));
  ok('…and it sets a locked state rather than an error', /setLocked\(true\);\s*\n\s*setError\(null\);/.test(c));
  ok('…which the render treats as its own terminal state', /\{locked && !state \? \(/.test(c));
  ok('⚠️ …and the locked branch is reached BEFORE the error branch',
    c.indexOf('{locked && !state ?') < c.indexOf('error && !state ?'));
  ok('the locked copy does not say the product is unavailable',
    /Live Pit Scan boards are part of Pit Pro/.test(read('src/components/scan/ScanBoardRows.jsx')));
  ok('…and offers the existing shared upgrade CTA rather than a new one', /<LockedCta compact \/>/.test(c));
  // ⚠️ THE GENUINE OUTAGE PATH IS UNCHANGED, which is the half that must not regress.
  ok('a real failure still says so', /Pit Scan is unavailable right now\./.test(read('src/components/scan/ScanBoardRows.jsx')));
  ok('…and still offers a retry', /onRetry/.test(c));
  ok('…and a successful load clears the locked state', /setLocked\(false\);/.test(c));

  // ⚠️ AND THE STATE MUST LIVE WHERE IT IS RENDERED. The first version of this fix declared `locked`
  // inside useScanBoards and read it inside ScanBoard — a different function — so /scan threw
  // `ReferenceError: locked is not defined` during prerender and the Vercel build failed. A client
  // component is server-rendered first; a free identifier is a build break, not a runtime warning.
  ok('⚠️ locked is a declared prop of ScanBoard, not a free identifier',
    /export function ScanBoard\(\{ board, data, loading = false, errorText = null, locked = false,/.test(c));
  ok('…the hook exposes it', /return \{ boards, error, stale, locked, loading:/.test(c));
  ok('⚠️ …and a locked board is not also reported as loading',
    /loading: boards === null && error === null && !locked/.test(c));
  // ⚠️ BOTH CALL SITES, because /scan renders ScanBoard directly through ScanClient while the Terminal
  // goes through ScanBoardRows — and it was /scan that broke the build.
  for (const f of ['src/app/scan/ScanClient.jsx', 'src/components/scan/ScanBoardRows.jsx']) {
    const cc = code(f);
    ok(`${f} reads locked from the hook`, /locked[,}]/.test(cc) && /useScanBoards\(\)/.test(cc));
    ok('  …and passes it down to ScanBoard', /locked=\{locked\}/.test(cc));
  }
}

L('⚠️ 3 — the ticker API reads our own security master before naming a ticker after itself');
{
  const c = code('src/app/api/ticker/route.js');
  // ⚠️ THE ORDER WAS THE DEFECT. `if (quote.c > 0) return { name: sym }` sat second, so every ETF —
  // which no vendor profile names — resolved to its own ticker and short-circuited before any identity
  // lookup. /api/ticker?symbol=SPY returned name "SPY", exchange null, while security_identity held
  // "SPDR S&P 500 ETF TRUST" and screener_meta held NYSE.
  ok('the master is consulted before the bare-symbol fallback',
    c.indexOf('const master = await masterIdentity(sym);') < c.indexOf('if (quote && quote.c > 0)'));
  ok('…and after the provider profile, which still wins when it answers',
    c.indexOf('if (profile.name)') < c.indexOf('const master = await masterIdentity(sym);'));
  // ⚠️ MATCHED ON THE TABLE NAMES, not on the exact column alignment — the SQL is formatted with
  // padding to line the joins up, and a regex that encodes that spacing breaks on any reformat.
  ok('the master reads the identity table', /join security_identity i on i\.ticker = k\.t/.test(c));
  ok('…and the meta table, for the exchange the vendor omits', /join screener_meta\s+m on m\.ticker = k\.t/.test(c));
  ok('…and the screener company as a third fallback', /join screener_stocks\s+s on s\.ticker = k\.t/.test(c));
  ok('…and it never throws into the page', /catch \{ return \{ name: null, exchange: null/.test(c));
  ok('⚠️ the exchange falls back to the master too', /exchange: prof\.value\?\.exchange \?\? v\.master\?\.exchange \?\? null/.test(c));
  ok('…and the bare-symbol branch is kept as a last resort', /if \(quote && quote\.c > 0\) return \{ valid: true, name: sym/.test(c));

  // ⚠️ EXERCISED AGAINST THE REAL TABLES, because the whole point is that we already knew the answer.
  const { rows } = { rows: await sql`select i.ticker, i.name, m.exchange, m.asset_type
    from security_identity i left join screener_meta m on m.ticker = i.ticker
    where i.ticker in ('SPY','QQQ','VOO','IWM','DIA')` };
  ok('our own tables name the major ETFs', rows.length >= 4, `${rows.length} of 5`);
  for (const r of rows) {
    ok(`  ${r.ticker}: the master has a real name, not the ticker`, r.name && r.name !== r.ticker, String(r.name));
    ok(`  ${r.ticker}: …and an exchange`, !!r.exchange, String(r.exchange));
  }
  const etfs = await sql`select count(*)::int n from screener_meta m join security_identity i on i.ticker=m.ticker
    where m.asset_type = 'ETF' and i.name is not null and i.name <> m.ticker`;
  ok('⚠️ the gap this closed covers thousands of securities, not a handful', etfs[0].n > 4000, `${etfs[0].n} named ETFs`);
}

L('⚠️ 4 — the AdSense loader is permitted by exactly what it needs');
{
  const csp = JSON.parse(read('vercel.json')).headers
    .flatMap((h) => h.headers || []).find((h) => /Content-Security-Policy/i.test(h.key)).value;

  // ⚠️ MEASURED, NOT COPIED FROM A RECIPE. The site has ONE AdSense script tag and no ad slots, so the
  // usual dozen-domain allowlist would be permission it does not use. Each host below was observed being
  // requested by the loader with Page.setBypassCSP enabled, and placed in the directive matching the
  // browser's own reported resource type.
  ok('⚠️ the loader host is allowed as a script', /script-src[^;]*https:\/\/pagead2\.googlesyndication\.com/.test(csp));
  ok('…and sodar2.js, which the loader pulls in', /script-src[^;]*https:\/\/ep2\.adtrafficquality\.google/.test(csp));
  ok('the zrt_lookup frame is allowed as a frame', /frame-src[^;]*https:\/\/googleads\.g\.doubleclick\.net/.test(csp));
  ok('…and the sodar runner frame', /frame-src[^;]*https:\/\/ep2\.adtrafficquality\.google/.test(csp));
  ok('the sodar config XHR is allowed as a connection', /connect-src[^;]*https:\/\/ep1\.adtrafficquality\.google/.test(csp));
  // ⚠️ THE ONE THE PRE-SHIP MEASUREMENT MISSED. The footprint sweep filtered candidate hosts through a
  // regex of ad-network domain names, so www.google.com never appeared in it — and the first production
  // run came back with exactly one violation: the loader framing Google's reCAPTCHA attestation page.
  // Blocking adsbygoogle.js at the network layer dropped that violation to zero, which is what proved the
  // frame was the loader's and not something already on the page.
  ok('⚠️ the reCAPTCHA attestation frame is allowed', /frame-src[^;]*https:\/\/www\.google\.com\/recaptcha\//.test(csp));
  // ⚠️ AND SCOPED TO THAT PATH, not to the whole origin. A CSP source expression takes a path prefix, so
  // this permits the attestation frame and nothing else on www.google.com. Verified against a real
  // response header with a negative control that blocks: path matching is ignored across redirects, so
  // whether the tight form works at all was an empirical question, not a spec-reading one.
  ok('⚠️ …and www.google.com is NOT permitted as a whole origin',
    !/https:\/\/www\.google\.com(?![/\w])/.test(csp));
  // img-src is already 'https:', so the gen_204 and sodar beacons needed no addition at all.
  ok('img-src already covered the beacons without a change', /img-src 'self' data: blob: https:/.test(csp));

  // ⚠️ AND NOTHING WAS BROADLY WEAKENED, which is the half that matters more than the additions.
  ok('⚠️ no wildcard ad host was added', !/https:\/\/\*\.(googlesyndication|doubleclick|adtrafficquality|googleadservices)/.test(csp));
  ok('⚠️ unsafe-eval was not added anywhere new', (csp.match(/'unsafe-eval'/g) || []).length === 1);
  ok('…and it is still only in script-src', !/(style|connect|frame|img|font)-src[^;]*'unsafe-eval'/.test(csp));
  // object-src is not declared, so it inherits default-src 'self' — plugins were never permitted and
  // this change does not permit them. (base-uri is also undeclared, which does NOT inherit; that is
  // pre-existing and outside this task, noted rather than silently changed.)
  ok('plugin sources are still restricted by the default-src fallback',
    !/object-src/.test(csp) && /default-src 'self'/.test(csp));
  ok('no ad host leaked into default-src', /default-src 'self';/.test(csp.replace(/s*;s*/g, ';')));

  // ⚠️ THE ABLY FIX MUST SURVIVE THIS EDIT. Two CSP changes in a row is exactly how the first one gets
  // clobbered by the second — section 1 above asserts it too, deliberately, from the other direction.
  ok('⚠️ the Ably realtime endpoint is still allowed', /wss:\/\/\*\.ably\.net/.test(csp) && /https:\/\/\*\.ably\.net/.test(csp));
  ok('the Ably SDK CDN is still allowed', /script-src[^;]*https:\/\/cdn\.ably\.com/.test(csp));
  for (const host of ['platform.twitter.com', 's3.tradingview.com', 'clerk.catalystpit.com',
    'challenges.cloudflare.com', 'fonts.gstatic.com', 'cdn.syndication.twimg.com']) {
    ok(`${host} is still permitted`, csp.includes(host));
  }
  ok('the directive count is unchanged at nine',
    csp.split(';').map((d) => d.trim()).filter(Boolean).length === 9);

  // The script itself is untouched: it was never the problem, and removing it was never the fix.
  const layout = read('src/app/layout.jsx');
  ok('the AdSense loader is still present, exactly once',
    (layout.match(/pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/g) || []).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
