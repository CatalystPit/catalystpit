// ─────────────────────────────────────────────────────────────────────────────
// THE ~19,750 TICKER URLs WERE UNCACHEABLE, AND ONE QUERY PARAMETER WAS WHY
//
// Measured on production at 41668bf7, as Googlebot:
//
//   /insiders      200   public, max-age=0, must-revalidate      x-vercel-cache: HIT   (age 4,235)
//   /ticker/AAPL   200   private, no-cache, no-store, max-age=0  x-vercel-cache: MISS
//   /ticker/AAPL   200   (immediate repeat of the same URL)      x-vercel-cache: MISS
//
// A 60-URL spread across our own sitemap measured p50 673ms / p90 1,356ms / max 2,387ms, against
// 210ms for the prerendered homepage. Every crawl of every ticker page reached the origin and
// rendered from scratch, and the response told every intermediary not to store it.
//
// The cause was NOT a missing header. A `headers()` entry in next.config was tried on 2026-11-24
// and measured not to take: for a dynamically rendered route the framework's own Cache-Control is
// applied last and wins. The cause was that the route WAS dynamic, and the one thing making it
// dynamic was Page() awaiting `searchParams` to carry `?tab=` across the lowercase→uppercase 308.
//
// Adding `export const revalidate` on its own was measured first and changes nothing whatsoever —
// the build output lists no Revalidate for the route and `next start` still answers
// `private, no-cache, no-store` on a second identical request. So the decision moved to middleware,
// which sees the query string for free.
//
// This file asserts the parts that can go wrong silently:
//   · the redirect decision itself, as a pure function (it is now the only copy)
//   · that the page did not quietly go back to reading searchParams
//   · that `revalidate` is a LITERAL, which Next requires and silently ignores otherwise
//   · that the redirect answers BEFORE Clerk, so a Clerk failure cannot take it down
//   · that nothing per-viewer is in the render that is now SHARED between visitors
//
// With --base <url> it also measures a running server, which is the only assertion that actually
// proves the cache works. With --mutate it breaks each of those guarantees in turn and fails if the
// suite does not notice.
//
//   node scripts/verify-ticker-cache.mjs
//   node scripts/verify-ticker-cache.mjs --base http://127.0.0.1:3310
//   node scripts/verify-ticker-cache.mjs --mutate
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tickerCanonicalRedirect } from '../src/lib/ticker-url-redirect.mjs';
import { TICKER_TABS, tickerPath, normalizeSymbol } from '../src/lib/ticker-symbol.mjs';
import { tickerTabEnabled } from '../src/lib/feature-availability.mjs';

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const MUTATE = args.includes('--mutate');
const BASE = (() => { const i = args.indexOf('--base'); return i >= 0 ? args[i + 1] : null; })();

let passed = 0;
const failures = [];
const ok = (label, cond) => { if (cond) passed++; else failures.push(label); };
const L = (s) => { if (!QUIET) console.log('\n' + s); };

const SRC = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const noComments = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const PAGE = 'src/app/ticker/[symbol]/page.jsx';
const MW = 'src/middleware.ts';
const MOD = 'src/lib/ticker-url-redirect.mjs';

