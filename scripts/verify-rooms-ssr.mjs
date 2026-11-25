// ═══════════════════════════════════════════════════════════════════════════
//  VERIFY — THE RESEARCH ROOMS PUBLISH THEIR RESEARCH, AND STAY CHEAP AND LICENSED
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ WHAT THIS SUITE IS GUARDING, IN ONE SENTENCE: the rooms behind the front door must publish
// their own research to a reader with no JavaScript, WITHOUT becoming dynamic, WITHOUT baking a
// licensed price into a shared cache, and WITHOUT serving one tier's freshness to everyone.
//
// The measurement it exists to answer, from production on 2026-11-24 as Googlebot with no JS:
//
//     route          words  /ticker links  <time>  tbody
//     /insiders        376              0       0      0
//     /politicians     264              0       0      1   ← a <table> with no rows in it
//     /consensus       163              0       0      0
//     /news            129              0       0      0
//
// Nine of twelve indexable rooms served the column headings and nothing underneath. The data was
// already in the cache and already public.
//
// ⚠️ FOUR KINDS OF ASSERTION, AND THEY ARE NOT INTERCHANGEABLE:
//
//   PUBLICATION  each page must actually read its room and hand the payload to the client, and the
//                client must actually START from it. A reader nobody calls publishes nothing.
//   CACHEABILITY the page must stay prerendered. An uncached fetch in a server component opts the
//                whole route out of static generation — measured twice in this repo — which would
//                mean paying a KV round-trip per visitor to win a crawler benefit. That is the one
//                trade this work is not allowed to make.
//   LICENSING    no price, no quote, no tape in shared HTML; and the FREE end-of-day cutoff on
//                every disclosure read, because cached HTML is served to everyone. An anonymous
//                caller was once served 48 insider rows past the Free cutoff by a route that
//                skipped this predicate.
//   NO SECOND DEFINITION  a rule that now has two callers must have ONE definition. Two copies of
//                NOT_SUPERSEDED is how a retracted filing comes back on one surface after being
//                fixed on the other, and /api/insiders was itself the consumer that got missed.
//
// ⚠️ AND WHAT IT CANNOT CHECK. Whether the rendered HTML contains those rows, and whether React
// KEEPS it, are browser questions. They are answered by driving a real browser against the built
// output — hydration complaints, the row count before the client's fetch returns and again after —
// not by string-matching source. See [[catalystpit-verify-client-rendered]]: the payload being
// right has already proved nothing about the page once in this codebase.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Comments quote the code they explain, so an assertion that greps source must strip them first —
// three times in this repo a check has matched its own explanation and reported a false result.
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

