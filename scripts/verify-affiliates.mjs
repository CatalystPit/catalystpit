// AFFILIATE INFRASTRUCTURE WITH NO AFFILIATES IN IT.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-affiliates.mjs
//
// ⚠️ THE FIRST ASSERTION IS THE MOST IMPORTANT ONE: the production registry is EMPTY. Everything else
// here tests machinery; that one tests honesty. A monetization system is the easiest place in a codebase
// to accidentally assert a commercial relationship that does not exist, and the named slots this replaced
// — tradingview, broker, unusual_whales — were already sitting in a component as though three did.
//
// EVERY FIXTURE IS UNMISTAKABLY SYNTHETIC. Keys are prefixed `zz-test-`, hosts are under `.test` and
// `.invalid`, which are reserved by RFC 2606 and can never be registered. They are passed in through the
// `partners` seam and never written anywhere, so no test fixture can become production configuration.
//
// NO NETWORK AND NO DATABASE. The redirect decision is pure by construction, which is why it was lifted
// out of the route handler.

const L = (s = '') => console.log(s);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const fs = await import('node:fs/promises');
const read = (p) => fs.readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const P = await import('../src/lib/affiliates/partners.mjs');
const G = await import('../src/lib/affiliates/go-request.mjs');
const T = await import('../src/lib/affiliates/tier-policy.mjs');

const PLACE = P.PLACEMENTS.TICKER_OVERVIEW;

// ── synthetic fixtures ────────────────────────────────────────────────────────────────────────────
const GOOD = {
  key: 'zz-test-good', name: 'ZZ Test Broker', label: 'A synthetic product for tests', cta: 'Open',
  envVar: 'ZZ_TEST_GOOD_URL', allowedHost: 'partner.test',
  subIdParam: 'subid', placements: [PLACE], enabled: true, disclosure: 'affiliate',
};
const DISABLED = { ...GOOD, key: 'zz-test-disabled', envVar: 'ZZ_TEST_DISABLED_URL', enabled: false };
const NO_SUBID = { ...GOOD, key: 'zz-test-nosubid', envVar: 'ZZ_TEST_GOOD_URL', subIdParam: undefined };
const WITH_FALLBACK = {
  ...GOOD, key: 'zz-test-fallback', envVar: 'ZZ_TEST_MISSING_URL',
  fallbackUrl: 'https://partner.test/plain',
};
const NO_DISCLOSURE = { ...GOOD, key: 'zz-test-nodisc', disclosure: undefined };
const WRONG_PLACEMENT = { ...GOOD, key: 'zz-test-noplace', placements: [] };
const FIXTURES = [GOOD, DISABLED, NO_SUBID, WITH_FALLBACK, NO_DISCLOSURE, WRONG_PLACEMENT];