// ── 1. the decision, as a pure function ──────────────────────────────────────
L('1. the canonicalising decision');
{
  ok('a lowercase symbol redirects to uppercase',
    tickerCanonicalRedirect({ pathname: '/ticker/aapl' }) === '/ticker/AAPL');
  ok('a mixed-case symbol redirects to uppercase',
    tickerCanonicalRedirect({ pathname: '/ticker/AaPl' }) === '/ticker/AAPL');
  // ⚠️ THE CASE THAT MUST RETURN NOTHING. If a canonical URL produced a redirect, every ticker page
  // on the site would be an infinite loop — and it would be a loop that the ISR cache then stored.
  ok('⚠️ an already-canonical symbol does NOT redirect',
    tickerCanonicalRedirect({ pathname: '/ticker/AAPL' }) === null);
  ok('a dotted share class is canonicalised, not rewritten',
    tickerCanonicalRedirect({ pathname: '/ticker/brk.b' }) === '/ticker/BRK.B');
  ok('a hyphenated preferred is canonicalised, not rewritten',
    tickerCanonicalRedirect({ pathname: '/ticker/bac-pl' }) === '/ticker/BAC-PL');
  ok('a digit-bearing symbol survives', tickerCanonicalRedirect({ pathname: '/ticker/bf.a' }) === '/ticker/BF.A');

  // ⚠️ NO REDIRECT CHAINS. Feeding the answer back in must be a no-op, or a crawler walks a chain.
  for (const raw of ['aapl', 'AaPl', 'brk.b', 'bac-pl']) {
    const to = tickerCanonicalRedirect({ pathname: `/ticker/${raw}` });
    ok(`${raw}: the target is itself canonical`,
      !!to && tickerCanonicalRedirect({ pathname: to.split('?')[0] }) === null);
  }
}

// ── 2. tabs ──────────────────────────────────────────────────────────────────
L('2. real tabs survive the hop, nothing else does');
{
  for (const t of [...TICKER_TABS].filter((t) => t !== 'overview' && tickerTabEnabled(t))) {
    ok(`tab=${t} preserved`, tickerCanonicalRedirect({ pathname: '/ticker/aapl', tab: t }) === `/ticker/AAPL?tab=${t}`);
  }
  ok('overview is dropped (the default view is not a second URL)',
    tickerCanonicalRedirect({ pathname: '/ticker/aapl', tab: 'overview' }) === '/ticker/AAPL');
  for (const junk of ['', ' ', 'TAB', 'news;drop', '../../etc', 'insider ', null, undefined, '__proto__']) {
    ok(`tab=${JSON.stringify(junk)} dropped`,
      tickerCanonicalRedirect({ pathname: '/ticker/aapl', tab: junk }) === '/ticker/AAPL');
  }
  // ⚠️ A TAB THAT IS SWITCHED OFF LANDS ON OVERVIEW, not on an empty panel. This is the guarantee
  // verify-feature-availability.mjs also pins, from the other side.
  const disabled = [...TICKER_TABS].filter((t) => t !== 'overview' && !tickerTabEnabled(t));
  for (const t of disabled) {
    ok(`⚠️ disabled tab=${t} does not survive`,
      tickerCanonicalRedirect({ pathname: '/ticker/aapl', tab: t }) === '/ticker/AAPL');
  }
  if (!disabled.length) ok('(no tab is currently switched off — the rule is still asserted above)', true);
}