let pass = 0; const fails = [];
const L = (s) => console.log(s);
function ok(label, cond, detail) {
  if (cond) { pass++; L(`  ok    ${label}${detail ? `  — ${detail}` : ''}`); }
  else { fails.push(label); L(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
}
// Mutation hooks: the harness sets VERIFY_MUTATE to force one assertion to the failing side, so a
// run can prove the assertion is load-bearing rather than vacuously true.
const mut = (k) => (process.env.VERIFY_MUTATE || '').split(',').includes(k);

const srv = code('src/lib/rooms-server.mjs');

// The four rooms this change covers, with the prop each one threads and the client that takes it.
const ROOMS = [
  { route: '/news', page: 'src/app/news/page.jsx', reader: 'readNewsRoom', prop: 'initialData',
    client: 'src/components/NewsFeed.jsx', gated: false },
  { route: '/consensus', page: 'src/app/consensus/page.jsx', reader: 'readConsensusRoom', prop: 'initialBoard',
    client: 'src/app/consensus/ConsensusClient.jsx', gated: false },
  { route: '/insiders', page: 'src/app/insiders/page.jsx', reader: 'readInsidersRoom', prop: 'initialData',
    client: 'src/app/insiders/InsidersClient.jsx', gated: true },
  { route: '/politicians', page: 'src/app/politicians/page.jsx', reader: 'readPoliticiansRoom', prop: 'initialList',
    client: 'src/app/politicians/PoliticiansList.jsx', gated: true },
];

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 1. EVERY ROOM ACTUALLY PUBLISHES ITS RESEARCH ===');
for (const r of ROOMS) {
  const page = code(r.page);
  const client = code(r.client);

  ok(`${r.route} reads its room on the server`,
    mut('unwire') ? false : new RegExp(`${r.reader}\\s*\\(`).test(page)
      && /rooms-server\.mjs/.test(page));

  ok(`…and hands the payload to the client as ${r.prop}`,
    new RegExp(`${r.prop}=\\{`).test(page));

  ok(`…and the client's component signature accepts it`,
    new RegExp(`\\{[^)]*${r.prop}\\s*=\\s*null`).test(client));

  // ⚠️ THE STATE MUST START FROM THE PROP, NOT MERELY RECEIVE IT. A component that takes
  // initialData and still calls useState(null) renders the empty state on the server, which is the
  // original bug wearing the fix's clothes.
  ok(`…and its first state IS that payload, not null`,
    mut('usestatenull') ? false
      : new RegExp(`useState\\(\\s*${r.prop}`).test(client));

  // ⚠️ AND loading MUST NOT START true. Starting in the loading state with a full payload in hand
  // renders a skeleton over research that is already on screen — a visible regression traded for
  // an invisible gain.
  ok(`…and loading starts false when the server answered`,
    mut('loadingtrue') ? false
      : new RegExp(`useState\\(!${r.prop}\\)`).test(client));

  // ⚠️ THE FIRST FETCH MUST NOT RE-ENTER THE LOADING STATE EITHER. Every one of these components
  // refetches on mount, and each announced it with an unconditional setLoading(true) — which blanks
  // the server's rows for the length of a request that returns the same thing.
  ok(`…and the mount refetch does not flash the server render away`,
    mut('flash') ? false : /serverRendered/.test(client));
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 2. THE ROOMS STAY PREREGENERATED, NOT RENDERED PER REQUEST ===');
{
  const m = srv.match(/ROOM_CACHE_SECONDS\s*=\s*(\d+)/);
  ok('rooms-server declares one cache window', !!m, m?.[1]);
  const win = Number(m?.[1]);

  for (const r of ROOMS) {
    const page = code(r.page);
    // ⚠️ A LITERAL, NOT THE IMPORTED CONSTANT. Next statically analyses this export at build time;
    // an imported identifier is accepted and then SILENTLY IGNORED. That is exactly how 19,750
    // ticker pages stayed uncacheable through a deploy whose source looked correct.
    const lit = page.match(/export const revalidate = (\d+);/);
    ok(`${r.route} declares revalidate as a numeric literal`,
      mut('nolit') ? false : !!lit, lit?.[1]);
    ok(`…and it equals ROOM_CACHE_SECONDS`, Number(lit?.[1]) === win);
    ok(`…and the page is not force-dynamic`,
      !/export const dynamic\s*=\s*['"]force-dynamic['"]/.test(page));
  }

  // ⚠️ THE READ ITSELF DECIDES THIS, NOT THE PAGE. `cache: 'no-store'` inside a server component
  // reclassifies the route however the page is declared.
  ok('the KV read is cached for the window, not no-store',
    mut('nostore') ? false
      : /next: \{ revalidate: ROOM_CACHE_SECONDS \}/.test(srv) && !/no-store/.test(srv));

  // ⚠️ THE SAME RULE IN BOTH READERS, ASSERTED ACROSS FILES. lib/home-server.mjs keeps its own copy
  // of this function because verify-home-ssr pins that literal inside it, so the two cannot be
  // merged without failing a suite guarding the live homepage. What can be guaranteed is the RULE,
  // which is the property that actually matters — so it is checked in both files.
  const home = code('src/lib/home-server.mjs');
  ok('⚠️ and home-server follows the identical rule, so the two readers cannot drift',
    /next: \{ revalidate: HOME_CACHE_SECONDS \}/.test(home) && !/no-store/.test(home));

  // A regeneration is not a reader asking a question: it must never trigger derived work.
  ok('a page regeneration never schedules a rebuild',
    !/scheduleRebuild|claimRefreshAttempt/.test(srv));
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 3. NOTHING ABOUT THE VIEWER REACHES A SHARED COPY ===');
{
  // ⚠️ ONE auth() ANYWHERE IN THIS PATH WOULD MAKE EVERY ROOM DYNAMIC *AND* MAKE THE CACHED COPY A
  // LIE. The root layout avoids auth() deliberately so 141 pages can stay static.
  for (const forbidden of ['auth(', 'currentUser', 'cookies(', 'headers(', '@clerk']) {
    ok(`rooms-server never reads the session: no ${forbidden}`,
      mut('session') ? false : !srv.includes(forbidden));
  }
  for (const r of ROOMS) {
    const page = code(r.page);
    ok(`${r.route}'s page reads no session either`,
      !/auth\(|currentUser|cookies\(|headers\(/.test(page));
    // searchParams anywhere in a page opts the whole route out of static rendering, for every
    // request — including the ones that never reach the branch that reads it.
    ok(`…and reads no searchParams`, !/searchParams/.test(page));
  }
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 4. NO LICENSED MARKET DATA IN CACHED PUBLIC HTML ===');
{
  // Prices are resolved per viewer by /api/quotes, which fails closed. Baking one into shared HTML
  // is a licensing decision, and this change does not make it.
  for (const banned of ['ticker_tape', 'market_snapshot', 'api/quotes', 'marketDataAccess', 'isRealtime']) {
    ok(`rooms-server reads no market data: no ${banned}`,
      mut('prices') ? false : !srv.includes(banned));
  }
  // The news reader must say so positively rather than merely omitting it.
  ok('⚠️ and the news reader states that the tape is withheld',
    /tickers: null/.test(srv));
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 5. FREE-TIER FRESHNESS, FROM THE CANONICAL RULE ===');
{
  ok('the cutoff comes from the shared entitlement rules, not a local copy',
    /from '\.\/entitlement-rules\.mjs'/.test(srv) && /eodCutoffIso/.test(srv));

  // ⚠️ 'free' IS THE WHOLE POINT. eodCutoffIso returns null for Pro, meaning NO freshness limit —
  // correct for a Pro request, and a licensing leak in cached public HTML.
  ok("⚠️ and it is resolved for the FREE tier explicitly",
    mut('protier') ? false : /eodCutoffIso\('free'/.test(srv));

  // Every reader over a gated table must pass it. A reader that forgets serves the Pro dataset.
  for (const r of ROOMS.filter((x) => x.gated)) {
    const body = srv.slice(srv.indexOf(`export async function ${r.reader}`));
    const fn = body.slice(0, body.indexOf('\n}\n') + 1);
    ok(`${r.route}'s reader passes the free cutoff`,
      mut('nocutoff') ? false : /cutoff:\s*freeCutoff\(/.test(fn));
  }

  // ⚠️ AND THE STALENESS RUNS IN THE SAFE DIRECTION, WHICH IS WHY A CACHED CUTOFF IS SOUND.
  // The boundary only moves forward, so HTML generated at T and served at T+window shows a SUBSET
  // of what a visitor is entitled to by then. Asserted on the real rule rather than described.
  const { eodCutoffIso } = await import('../src/lib/entitlement-rules.mjs');
  const t0 = Date.parse('2026-11-24T18:00:00Z');
  const later = eodCutoffIso('free', t0 + 7 * 86400000);
  ok('the free cutoff never moves backwards over a week',
    new Date(later) >= new Date(eodCutoffIso('free', t0)));
  ok('…and Pro has no cutoff at all, which is what makes the explicit tier load-bearing',
    eodCutoffIso('pro', t0) === null && eodCutoffIso('free', t0) !== null);
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 6. ONE DEFINITION, NOT TWO ===');
{
  // /news — the dedupe-then-compose pair.
  const newsRoute = code('src/app/api/news/route.js');
  const river = code('src/lib/news-river.mjs');
  ok('the news river is composed in one module',
    mut('tworiver') ? false
      : /composeRiver\(\{/.test(river) && !/composeRiver\(\{/.test(newsRoute));
  ok('…and both callers go through it',
    /buildNewsRiver/.test(newsRoute) && /buildNewsRiver/.test(srv));
  ok('…and the article display shape is shared, not re-mapped per caller',
    /normalizeArticles/.test(code('src/components/NewsFeed.jsx'))
      && /normalizeArticles/.test(srv)
      && /export function normalizeArticles/.test(code('src/lib/news-feed-view.mjs')));

  // ⚠️ normalizeArticles MUST TAKE THE CLOCK. `mins` is an AGE: computing it twice against two
  // different clocks is a guaranteed hydration mismatch, and a mismatch means React discards the
  // server's HTML while the page still looks correct to a human.
  ok('⚠️ and the article shape takes an explicit clock',
    mut('noclock') ? false
      : /export function normalizeArticles\(stories, \{ now = Date\.now\(\) \} = \{\} \)?/.test(
        code('src/lib/news-feed-view.mjs').replace(/\s+/g, ' ').replace(/ \)/g, ')'),
      ) || /normalizeArticles\(stories, \{ now/.test(code('src/lib/news-feed-view.mjs')));
  ok('…and the page passes one instant for the whole render',
    /now: Date\.now\(\)/.test(code('src/app/news/page.jsx')));

  // /insiders — the row rules.
  const insRoute = code('src/app/api/insiders/route.js');
  const insLib = code('src/lib/insider-queries.mjs');
  for (const name of ['TICKER_IS_A_SYMBOL', 'NOT_SUPERSEDED', 'ROW_VIEWS', 'enrichRows']) {
    ok(`${name} is defined in lib/insider-queries, not in the route`,
      mut('twoinsider') ? false
        : new RegExp(`export (const|async function|function) ${name}`).test(insLib)
          && !new RegExp(`^(const|async function|function) ${name}`, 'm').test(insRoute));
  }
  ok('…and the route imports them rather than keeping a copy',
    /insider-queries\.mjs/.test(insRoute));

  // /politicians — the member list and, critically, the freshness predicate.
  const polRoute = code('src/app/api/politicians/route.js');
  const polLib = code('src/lib/congress-overview.js');
  for (const name of ['ctCut', 'LIST_ORDER', 'listView']) {
    ok(`${name} is defined in lib/congress-overview, not in the route`,
      mut('twocongress') ? false
        : new RegExp(`export (const|async function) ${name}`).test(polLib)
          && !new RegExp(`^(const|async function) ${name}`, 'm').test(polRoute));
  }
  ok('⚠️ and ctCut — a licensing predicate — has exactly one definition',
    (polLib.match(/export const ctCut/g) || []).length === 1
      && !/const ctCut =/.test(polRoute));
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 7. EVERY READER FAILS SOFT, AND null IS NOT [] ===');
{
  for (const r of ROOMS) {
    const body = srv.slice(srv.indexOf(`export async function ${r.reader}`));
    const fn = body.slice(0, body.indexOf('\n}\n') + 1);
    // ⚠️ null MEANS "WE COULD NOT READ THIS" AND [] MEANS "THERE IS NOTHING", WHICH IS A CLAIM
    // ABOUT THE MARKET. A cache outage must cost a crawler the research and never cost a reader
    // the page — the client's own fetch still owns the outcome.
    ok(`${r.reader} returns null on failure, never a throw`,
      mut('failhard') ? false : /catch \{ return null; \}/.test(fn));
    ok(`…and null, not an empty answer, when there is nothing to publish`,
      /\? *[^:]*: null|: null;|return null/.test(fn));
    ok(`…and ${r.route}'s page cannot throw either`,
      /\.catch\(\(\) => null\)/.test(code(r.page)));
  }
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 8. THE BUILD AGREES (if a build is present) ===');
{
  const mf = path.join(ROOT, '.next/prerender-manifest.json');
  if (!fs.existsSync(mf)) {
    L('  --    no build output; run `next build` to include these checks');
  } else {
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    const win = Number(srv.match(/ROOM_CACHE_SECONDS\s*=\s*(\d+)/)?.[1]);
    for (const r of ROOMS) {
      const entry = m.routes?.[r.route];
      ok(`${r.route} is registered as prerendered in the manifest`, !!entry);
      ok(`…with the declared revalidation window`,
        entry?.initialRevalidateSeconds === win, String(entry?.initialRevalidateSeconds));
    }
    // ⚠️ AND THE COMPLETED WORK IS UNTOUCHED. The ticker fix is the one dynamic route that must
    // still be in the incremental cache, and the homepage must still be prerendered.
    ok('⚠️ the ticker ISR fix is still in place', !!m.dynamicRoutes?.['/ticker/[symbol]']);
    ok('⚠️ and the homepage is still prerendered at its own window',
      m.routes?.['/']?.initialRevalidateSeconds === 300);
  }
}

L(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { L('FAILED:'); fails.forEach((f) => L('  - ' + f)); process.exit(1); }
L('EVERY ROOM SSR CHECK PASSED');