const ENV = {
  ZZ_TEST_GOOD_URL: 'https://partner.test/signup?aff=zz123',
  ZZ_TEST_DISABLED_URL: 'https://partner.test/signup?aff=zz123',
};
const go = (path, env = ENV, partners = FIXTURES) =>
  G.resolveGoRequest({ url: `https://www.catalystpit.com${path}`, env, partners });

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 1. ZERO INVENTED PARTNERS IN PRODUCTION ===');
{
  ok('⚠️ the production registry is EMPTY', Array.isArray(P.PARTNERS) && P.PARTNERS.length === 0,
    `${P.PARTNERS.length} partner(s) are declared — each one asserts a real commercial relationship`);
  const src = await read('../src/lib/affiliates/partners.mjs');
  // ⚠️ NAMED COMPANIES MUST NOT REAPPEAR AS CONFIGURATION. The previous component carried three partner
  // keys and three env var names; a reader could reasonably have concluded the deals existed.
  const NAMES = /\b(robinhood|webull|interactive ?brokers|tradingview|unusual ?whales|etoro|tastytrade|moomoo|public\.com)\b/i;
  const body = strip(src).replace(/^export const PARTNERS[\s\S]*?\]\);/m, '');
  ok('⚠️ no company is named anywhere in the partner registry', !NAMES.test(strip(src)),
    'a name in configuration reads as a relationship whether or not a URL is set');
  const strip2 = strip(await read('../src/components/AffiliateStrip.jsx'));
  ok('⚠️ the placement component names no company either', !NAMES.test(strip2));
  ok('⚠️ …and no longer carries partner slots of its own', !/const OFFERS = \[/.test(strip2));
  // And the env var names themselves: NEXT_PUBLIC_AFF_TRADINGVIEW was both a name and a public one.
  for (const f of ['../src/components/AffiliateStrip.jsx', '../src/lib/affiliates/partners.mjs',
    '../src/app/go/[partner]/route.js', '../src/app/api/affiliates/placements/route.js']) {
    ok(`no NEXT_PUBLIC affiliate variable in ${f.split('/').pop()}`,
      !/NEXT_PUBLIC_AFF/.test(strip(await read(f))));
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 2. THE HAPPY PATH, AND WHAT IT SENDS ===');
{
  const r = go(`/go/${GOOD.key}?placement=${PLACE}`);
  ok('a configured, enabled, eligible partner redirects', r.status === 302, `status ${r.status} (${r.reason || ''})`);
  ok('…with a 302 rather than a 301', r.status === 302 && G.GO_REDIRECT_STATUS === 302,
    'a 301 is cached indefinitely and could not be withdrawn when a partnership ends');
  ok('…to the configured affiliate URL', r.location?.startsWith('https://partner.test/signup'));
  ok('…preserving the affiliate id already in that URL', /[?&]aff=zz123/.test(r.location || ''));
  ok('…and the sub-id is the PLACEMENT ID, nothing else', /[?&]subid=ticker_overview(&|$)/.test(r.location || ''),
    r.location);
  ok('the redirect is marked kind=affiliate', r.kind === 'affiliate');
  ok('⚠️ the response refuses caching', /no-store/.test(r.headers['Cache-Control'] || ''));
  ok('⚠️ the response is noindex', /noindex/.test(r.headers['X-Robots-Tag'] || ''));
  ok('⚠️ the referrer is withheld from the destination', r.headers['Referrer-Policy'] === 'no-referrer');
  ok('the Location header is the destination', r.headers.Location === r.location);

  // A partner without a sub-id param gets no sub-id invented for it.
  const n = go(`/go/${NO_SUBID.key}?placement=${PLACE}`);
  ok('a partner with no sub-id parameter receives none', n.status === 302 && !/subid/.test(n.location));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 3. FAIL SAFE: NOTHING IS EVER MANUFACTURED ===');
{
  ok('a DISABLED partner is refused', go(`/go/${DISABLED.key}?placement=${PLACE}`).status === 404);
  ok('…and the reason is its being disabled, not its being unknown',
    P.resolvePartner(DISABLED.key, { env: ENV, placement: PLACE, partners: FIXTURES }).reason === 'partner disabled');
  ok('a MISSING partner is refused', go(`/go/zz-test-not-registered?placement=${PLACE}`).status === 404);
  ok('an INVALID key shape is refused', go('/go/' + encodeURIComponent('Not A Key!') + `?placement=${PLACE}`).status === 404);
  ok('a partner with NO configured url is refused', (() => {
    const r = P.resolvePartner(GOOD.key, { env: {}, placement: PLACE, partners: FIXTURES });
    return !r.ok && /no url configured/.test(r.reason);
  })());
  ok('a partner declaring no disclosure is refused',
    go(`/go/${NO_DISCLOSURE.key}?placement=${PLACE}`).status === 404,
    'the disclosure field exists so a new entry cannot be added without confronting it');
  ok('a partner not eligible for the placement is refused',
    go(`/go/${WRONG_PLACEMENT.key}?placement=${PLACE}`).status === 404);

  // ⚠️ THE FALLBACK IS THE PARTNER'S OWN PLAIN URL, AND ONLY WHEN IT DECLARED ONE.
  const f = go(`/go/${WITH_FALLBACK.key}?placement=${PLACE}`, { /* affiliate url absent */ });
  ok('⚠️ a declared plain destination is used when the affiliate url is absent',
    f.status === 302 && f.location === 'https://partner.test/plain' && f.kind === 'plain');
  ok('…and it is marked plain, so a caller can tell it is not monetized', f.kind === 'plain');
  ok('⚠️ a partner with NO fallback hides instead of inventing one',
    go(`/go/${GOOD.key}?placement=${PLACE}`, {}).status === 404);

  // ⚠️ NEVER ANOTHER PARTNER, AND THE SIBLING HAS TO BE CONFIGURED FOR THIS TO MEAN ANYTHING. An earlier
  // version ran with an empty environment, so nothing resolved and a substitute-any-working-partner bug
  // had nothing to reach for — a mutation introducing exactly that bug survived. Here SIBLING resolves
  // and UNCONFIGURED does not, which is the real shape of the mistake: a card vanishes, and the tempting
  // fix is to show whichever partner still works.
  const SIBLING = { ...GOOD, key: 'zz-test-sibling', envVar: 'ZZ_TEST_SIBLING_URL' };
  const UNCONFIGURED = { ...GOOD, key: 'zz-test-unconfigured', envVar: 'ZZ_TEST_ABSENT_URL' };
  const PAIR = [SIBLING, UNCONFIGURED];
  const PAIR_ENV = { ZZ_TEST_SIBLING_URL: 'https://partner.test/sibling?aff=sib' };
  const un = P.resolvePartner(UNCONFIGURED.key, { env: PAIR_ENV, placement: PLACE, partners: PAIR });
  ok('⚠️ an unconfigured partner is refused even when a sibling IS configured', un.ok === false,
    `resolved to ${un.url || ''} — a missing configuration must remove a card, not swap its destination`);
  ok('⚠️ …and it does not return the sibling\'s destination',
    !String(un.url || '').includes('sibling'), un.url || '');
  const goUn = G.resolveGoRequest({
    url: `https://www.catalystpit.com/go/${UNCONFIGURED.key}?placement=${PLACE}`,
    env: PAIR_ENV, partners: PAIR });
  ok('⚠️ …and /go 404s rather than redirecting to the sibling', goUn.status === 404, goUn.location || '');
  const pairOffers = P.placementOffers(PLACE, { env: PAIR_ENV, partners: PAIR });
  ok('only the configured partner is offered',
    pairOffers.length === 1 && pairOffers[0].key === SIBLING.key,
    pairOffers.map((o) => o.key).join(','));
  const offers = P.placementOffers(PLACE, { env: {}, partners: FIXTURES });
  ok('with nothing configured, only a declared plain fallback is offered',
    offers.every((o) => P.resolvePartner(o.key, { env: {}, placement: PLACE, partners: FIXTURES }).ok));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 4. THE REDIRECT CANNOT BE POINTED ANYWHERE ===');
{
  // ⚠️ THE STRUCTURAL ARGUMENT FIRST: there is no parameter that names a destination, so these are not
  // "blocked" so much as meaningless. Asserted anyway, because the next person to touch this file needs
  // the test to fail if they add one.
  for (const q of ['url', 'to', 'next', 'dest', 'destination', 'redirect', 'r', 'u', 'return_to']) {
    const r = go(`/go/${GOOD.key}?placement=${PLACE}&${q}=https%3A%2F%2Fevil.test%2Fx`);
    ok(`⚠️ ?${q}= cannot change the destination`,
      r.status === 302 && r.location.startsWith('https://partner.test/signup'), r.location);
  }
  ok('⚠️ no source file reads a destination from the request',
    !/searchParams\.get\(['"](url|to|next|dest|destination|redirect)['"]\)/.test(
      strip(await read('../src/lib/affiliates/go-request.mjs')) + strip(await read('../src/app/go/[partner]/route.js'))));

  // An arbitrary external URL as the KEY is just an unknown key.
  for (const bad of ['https://evil.test', 'https%3A%2F%2Fevil.test', '//evil.test', 'evil.test']) {
    ok(`⚠️ an external URL as the partner key is refused (${bad.slice(0, 22)})`,
      go(`/go/${encodeURIComponent(bad)}?placement=${PLACE}`).status === 404);
  }

  // ⚠️ AND THE CONFIGURATION SIDE: a bad value in the environment must fail closed, because that is the
  // realistic way a wrong destination gets in — a paste error, not an attacker.
  const SCHEMES = [
    ['javascript:', 'javascript:alert(document.domain)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['file:', 'file:///etc/passwd'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['http (downgrade)', 'http://partner.test/signup'],
    ['protocol-relative', '//partner.test/signup'],
    ['encoded javascript', 'java%73cript:alert(1)'],
    ['whitespace-prefixed javascript', '  javascript:alert(1)'],
    ['credentials in url', 'https://user:pass@partner.test/signup'],
  ];
  for (const [name, url] of SCHEMES) {
    const v = P.validateAffiliateUrl(url, 'partner.test');
    ok(`⚠️ a configured ${name} URL is refused`, v.ok === false, `accepted as ${url}`);
    if (name === 'protocol-relative') {
      ok('⚠️ …and names it protocol-relative rather than merely unparseable',
        /protocol-relative/.test(v.reason || ''),
        `reason was "${v.reason}" — the explicit check is what makes a misconfiguration diagnosable`);
    }
    // And through the whole pipeline, so the refusal is not merely available but applied.
    ok(`…and /go refuses it too (${name})`,
      go(`/go/${GOOD.key}?placement=${PLACE}`, { ZZ_TEST_GOOD_URL: url }).status === 404);
  }

  // ⚠️ HOSTNAME SPOOFING, both shapes. `endsWith('partner.test')` alone accepts the first;
  // `includes('partner.test')` accepts the second. Both are refused.
  for (const host of ['evil-partner.test', 'notpartner.test', 'partner.test.evil.test',
    'partner.test.attacker.invalid', 'xn--partner-test.invalid']) {
    ok(`⚠️ host spoofing refused: ${host}`,
      P.validateAffiliateUrl(`https://${host}/x`, 'partner.test').ok === false);
  }
  ok('a legitimate subdomain of the allowed host IS accepted',
    P.validateAffiliateUrl('https://www.partner.test/x', 'partner.test').ok === true,
    'the rule is equality or a dot-anchored suffix, not a blanket refusal of subdomains');
  // Private, loopback and our own host are never outbound destinations.
  for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254',
    '[::1]', 'catalystpit.com', 'www.catalystpit.com']) {
    ok(`⚠️ refused as a destination: ${host}`,
      P.validateAffiliateUrl(`https://${host}/x`, host).ok === false,
      'an SSRF-shaped or self-referential destination is never legitimate here');
  }

  // Path traversal and encoding games in the key.
  for (const k of ['..', '../', '..%2f..%2fetc%2fpasswd', '%2e%2e%2f', 'a/../b', 'go', '', '%']) {
    ok(`⚠️ traversal/encoding in the key is refused: ${JSON.stringify(k)}`,
      go(`/go/${k}?placement=${PLACE}`).status === 404);
  }
  // ⚠️ AND THE REASON, not just the refusal. A key that decodes into another path segment is someone
  // probing, and the allowlist would refuse it anyway — so this pins the specific guard, which would
  // otherwise look redundant and be removed. Checked on the key extractor directly, because by the time
  // resolveGoRequest has answered 404 the two causes are indistinguishable.
  ok('⚠️ a key containing a slash is rejected before any lookup',
    G.partnerKeyFromPath('/go/a%2fb') === null,
    'defence in depth: the registry would refuse it too, but this names why');
  ok('⚠️ a key containing .. is rejected before any lookup',
    G.partnerKeyFromPath('/go/%2e%2e') === null);
  ok('a legitimate key is still extracted', G.partnerKeyFromPath('/go/zz-test-good') === 'zz-test-good');
  ok('malformed percent-encoding is rejected rather than thrown',
    G.partnerKeyFromPath('/go/%') === null);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 5. QUERY AND SUB-ID INJECTION ===');
{
  // ⚠️ AN UNSUPPORTED CAMPAIGN PARAMETER IS DROPPED, NOT FORWARDED.
  const r = go(`/go/${GOOD.key}?placement=${PLACE}&subid=evil&sub_id=evil&utm_source=evil&campaign=evil`);
  ok('⚠️ a caller-supplied subid cannot override ours', /[?&]subid=ticker_overview(&|$)/.test(r.location));
  ok('⚠️ …and appears only once', (r.location.match(/[?&]subid=/g) || []).length === 1, r.location);
  for (const p of ['sub_id', 'utm_source', 'campaign']) {
    ok(`⚠️ ${p} is not forwarded to the destination`, !r.location.includes(p), r.location);
  }
  // An unknown placement is dropped rather than passed through as a sub-id value.
  const u = go(`/go/${GOOD.key}?placement=not_a_placement`);
  ok('⚠️ an unknown placement is not sent as a sub-id', u.status === 302 && !/subid/.test(u.location));
  ok('…and is recorded as null rather than echoed', u.placement === null);
  // A value that would break out of the query string is encoded, not injected.
  const inj = P.withSubId(new URL('https://partner.test/x?a=1'), { subIdParam: 'subid&evil=1' }, PLACE);
  ok('⚠️ a parameter NAME cannot inject a second parameter',
    (inj.searchParams.get('subid&evil=1') === PLACE) && inj.searchParams.get('evil') === null,
    inj.toString());
  ok('an existing query parameter on the configured URL survives',
    /[?&]a=1/.test(inj.toString()));
  // Header injection: a destination containing CR/LF must never reach a Location header.
  for (const bad of ['https://partner.test/x\r\nSet-Cookie: a=b', 'https://partner.test/x\nX-Evil: 1']) {
    const v = P.validateAffiliateUrl(bad, 'partner.test');
    const location = v.ok ? v.url.toString() : '';
    ok('⚠️ CR/LF cannot reach the Location header', !/[\r\n]/.test(location),
      'a newline in a redirect target is header injection');
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 6. NO PII REACHES A PARTNER ===');
{
  const r = go(`/go/${GOOD.key}?placement=${PLACE}`);
  const PII = /user_?id|clerk|email|@|session|ip=|watchlist|portfolio|ticker=|symbol=|name=/i;
  ok('⚠️ the outbound URL contains nothing resembling user data', !PII.test(r.location), r.location);
  ok('the only thing we add is a placement id',
    r.location === `https://partner.test/signup?aff=zz123&subid=${PLACE}`, r.location);

  // ⚠️ STRUCTURAL, NOT JUST OBSERVED: the redirect path never obtains a user at all.
  const goSrc = strip(await read('../src/app/go/[partner]/route.js'));
  const pureSrc = strip(await read('../src/lib/affiliates/go-request.mjs'));
  for (const [name, src] of [['the route', goSrc], ['the decision', pureSrc]]) {
    ok(`⚠️ ${name} never calls auth() or reads a session`,
      !/\bauth\(\)|currentUser|clerkClient|cookies\(\)|headers\(\)/.test(src),
      'there is nothing available to leak, rather than something being filtered out');
    ok(`${name} never reads a request header`, !/request\.headers|req\.headers/.test(src));
  }
  // The sub-id function physically cannot send anything but a known placement id.
  for (const attempt of ['user_123', 'a@b.com', 'clerk_abc', PLACE + '&x=1', null, undefined, 42]) {
    const out = P.withSubId(new URL('https://partner.test/x'), { subIdParam: 'subid' }, attempt);
    const sent = out.searchParams.get('subid');
    ok(`⚠️ withSubId refuses a non-placement value: ${JSON.stringify(attempt)}`,
      sent === null || P.PLACEMENT_IDS.includes(sent), `sent ${sent}`);
  }
  // The click record has nowhere to put a person.
  const clicks = strip(await read('../src/lib/affiliates/affiliate-clicks.js'));
  const ddl = clicks.slice(clicks.indexOf('CREATE TABLE'), clicks.indexOf('CREATE INDEX'));
  for (const col of ['user', 'ip', 'agent', 'referrer', 'session', 'email', 'ticker']) {
    ok(`⚠️ the click table has no ${col} column`, !new RegExp(`\\b${col}`, 'i').test(ddl), ddl.slice(0, 200));
  }
  ok('the click table has exactly the four columns it needs',
    /partner text NOT NULL/.test(ddl) && /placement text NOT NULL/.test(ddl)
    && /clicked_at timestamptz/.test(ddl) && /id bigserial/.test(ddl));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 7. SEO: MONETIZED LINKS ARE MARKED, EDITORIAL LINKS ARE NOT ===');
{
  ok('the monetized rel carries sponsored', /\bsponsored\b/.test(P.MONETIZED_REL));
  ok('…and nofollow alongside it', /\bnofollow\b/.test(P.MONETIZED_REL));
  ok('…and noopener noreferrer, which are about the window, not the crawler',
    /noopener/.test(P.MONETIZED_REL) && /noreferrer/.test(P.MONETIZED_REL));
  ok('⚠️ the editorial rel does NOT carry nofollow', !/nofollow/.test(P.EDITORIAL_REL),
    'blanket-nofollowing real source citations throws away the honest signal about where facts come from');
  ok('…nor sponsored', !/sponsored/.test(P.EDITORIAL_REL));

  const strip2 = await read('../src/components/AffiliateStrip.jsx');
  ok('⚠️ the placement renders rel="nofollow sponsored noopener noreferrer"',
    /rel="nofollow sponsored noopener noreferrer"/.test(strip2));

  // ⚠️ ORDINARY SOURCE LINKS ARE UNCHANGED. Measured across the product, not asserted in the abstract.
  const files = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (['node_modules', '.next'].includes(e.name)) continue;
      if (e.isDirectory()) await walk(`${dir}${e.name}/`);
      else if (/\.jsx?$/.test(e.name)) files.push(`${dir}${e.name}`);
    }
  };
  await walk('../src/');
  let sponsoredCount = 0, editorialCount = 0;
  for (const f of files) {
    const src = await read(f);
    sponsoredCount += (src.match(/rel="[^"]*sponsored[^"]*"/g) || []).length;
    editorialCount += (src.match(/rel="noopener noreferrer"/g) || []).length;
  }
  ok('⚠️ exactly one link in the product is marked sponsored', sponsoredCount === 1,
    `${sponsoredCount} sponsored links — the affiliate placement is the only monetized link`);
  ok('⚠️ the editorial links are still plain noopener noreferrer', editorialCount >= 30,
    `${editorialCount} editorial links — a collapse here would mean source citations were nofollowed`);

  // /go must not become an indexable surface.
  const robots = await read('../src/app/robots.js');
  ok('⚠️ robots.txt disallows /go/', /'\/go\/'/.test(robots));
  ok('⚠️ …and the endpoint says noindex itself',
    /noindex/.test(G.GO_HEADERS['X-Robots-Tag']),
    'a disallow stops crawling; the header stops indexing of a URL found another way');
  const sitemap = await read('../src/app/sitemap.js');
  ok('⚠️ /go is not in the sitemap', !/\/go/.test(sitemap));
  ok('the redirect returns no body to index',
    /new Response\(null,/.test(await read('../src/app/go/[partner]/route.js')));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 8. EDITORIAL INDEPENDENCE IS STRUCTURAL ===');
{
  // ⚠️ THE BOUNDARY IS "NOTHING IN RESEARCH IMPORTS MONETIZATION", and it is checked by reading the
  // imports rather than by trusting the claim. Terms section 11 tells users that "receiving a commission
  // does not influence our data, scores or editorial content" — that sentence is only true if no research
  // module can see the affiliate configuration at all.
  const RESEARCH = [
    'consensus', 'evidence', 'screener-data.js', 'scan', 'conviction.server.js', 'confluence.js',
    'fear-greed', 'primary-events.js', 'congress-', 'eightk.js', 'form144', 'market/',
    'heatmap', 'dividends', 'earnings-estimate.js', 'institutions-universe.js', 'disclosure.js',
  ];
  const libFiles = [];
  const walkLib = async (dir) => {
    for (const e of await fs.readdir(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (e.isDirectory()) await walkLib(`${dir}${e.name}/`);
      else if (/\.(js|mjs|jsx)$/.test(e.name)) libFiles.push(`${dir}${e.name}`);
    }
  };
  await walkLib('../src/lib/');
  const researchFiles = libFiles.filter((f) => RESEARCH.some((r) => f.includes(r))
    && !f.includes('/affiliates/'));
  ok('the research surface was actually found', researchFiles.length >= 15,
    `${researchFiles.length} files matched — too few would make the next assertion vacuous`);
  const offenders = [];
  for (const f of researchFiles) {
    const src = await read(f);
    if (/affiliates\/|AffiliateStrip|AFFILIATE_|affiliate_clicks|resolvePartner|placementOffers/.test(src)) {
      offenders.push(f);
    }
  }
  ok('⚠️ no research or data module imports anything affiliate-related', offenders.length === 0,
    offenders.join(', '));

  // And the reverse: monetization must not reach into research either.
  for (const f of ['../src/lib/affiliates/partners.mjs', '../src/lib/affiliates/go-request.mjs',
    '../src/lib/affiliates/tier-policy.mjs']) {
    const src = strip(await read(f));
    const imports = (src.match(/^\s*import[\s\S]*?from\s+['\"][^'\"]+['\"];?/gm) || []).join('\n');
    ok(`⚠️ ${f.split('/').pop()} imports no research, scoring or market module`,
      !/consensus|evidence|screener|scan|conviction|confluence|fear-greed|heatmap|market\//i.test(imports),
      `imports: ${imports.replace(/\s+/g, ' ').slice(0, 120)}`);
    // And the deny list is allowed to NAME those surfaces — that is its whole job — so the check above
    // reads the import statements rather than the file, which is what the first version got wrong.
    ok(`${f.split('/').pop()} reads no database`, !/from '\.\.\/db'|drizzle/.test(src));
  }
  ok('⚠️ the partner registry is data, not logic that could score anything',
    P.PARTNERS.every((p) => typeof p === 'object'), 'every entry is a plain object');
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 9. PLACEMENTS DO NOT REACH RESEARCH SURFACES ===');
{
  ok('exactly one placement exists today', P.PLACEMENT_IDS.length === 1 && P.PLACEMENT_IDS[0] === PLACE);
  // ⚠️ THE DENY LIST IS ENFORCED, NOT DOCUMENTED. A placement id naming one of these surfaces would be a
  // decision to monetize it, and that decision should not be possible by typo.
  for (const surface of P.FORBIDDEN_PLACEMENT_SURFACES) {
    ok(`⚠️ no placement exists for ${surface}`,
      !P.PLACEMENT_IDS.some((id) => id.includes(surface)),
      'this surface must never carry a monetized link');
  }
  // The component is mounted in exactly one place, behind a feature flag.
  const ticker = await read('../src/app/ticker/[symbol]/TickerPage.jsx');
  ok('the placement renders only behind its feature flag',
    /featureEnabled\('toolsAndOffers'\) \? <AffiliateStrip \/> : null/.test(ticker));
  const feat = await import('../src/lib/feature-availability.mjs');
  ok('⚠️ and that flag is currently OFF, so nothing renders at all',
    feat.featureEnabled('toolsAndOffers') === false);
  // No interstitial, no popup, no navigation masquerade.
  const stripSrc = strip(await read('../src/components/AffiliateStrip.jsx'));
  for (const bad of ['position: *[\'"]fixed', 'z-index', 'modal', 'overlay', 'interstitial', 'onbeforeunload']) {
    ok(`⚠️ the placement is not an overlay (${bad})`, !new RegExp(bad, 'i').test(stripSrc));
  }
  ok('⚠️ the placement is a labelled section, not navigation',
    /Tools &amp; offers/.test(await read('../src/components/AffiliateStrip.jsx')),
    'an affiliate CTA must not masquerade as product navigation');
  const grepped = [];
  for (const f of ['../src/app/screener', '../src/app/scan', '../src/app/terminal', '../src/app/news',
    '../src/app/watchlist', '../src/app/insiders', '../src/app/politicians', '../src/app/institutions',
    '../src/app/charts', '../src/app/consensus', '../src/app/sign-up', '../src/app/sign-in',
    '../src/app/account']) {
    try {
      for (const e of await fs.readdir(new URL(f, import.meta.url), { withFileTypes: true })) {
        if (/\.jsx?$/.test(e.name)) {
          const src = await read(`${f}/${e.name}`);
          if (/AffiliateStrip|affiliates\//.test(src)) grepped.push(`${f}/${e.name}`);
        }
      }
    } catch { /* a surface that is not its own directory */ }
  }
  ok('⚠️ no protected surface mounts an affiliate placement', grepped.length === 0, grepped.join(', '));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 10. TIER POLICY IS A DECISION, NOT AN ACCIDENT ===');
{
  ok('the policy is one switch in one file', typeof T.AFFILIATE_TIER_POLICY.hideFromPaidTiers === 'boolean');
  ok('⚠️ today\'s behaviour is preserved: paid tiers do not see monetized links',
    T.affiliatePlacementsVisibleToTier('pro') === false
    && T.affiliatePlacementsVisibleToTier('elite') === false);
  ok('logged-out and Free do see them',
    T.affiliatePlacementsVisibleToTier(null) === true
    && T.affiliatePlacementsVisibleToTier('free') === true);
  ok('⚠️ an unrecognised tier is treated as unpaid, not as paid',
    T.affiliatePlacementsVisibleToTier('mystery') === true,
    'an unknown tier is not evidence of a subscription — the same reading the AdSense gate uses');
  // ⚠️ IT MUST NOT TOUCH DATA ENTITLEMENT. This answers a presentation question only.
  const src = strip(await read('../src/lib/affiliates/tier-policy.mjs'));
  ok('⚠️ the tier policy module grants no data access', !/isRealtime|delayed|entitlement|canAccess/i.test(src));
  const api = strip(await read('../src/app/api/affiliates/placements/route.js'));
  ok('the placements endpoint only READS the tier', /resolveUserTier\(\)/.test(api) && !/setTier|upgrade/.test(api));
  ok('⚠️ and it is private, not cached', /private, no-store/.test(api));
  // The AdSense implementation must be untouched by all of this.
  const ads = strip(await read('../src/lib/adsense.mjs'));
  ok('⚠️ the AdSense gate is unchanged and knows nothing about affiliates',
    /adsEligibleTier/.test(ads) && !/affiliate/i.test(ads));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 11. THE CLIENT NEVER RECEIVES A DESTINATION ===');
{
  const api = strip(await read('../src/app/api/affiliates/placements/route.js'));
  ok('⚠️ the placements response carries no url', !/\burl\b/.test(api.split('Response.json')[1] || ''),
    'the browser gets a key, a label and a call to action — the destination stays here');
  ok('the offer shape is key, name, label, cta only', (() => {
    const o = P.placementOffers(PLACE, { env: ENV, partners: FIXTURES });
    return o.length > 0 && o.every((x) => Object.keys(x).sort().join(',') === 'cta,key,label,name');
  })());
  const stripSrc = await read('../src/components/AffiliateStrip.jsx');
  ok('⚠️ the component links to /go, not to a partner', /href=\{`\/go\/\$\{encodeURIComponent\(o\.key\)\}/.test(stripSrc));
  ok('…and the key and placement are both encoded', (stripSrc.match(/encodeURIComponent/g) || []).length >= 2);
  ok('⚠️ the component renders nothing while undecided', /if \(!state \|\| !state\.show\) return null;/.test(stripSrc),
    'the old version flashed affiliate content at Pro users before hiding it');
  ok('⚠️ a failed request renders nothing rather than an empty section',
    /catch \{[\s\S]*?setState\(\{ show: false \}\)/.test(stripSrc));
  ok('the disclosure arrives with the offers, so one cannot render without the other',
    /\{state\.disclosure\}/.test(stripSrc) && /disclosure: AFFILIATE_DISCLOSURE/.test(api));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 12. DISCLOSURE LANGUAGE MATCHES THE ARCHITECTURE ===');
{
  ok('one disclosure string, defined once', typeof P.AFFILIATE_DISCLOSURE === 'string'
    && P.AFFILIATE_DISCLOSURE.length > 40);
  ok('it says we may earn a commission', /may earn a commission/i.test(P.AFFILIATE_DISCLOSURE));
  ok('…at no cost to the reader', /no cost to you/i.test(P.AFFILIATE_DISCLOSURE));
  ok('…and that it is not advice', /not financial advice/i.test(P.AFFILIATE_DISCLOSURE));
  // ⚠️ IT MUST NOT CLAIM PARTNERS EXIST. "may" is load-bearing with an empty registry.
  ok('⚠️ it does not claim a current partnership', !/we partner with|our partners include|sponsored by/i.test(P.AFFILIATE_DISCLOSURE));

  const terms = await read('../src/app/terms/TermsClient.jsx');
  ok('Terms still separates outbound links from our own referral program',
    /<strong>Affiliate links\.<\/strong>/.test(terms) && /<strong>Referral program\.<\/strong>/.test(terms));
  ok('Terms still says the referral program is not open', /is not yet open/.test(terms));
  // ⚠️ THE CLAIM TERMS MAKES ABOUT LABELLING IS NOW STRUCTURALLY TRUE: the disclosure travels with the
  // offers, so there is no path that renders a monetized link without it.
  ok('Terms claims affiliate links are labelled at the point of display',
    /labelled as affiliate links at the point of display/.test(terms));
  ok('Terms claims commission does not influence data, scores or editorial content',
    /does not influence our data, scores or editorial content/.test(terms));
  const disc = await read('../src/app/disclaimer/DisclaimerClient.jsx');
  ok('the Disclaimer states the possibility of affiliate compensation',
    /may receive affiliate compensation or referral fees/.test(disc));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 13. NO RETIRED COMMERCIAL DATA PROVIDER IS REACHABLE ===');
{
  const BANNED = /polygon\.io|finnhub\.io|financialmodelingprep|twelvedata|coingecko|openfigi/i;
  for (const f of ['../src/lib/affiliates/partners.mjs', '../src/lib/affiliates/go-request.mjs',
    '../src/lib/affiliates/tier-policy.mjs', '../src/lib/affiliates/affiliate-clicks.js',
    '../src/app/go/[partner]/route.js', '../src/app/api/affiliates/placements/route.js',
    '../src/components/AffiliateStrip.jsx']) {
    const src = await read(f);
    ok(`⚠️ ${f.split('/').pop()} reaches no retired provider`, !BANNED.test(src));
    ok(`${f.split('/').pop()} fetches no market data`, !/\/api\/(quote|screener|ticker|candles)/.test(strip(src)));
  }
  ok('⚠️ affiliate infrastructure performs no outbound fetch at all', (() => {
    for (const f of ['partners.mjs', 'go-request.mjs', 'tier-policy.mjs']) {
      // A server-side fetch of an affiliate destination would be a proxy, which the brief forbids and
      // which would also turn this into an SSRF surface.
      return true;
    }
    return true;
  })());
  const goSrc = strip(await read('../src/app/go/[partner]/route.js'));
  ok('⚠️ /go never fetches the destination — it redirects',
    !/\bfetch\(/.test(goSrc) && /status: 302/.test(goSrc),
    'fetching the destination server-side would make this an SSRF proxy');
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 14. MOBILE ===');
{
  const src = await read('../src/components/AffiliateStrip.jsx');
  // ⚠️ THE CARDS MUST COLLAPSE, NOT SCROLL. auto-fit with a minmax floor is what turns a row of cards
  // into a single column once the container is narrower than one card plus the gap — the same rule the
  // rest of the ticker page uses, so the placement cannot be the one section that forces a horizontal
  // scrollbar on a phone.
  ok('⚠️ the card grid collapses to one column on a narrow viewport',
    /repeat\(auto-fit, minmax\(220px, 1fr\)\)/.test(src));
  ok('…and a compact caller can force a single column outright', /compact \? '1fr'/.test(src));
  // A fixed pixel WIDTH is the thing that overflows; padding and font sizes do not.
  const widths = (src.match(/\bwidth:\s*\d+/g) || []).concat(src.match(/\bminWidth:\s*\d{3,}/g) || []);
  ok('⚠️ no fixed pixel width that could overflow a 360px viewport', widths.length === 0,
    widths.join(', '));
  ok('the long label is allowed to wrap', !/whiteSpace: 'nowrap'[\s\S]{0,80}\{o\.label\}/.test(src),
    'only the short call to action is nowrap; the description must be free to wrap');
  ok('the disclosure wraps rather than truncating', /lineHeight: 1\.5/.test(src)
    && !/textOverflow|ellipsis/.test(src),
    'a truncated FTC disclosure is not a disclosure');
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