// ── 3. what must be left to the page ─────────────────────────────────────────
L('3. what middleware must NOT answer');
{
  // ⚠️ A SEGMENT NO SYMBOL CAN BE READ FROM IS A 404 ON THE BRANDED PAGE. Answering it here would
  // either invent a target or turn a 404 into a redirect, and the 404 is deliberate: an arbitrary
  // string must not look like a security.
  for (const junk of ['', '-', '.', 'a'.repeat(11), 'AAPL!', 'AA PL', 'aa/pl']) {
    ok(`⚠️ /ticker/${JSON.stringify(junk)} is left to the page`,
      tickerCanonicalRedirect({ pathname: `/ticker/${junk}` }) === null);
  }
  ok('a malformed percent-escape is left to the page',
    tickerCanonicalRedirect({ pathname: '/ticker/%E0%A4%A' }) === null);
  for (const p of ['/', '/insiders', '/news', '/ticker', '/tickers/aapl', '/ticker/aapl/', '/ticker/aapl/news']) {
    ok(`${p} is not this route`, tickerCanonicalRedirect({ pathname: p }) === null);
  }
  for (const bad of [null, undefined, 42, {}, []]) {
    ok(`a ${typeof bad} pathname is refused`, tickerCanonicalRedirect({ pathname: bad }) === null);
  }
  ok('no argument at all is refused', tickerCanonicalRedirect() === null);

  // ⚠️ A GUARD NO BEHAVIOUR CAN CURRENTLY DISTINGUISH, KEPT ANYWAY, PINNED IN SOURCE.
  // A mutation run deleted the one-segment shape check and every assertion above stayed green:
  // today the grammar does the work, because normalizeSymbol refuses a slash and
  // /ticker/aapl%2Fnews decodes to exactly the same refusal. It stays because what makes it
  // redundant lives in ANOTHER FILE. The day a symbol is allowed to contain a slash, this is the
  // line that keeps /ticker/a/b from being read as one symbol — and source is the only place that
  // can hold a guard whose whole value is in a change that has not happened yet.
  ok('the one-segment shape check is still there', /rest\.includes\(\'\/\'\)/.test(SRC(MOD)));
}

// ── 4. one definition, not two ───────────────────────────────────────────────
L('4. the grammar is reused, not re-implemented');
{
  const mod = SRC(MOD);
  ok('it imports normalizeSymbol and tickerPath from the grammar module',
    /import \{ normalizeSymbol, tickerPath \} from '\.\/ticker-symbol\.mjs'/.test(mod));
  ok('it imports tickerTabEnabled from the availability module',
    /import \{ tickerTabEnabled \} from '\.\/feature-availability\.mjs'/.test(mod));
  // ⚠️ EDGE-SAFE BY CONSTRUCTION. This module is imported by middleware, which runs on the edge
  // runtime: a database client, `server-only`, or anything from node: would break every request on
  // the site, not just a ticker page.
  const imports = [...noComments(mod).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  ok('⚠️ it imports NOTHING but those two pure modules',
    imports.length === 2 && imports.every((i) => i === './ticker-symbol.mjs' || i === './feature-availability.mjs'));
  ok('⚠️ no database, no server-only, no node builtins', !/server-only|node:|\/db|drizzle/.test(mod));
  // The symbol rules live in one place. A second regex here is how the two come to disagree about
  // what a symbol is — which is the whole reason verify-ticker-urls.mjs could stay unchanged.
  ok('⚠️ it does not carry its own idea of a valid symbol',
    !/A-Z0-9/.test(noComments(mod).replace(/const PREFIX[^\n]*/, '')));
}

// ── 5. the page is cacheable, and stays cacheable ────────────────────────────
L('5. the page is cacheable, and stays cacheable');
{
  const page = SRC(PAGE);
  // ⚠️ A LITERAL. Next's static analysis accepts an imported identifier here and then SILENTLY
  // IGNORES it — the exact trap the homepage work hit with HOME_CACHE_SECONDS.
  ok('⚠️ revalidate is exported as a numeric literal', /^export const revalidate = \d+;$/m.test(page));
  const n = Number((page.match(/^export const revalidate = (\d+);$/m) || [])[1]);
  ok('revalidate is an hour', n === 3600);
  // ⚠️ AND THE LINE THAT ACTUALLY TURNED THE CACHE ON. `revalidate` by itself was measured to do
  // nothing at all: no dynamicRoutes entry, route printed `ƒ`, second request still no-store. A
  // dynamic segment joins the incremental cache only once generateStaticParams exists. It looks
  // like dead code, which is exactly why it needs an assertion and a mutation.
  ok('⚠️ generateStaticParams exists', /export async function generateStaticParams\(\)/.test(page));
  ok('⚠️ …and returns an empty list, so the build does not render ~19,750 pages',
    /export async function generateStaticParams\(\) \{ return \[\]; \}/.test(page));
  ok('the page does not enumerate the symbol universe at build time',
    !/knownSymbols/.test(noComments(page)));

  // The built manifest is the build’s own answer to the same question, so read it when there is one.
  try {
    const man = JSON.parse(readFileSync(new URL('../.next/prerender-manifest.json', import.meta.url), 'utf8'));
    ok('⚠️ the build registers /ticker/[symbol] as an incrementally cached route',
      Object.keys(man.dynamicRoutes || {}).includes('/ticker/[symbol]'));
  } catch {
    ok('(no build on disk — the manifest assertion is skipped, not passed)', true);
  }
  // ⚠️ THE ONE LINE THE WHOLE FIX DEPENDS ON. Reading searchParams anywhere in this file opts the
  // route out of static rendering for EVERY request, including the ones that never redirect.
  ok('⚠️ the page does not read searchParams', !/searchParams/.test(noComments(page)));
  ok('the backstop 308 is still there', /if \(raw !== sym\) permanentRedirect\(tickerPath\(sym\)\);/.test(page));
  ok('a malformed segment is still a 404', /if \(!sym\) notFound\(\);/.test(page));

  // ⚠️ THE RENDER IS NOW SHARED BETWEEN VISITORS, so anything per-viewer in it would be served to
  // the wrong person. This is the same argument that made the homepage shareable.
  const clean = noComments(page);
  for (const api of ['auth(', 'cookies(', 'headers(', 'currentUser(']) {
    ok(`⚠️ no ${api}) in the cached render`, !clean.includes(api));
  }
  ok('only the public half of the bundle still crosses to the client',
    /ssr=\{view\}/.test(page) && /bundle\?\.public/.test(page));
  // ⚠️ AND NO PER-VIEWER DATA SOURCE IS EVEN IMPORTED. The copy on this page legitimately
  // contains the words "Stock Price" and "stock quote" — what must not be here is a module that
  // resolves either one for a particular person, because the render is now shared.
  const serverImports = [...clean.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  ok('⚠️ no entitlement or quote module is imported into the shared render',
    !serverImports.some((i) => /entitlement|quotes?$|market-data|pricing/.test(i)));
}

// ── 6. the redirect answers before Clerk ─────────────────────────────────────
L('6. middleware order');
{
  const mw = SRC(MW);
  ok('middleware imports the decision', /tickerCanonicalRedirect/.test(mw));
  ok('it reads the tab from the query string', /searchParams\.get\('tab'\)/.test(mw));
  ok('⚠️ the 308 is permanent, not temporary', /NextResponse\.redirect\(new URL\(to, req\.url\), 308\)/.test(mw));
  const clean = noComments(mw);
  const atRedirect = clean.indexOf('tickerCanonicalRedirect(');
  const atClerk = clean.indexOf('withClerk(req');
  // ⚠️ ORDER IS THE POINT. The decision is a pure function of the URL — no session, no cookie, no
  // network — so it must not be able to fail because Clerk did. A missing or domain-locked
  // CLERK_SECRET_KEY makes clerkMiddleware throw on every path, which is exactly what happens on a
  // developer machine, and the ticker redirect has to keep working through it.
  ok('⚠️ the ticker redirect is decided BEFORE clerkMiddleware runs',
    atRedirect > 0 && atClerk > atRedirect);
  ok('clerkMiddleware still handles everything else', /return withClerk\(req, event\);/.test(clean));

  // Nothing about the protected-route behaviour may have changed.
  ok('the protected routes are unchanged', /'\/account\(\.\*\)'/.test(mw) && /'\/watchlist\(\.\*\)'/.test(mw));
  ok('the signed-out redirect still carries path + query',
    /redirect_url', req\.nextUrl\.pathname \+ req\.nextUrl\.search/.test(mw));
  ok('the matcher is unchanged', /\/\(api\|trpc\)\(\.\*\)/.test(mw));
}

// ── 7. nothing unrelated was touched ─────────────────────────────────────────
L('7. what must not have moved');
{
  ok('the sitemap still derives its ticker set from knownSymbols',
    /knownSymbols\(\)/.test(SRC('src/app/sitemap.js')));
  ok('robots.txt still allows the ticker pages', !/ticker/.test(SRC('src/app/robots.js')));
  ok('the self-canonical is still set per symbol',
    /alternates: \{ canonical: url \}/.test(SRC(PAGE)));
  ok('the indexability gate is untouched',
    /isKnownSymbol/.test(SRC(PAGE)) && /EXISTS \(SELECT 1 FROM security_identity/.test(SRC('src/lib/ticker-resolve.server.mjs')));
  ok('the grammar module still has no imports at all',
    !/^import /m.test(SRC('src/lib/ticker-symbol.mjs')));
}

// ── 8. a running server, which is the only real proof ────────────────────────
if (BASE) {
  L(`8. measured against ${BASE}`);
  const head = async (p) => {
    const r = await fetch(BASE + p, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } });
    return { status: r.status, cc: r.headers.get('cache-control') || '', cache: r.headers.get('x-nextjs-cache') || '', loc: r.headers.get('location') || '' };
  };
  // First request populates, second must be served from the cache.
  const first = await head('/ticker/AAPL');
  const second = await head('/ticker/AAPL');
  ok('a canonical ticker page answers 200', first.status === 200 && second.status === 200);
  ok('⚠️ it is no longer private/no-store', !/no-store/.test(second.cc));
  ok('⚠️ it carries a shared-cache lifetime', /s-maxage=\d+/.test(second.cc));
  ok('⚠️ the second identical request is served from the cache', /HIT|STALE/.test(second.cache));

  const low = await head('/ticker/aapl');
  ok('a lowercase URL still 308s', low.status === 308);
  ok('…to the uppercase URL', /\/ticker\/AAPL$/.test(low.loc));

  // ⚠️ THE CACHE IS KEYED BY PATH. If the 308 were cached, these two would have to agree, and one
  // of the two readers would be sent to the wrong tab.
  const a = await head('/ticker/aapl?tab=news');
  const b = await head('/ticker/aapl?tab=insider');
  ok('?tab=news survives the hop', /\/ticker\/AAPL\?tab=news$/.test(a.loc));
  ok('⚠️ ?tab=insider is not answered with the cached news redirect', /\/ticker\/AAPL\?tab=insider$/.test(b.loc));
  const tracked = await head('/ticker/aapl?utm_source=x&ref=y');
  ok('tracking parameters are dropped', /\/ticker\/AAPL$/.test(tracked.loc));

  const nf = await head('/ticker/AA%20PL');
  ok('a malformed symbol is still a 404', nf.status === 404);

  // Nothing else regressed.
  const home = await head('/');
  ok('the homepage is still prerendered', home.status === 200 && /HIT|STALE/.test(home.cache));
  const ins = await head('/insiders');
  ok('/insiders is still prerendered', ins.status === 200 && /HIT|STALE/.test(ins.cache));
}

if (!QUIET) {
  if (failures.length) { console.log('\nFAILED:'); failures.forEach((f) => console.log('  - ' + f)); }
  console.log(`\n${passed} passed, ${failures.length} failed`);
}

// ── mutation run ─────────────────────────────────────────────────────────────
// Green assertions prove nothing until breaking the thing they are about turns them red.
if (MUTATE) {
  const FILES = { PAGE, MW, MOD };
  const originals = Object.fromEntries(Object.values(FILES).map((f) => [f, SRC(f)]));
  const path = (rel) => new URL('../' + rel, import.meta.url);
  const restore = () => { for (const [f, s] of Object.entries(originals)) writeFileSync(path(f), s); };

  const mutations = [
    ['generateStaticParams deleted, which silently un-caches the route', PAGE,
      (s) => s.replace('export async function generateStaticParams() { return []; }', '')],
    ['generateStaticParams enumerates 19,750 symbols at build time', PAGE,
      (s) => s.replace('export async function generateStaticParams() { return []; }',
        "import { knownSymbols } from '../../../lib/ticker-resolve.server.mjs';\nexport async function generateStaticParams() { return (await knownSymbols()).map((symbol) => ({ symbol })); }")],
    ['revalidate removed entirely', PAGE, (s) => s.replace(/export const revalidate = 3600;/, '')],
    ['revalidate is an imported identifier, which Next ignores', PAGE,
      (s) => s.replace('export const revalidate = 3600;', 'const HOUR = 3600;\nexport const revalidate = HOUR;')],
    ['revalidate shortened to a value nobody chose', PAGE, (s) => s.replace('= 3600;', '= 60;')],
    ['the page reads searchParams again', PAGE,
      (s) => s.replace('export default async function Page({ params }) {', 'export default async function Page({ params, searchParams }) {\n  const sp = await searchParams;')],
    ['the backstop 308 is deleted', PAGE, (s) => s.replace('if (raw !== sym) permanentRedirect(tickerPath(sym));', '')],
    ['the 404 for a malformed segment is deleted', PAGE, (s) => s.replace('if (!sym) notFound();', '')],
    ['the page resolves auth on the server', PAGE,
      (s) => s.replace('const bundle = await getTickerSeoBundle(sym);', 'const u = await auth();\n  const bundle = await getTickerSeoBundle(sym);')],
    ['eligibility crosses to the client', PAGE, (s) => s.replace('ssr={view}', 'ssr={bundle}')],
    ['the redirect answers AFTER Clerk', MW,
      (s) => s.replace('export default function middleware(req, event) {',
        'export default async function middleware(req, event) {\n  const early = await withClerk(req, event);\n  if (early) return early;')],
    ['the redirect becomes temporary', MW, (s) => s.replace('req.url), 308)', 'req.url), 307)')],
    ['middleware stops reading the tab', MW, (s) => s.replace("tab: req.nextUrl.searchParams.get('tab'),", 'tab: undefined,')],
    ['the protected-route redirect loses its query', MW,
      (s) => s.replace('req.nextUrl.pathname + req.nextUrl.search', 'req.nextUrl.pathname')],
    ['a canonical URL redirects to itself', MOD, (s) => s.replace('if (raw === sym) return null;', '')],
    ['an unreadable segment is redirected instead of 404d', MOD, (s) => s.replace('if (!sym) return null;', 'if (!sym) return PREFIX;')],
    ['a disabled tab survives the hop', MOD, (s) => s.replace('tickerTabEnabled(tab) ? tab : undefined', 'tab')],
    ['deeper paths are treated as symbols', MOD, (s) => s.replace("if (!rest || rest.includes('/')) return null;", 'if (!rest) return null;')],
    ['every path is treated as a ticker path', MOD, (s) => s.replace('!pathname.startsWith(PREFIX)', 'false')],
    ['the module grows its own symbol regex', MOD,
      (s) => s.replace("const sym = normalizeSymbol(raw);", "const sym = /^[A-Z0-9.-]{1,10}$/.test(raw.toUpperCase()) ? raw.toUpperCase() : null;")],
    ['the module reaches for the database', MOD,
      (s) => s.replace("import { tickerTabEnabled } from './feature-availability.mjs';", "import { tickerTabEnabled } from './feature-availability.mjs';\nimport { db } from './db';")],
    ['the percent-decode stops being guarded', MOD,
      (s) => s.replace('try { raw = decodeURIComponent(rest); } catch { return null; }', 'raw = decodeURIComponent(rest);')],
  ];

  let caught = 0;
  console.log('\n── mutations ──');
  for (const [label, file, fn] of mutations) {
    const before = originals[file];
    const after = fn(before);
    if (after === before) { console.log(`  NOT APPLIED  ${label}`); continue; }
    writeFileSync(path(file), after);
    let red = false;
    try {
      execFileSync(process.execPath, [new URL(import.meta.url).pathname.replace(/^\//, ''), '--quiet'], { stdio: 'pipe' });
    } catch { red = true; }
    restore();
    if (red) { caught++; console.log(`  caught       ${label}`); }
    else console.log(`  SURVIVED     ${label}`);
  }
  restore();
  console.log(`\n${caught}/${mutations.length} mutations caught`);
  if (caught !== mutations.length) process.exitCode = 1;
}

if (failures.length) process.exitCode = 1;
