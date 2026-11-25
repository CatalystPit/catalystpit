// ═══════════════════════════════════════════════════════════════════════════
//  VERIFY — THE LOGO WE SHOW FOR A TICKER BELONGS TO THAT COMPANY
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ A LOGO API RETURNING *A* LOGO IS NOT THE SAME AS RETURNING THE RIGHT ONE, AND THE WRONG ONE
// IS WORSE THAN NONE. An initials badge beside GSHD tells a reader we have no mark for Goosehead.
// Another company's trademark beside GSHD tells them something false about a business, on a page
// whose entire subject is that business's SEC filings. There is no "mostly right" here.
//
// This suite therefore has two halves, and only the first can run without a token:
//
//   STATIC   the integration cannot be half-on, cannot proxy the CDN, cannot lose its own
//            fallback, and cannot ship an attribution claim while serving no logos.
//   LIVE     every ticker resolves to a real image, distinct companies get distinct marks, and a
//            symbol with no logo returns 404 so OUR placeholder renders rather than the vendor's
//            generated monogram. Needs NEXT_PUBLIC_LOGO_DEV_TOKEN; skipped, loudly, without one.
//
// Run: node scripts/verify-logo-accuracy.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

let pass = 0; const fails = [];
const L = (s) => console.log(s);
function ok(label, cond, detail) {
  if (cond) { pass++; L(`  ok    ${label}${detail ? `  — ${detail}` : ''}`); }
  else { fails.push(label); L(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
}
const mut = (k) => (process.env.VERIFY_MUTATE || '').split(',').includes(k);

const src = code('src/lib/logo-source.mjs');
const shared = code('src/lib/cp-shared.jsx');

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 1. THE INTEGRATION CANNOT BE HALF-ON ===');
{
  // ⚠️ TWO CONDITIONS, BOTH FAIL CLOSED. The flag is permission; the token is a source. A flag
  // flipped without a token is exactly how a page fills with broken images — the state this whole
  // line of work was called in to fix.
  ok('the component requires BOTH the flag and a configured source',
    mut('halfon') ? false
      : /featureEnabled\('companyLogos'\) \? tickerLogoUrl\(/.test(shared)
        && /if \(!cdn \|\| failed\) return <TickerMonogram/.test(shared));
  ok('…and the source reports itself unconfigured without a token',
    /export function logoConfigured\(\) \{\s*return TOKEN\.length > 0;/.test(src));
  ok('…and builds no URL at all when unconfigured',
    /if \(!logoConfigured\(\)\) return null;/.test(src));

  // ⚠️ THE PUBLISHABLE TOKEN IS THE ONLY KIND ALLOWED IN A BUNDLE. Logo.dev's secret key (sk_)
  // is server-side only; NEXT_PUBLIC_ is Next's marker for a value inlined into client code, so
  // the name has to state the exposure rather than hide it.
  ok('⚠️ only a publishable token is read, never a secret key',
    mut('secretkey') ? false
      : /NEXT_PUBLIC_LOGO_DEV_TOKEN/.test(src) && !/LOGO_DEV_SECRET|sk_live|SECRET_KEY/.test(src));
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 2. THE PROVIDER\'S OWN RULES ARE HONOURED ===');
{
  // ⚠️ "A server that fetches img.logo.dev images and passes them on to your users" is listed on
  // Logo.dev's fair-use page as NOT fair use, as is "An API that proxies Logo.dev requests". The
  // brief asked to reuse /api/logo; the provider forbids exactly that, so the browser loads the
  // CDN directly and /api/logo keeps its own 404 contract untouched.
  ok('⚠️ the CDN is loaded by the browser, not proxied through our own route',
    mut('proxy') ? false
      : /src=\{cdn\}/.test(shared) && !/src=\{`\/api\/logo/.test(shared));
  ok('…and /api/logo still answers its cached 404 rather than becoming a proxy',
    /return miss\(\);/.test(code('src/app/api/logo/route.js'))
      && !/img\.logo\.dev/.test(code('src/app/api/logo/route.js')));

  // ⚠️ fallback=404 IS WHAT KEEPS OUR PLACEHOLDER OURS. Without it the CDN answers a miss with a
  // generated first-letter monogram and HTTP 200 — a grey tile a reader cannot tell from a real
  // mark, which is the exact defect this work removed.
  ok('⚠️ a miss returns 404 so our own fallback renders, not the vendor\'s monogram',
    mut('nofallback') ? false : /fallback: '404'/.test(src));
  ok('…and the format carries transparency', /format: 'png'/.test(src));
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 3. IDENTITY: THE RIGHT COMPANY, NOT A SYMBOL THAT LOOKS LIKE IT ===');
{
  const { logoLookupSymbol } = await import('../src/lib/logo-source.mjs');

  // ⚠️ A DOTTED SUFFIX MEANS A NON-US EXCHANGE TO THIS VENDOR (AZN.L is London, 7203.T is Tokyo).
  // Sending BRK.B asks for a security on an exchange called B. Share classes are one issuer with
  // one mark, so the lookup resolves to the issuer.
  for (const [input, want] of [['BRK.B', 'BRK'], ['BRK.A', 'BRK'], ['BF.B', 'BF'], ['AAPL', 'AAPL']]) {
    ok(`${input} resolves to the issuer ${want}`,
      mut('shareclass') ? false : logoLookupSymbol(input) === want, String(logoLookupSymbol(input)));
  }
  ok('a non-symbol resolves to nothing rather than to a guess',
    [null, undefined, '', '?', 'N/A', 'NYSE: VTEX'].every((v) => logoLookupSymbol(v) === null));
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 4. ATTRIBUTION IS A LICENCE CONDITION, NOT A COURTESY ===');
{
  // Free plan + commercial site = a visible link on a public production page. Any paid plan
  // removes it. The default is the SAFE direction: required unless a paid plan is asserted.
  ok('attribution defaults to required',
    mut('attribution') ? false
      : /!== 'paid'/.test(src) && /LOGO_ATTRIBUTION_REQUIRED/.test(src));
  ok('…and the footer renders it only while logos are actually being served',
    /featureEnabled\('companyLogos'\) && logoConfigured\(\) && LOGO_ATTRIBUTION_REQUIRED/.test(shared));
  ok('…pointing at logo.dev', /href: "https:\/\/logo\.dev"/.test(shared));
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 5. LIVE: DO THESE MARKS BELONG TO THESE COMPANIES? ===');
{
  const token = (process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN || '').trim();
  if (!token) {
    L('  --    SKIPPED: no NEXT_PUBLIC_LOGO_DEV_TOKEN.');
    L('        ⚠️ This is the half that proves the logos are CORRECT, and it has not run.');
    L('        Nothing is enabled without a token, so production is unaffected — but do not');
    L('        report logos as verified on the strength of section 1-4 alone.');
  } else {
    const { tickerLogoUrl } = await import('../src/lib/logo-source.mjs');
    const SYMS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META', 'GOOGL', 'AMD', 'JPM', 'BAC',
      'HCTI', 'GSHD', 'AREC'];
    const seen = new Map();          // sha256 → first symbol that produced it
    let real = 0, missing = 0;
    for (const s of SYMS) {
      const url = tickerLogoUrl(s, { size: 128 });
      try {
        const r = await fetch(url, { redirect: 'follow' });
        if (r.status === 404) {
          missing++;
          ok(`${s}: no logo, and the CDN says so with a 404`, true, 'our placeholder renders');
          continue;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        const type = r.headers.get('content-type') || '';
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        const dup = seen.get(hash);
        // ⚠️ TWO COMPANIES SHARING ONE IMAGE IS THE SIGNATURE OF A WRONG LOGO — either a generic
        // placeholder leaking through despite fallback=404, or one company's mark served for
        // another. Either way it fails.
        ok(`${s}: a real image, and not one already served for another company`,
          r.ok && /^image\//.test(type) && buf.length > 256 && !dup,
          dup ? `DUPLICATE of ${dup}` : `${type}, ${buf.length}b`);
        if (r.ok && !dup) { seen.set(hash, s); real++; }
      } catch (e) {
        ok(`${s}: the CDN answered`, false, e.message);
      }
    }
    L(`\n  coverage: ${real} real marks, ${missing} clean fallbacks, of ${SYMS.length}`);
    L('  ⚠️ AUTOMATION CANNOT TELL YOU THE MARK IS THE RIGHT COMPANY\'S — it can only prove the');
    L('     image is real, distinct and correctly typed. Open the page and look at the thirteen.');
  }
}

L(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { L('FAILED:'); fails.forEach((f) => L('  - ' + f)); process.exit(1); }
L('EVERY LOGO CHECK PASSED');
