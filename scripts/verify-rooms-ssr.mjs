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
// ⚠️ LINE ENDINGS ARE NORMALISED HERE, AND THIS SUITE FAILED WITHOUT IT.
//
// This repo is checked out with core.autocrlf=true, so working-tree files carry CRLF — and several
// assertions below slice a function body with indexOf('\n}\n') to scope a check to one reader.
// Against CRLF that finds nothing, the slice comes back wrong, and the assertion reports a
// regression that is not there. It surfaced after a `git stash` round-trip rewrote these files with
// CRLF: two checks went red while the code they guard was untouched.
//
// It is NOT cosmetic. A check that passes only on an LF checkout is a check that fails for the next
// person on this repo's own default — the same class of defect as the suite that cried wolf against
// production. One normalisation, every assertion covered.
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
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

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 9. /dividends IS CACHED NOW, AND ITS DAY BOUNDARY STILL SELF-HEALS ===');
{
  const page = code('src/app/dividends/page.jsx');
  const client = code('src/app/dividends/DividendsClient.jsx');

  // ⚠️ THIS ROOM WAS NEVER THE RENDERING PROBLEM — IT WAS THE COST. It already served 4,958 words
  // and 298 ticker links to a crawler, more than any other room, and paid four queries and a
  // 300-row render for EVERY request, with x-vercel-cache MISS on an immediate repeat.
  ok('/dividends is no longer force-dynamic',
    mut('forcedynamic') ? false
      : !/export const dynamic\s*=\s*['"]force-dynamic['"]/.test(page));
  const lit = page.match(/export const revalidate = (\d+);/);
  ok('…and declares a revalidation window as a literal', !!lit, lit?.[1]);
  ok('…equal to the other rooms', Number(lit?.[1]) === Number(srv.match(/ROOM_CACHE_SECONDS\s*=\s*(\d+)/)?.[1]));

  // ⚠️ THE ONE THING CACHING BROKE, AND IT HAD TO BE FIXED IN THE CLIENT. `today` is computed at
  // generation time, and DividendsClient deliberately does NOT refetch on mount — "the server
  // already rendered the opening week" — so for up to one window after UTC midnight a cached copy
  // would open on yesterday with nothing to correct it.
  ok('⚠️ the client re-asks when the cached day is no longer today',
    mut('noselfheal') ? false
      : /if \(!first\.current \|\| !initial\?\.from\) return;/.test(client)
        && /if \(today !== initial\.from\) setAnchor\(today\)/.test(client));

  // ⚠️ AND IT MUST NOT CLEAR `first` ITSELF, or the normal path pays a mount fetch it was written
  // to avoid — which is a performance regression introduced by a correctness fix.
  const heal = client.slice(client.indexOf('if (!first.current || !initial?.from) return;'));
  ok('…without clearing the flag that prevents a mount fetch in the normal case',
    !/first\.current = false/.test(heal.slice(0, heal.indexOf('}, [initial?.from]);'))));

  // The calendar stays one URL. A page per day or per ticker is index bloat, and was rejected.
  ok('…and it is still one route, not a URL per day', !fs.existsSync(path.join(ROOT, 'src/app/dividends/[date]')));
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 10. /institutions PUBLISHES THE LOGGED-OUT VIEW, CAPPED EXACTLY AS THE API CAPS IT ===');
{
  const page = code('src/app/institutions/page.jsx');
  const client = code('src/app/institutions/InstitutionsClient.jsx');
  const lib = code('src/lib/institutions-queries.mjs');
  const route = code('src/app/api/institutions/route.js');

  ok('/institutions reads its filings on the server',
    /readInstitutionsRoom\s*\(/.test(page) && /rooms-server\.mjs/.test(page));
  ok('…and hands them to the client', /initialLatest=\{/.test(page));
  ok('…whose first state IS that payload',
    mut('instnull') ? false : /useState\(initialLatest\)/.test(client));
  const lit = page.match(/export const revalidate = (\d+);/);
  ok('…at the shared window, as a literal',
    Number(lit?.[1]) === Number(srv.match(/ROOM_CACHE_SECONDS\s*=\s*(\d+)/)?.[1]), lit?.[1]);

  // ⚠️ THIS ROOM IS THE ONE THAT IS ROW-GATED, so the cap is the assertion that matters most.
  // Shared HTML is the logged-out view by definition; publishing the signed-in product into an
  // anonymous cache is the failure this guards.
  // ⚠️ THIS ASSERTION PINNED THE PAYLOAD'S SPELLING AND WENT RED WHEN THE ACTIVITY FEED JOINED IT
  // — `{ view: 'latest-filings', filings }` became `{ view: 'institutions-room', filings,
  // activity }`. Correct code, extended; the rule never moved. What matters is that the cap is
  // applied to whatever this reader returns and applied as the LOGGED-OUT view, so that is what is
  // checked now. It is the third time in this work a check has measured an implementation's
  // spelling instead of its rule.
  ok('⚠️ the server render applies the logged-out row cap explicitly',
    mut('nocap') ? false : /publicCap\([\s\S]{0,120}?\{ loggedIn: false \}\)/.test(srv));
  ok('…and the cap has one definition, shared with the route',
    /export function publicCap/.test(lib)
      && /publicCapShared/.test(route)
      && !/const publicCap = \(payload\) => \{/.test(route));

  // ⚠️ AND ffRel IS THE LICENSING PREDICATE FOR fund_filings — same rule as ctCut and
  // NOT_SUPERSEDED. One definition, both callers.
  ok('⚠️ ffRel — the 13F freshness boundary — has one definition',
    mut('twoffrel') ? false
      : /export const ffRel/.test(lib) && !/^const ffRel/m.test(route) && /institutions-queries\.mjs/.test(route));
  // ⚠️ AND THE CUTOFF MUST REACH BOTH 13F QUERIES, NOT JUST THE ONE THIS ONCE NAMED. The reader
  // now resolves it into a local and passes it to latestFilings AND latestActivity; an assertion
  // on the first call site alone would have passed while the second served the Pro dataset.
  {
    const body = srv.slice(srv.indexOf('export async function readInstitutionsRoom'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 1);
    ok('…and the server render passes the free cutoff through it',
      mut('instcutoff') ? false
        : /const cutoff = freeCutoff\(/.test(fn)
          && /latestFilings\(25, cutoff\)/.test(fn)
          && /latestActivity\(\{ cutoff \}\)/.test(fn));
  }

  // The reader fails soft like every other.
  ok('readInstitutionsRoom returns null on failure',
    /export async function readInstitutionsRoom[\s\S]*?catch \{ return null; \}/.test(srv));

  // ⚠️ THE ONE THING SERVER-RENDERING THIS ROOM BROKE, AND IT WAS A PRE-EXISTING BUG.
  // LatestActivity shared ONE loading flag across two deliberately independent fetches, so the tab
  // whose data had not arrived fell through to its empty state: "No position changes disclosed in
  // the recent filing window." A claim about the market, made while we had simply not finished
  // asking. Always reachable whenever filings answered first; made certain — and baked into cached
  // HTML — by rendering filings on the server. Each tab must wait for its OWN data.
  ok('⚠️ each tab waits for its own data, so neither states a finding it has not got',
    mut('sharedloading') ? false
      : /const loading = tab === 'activity' \? activity == null : filings == null;/.test(client));
  ok('…and the shared flag that caused it is gone',
    !/const loading = activity == null && filings == null;/.test(client));
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 11. DATED EVIDENCE, FROM ONE IMPLEMENTATION ===');
{
  // ⚠️ AN AGE OR A BARE DATE IS UNREADABLE TO ANYTHING THAT DID NOT FETCH THE PAGE AT THAT MOMENT.
  // The rooms were measured with ZERO <time> elements against the homepage's twenty, on pages whose
  // whole subject is dated SEC disclosures.
  const news = code('src/components/NewsFeed.jsx');
  const ins = code('src/app/insiders/InsidersClient.jsx');

  ok('the news room dates its rows through the shared StoryAge',
    mut('twotime') ? false : /<StoryAge n=\{n\}/.test(news) && !/<time /.test(news));
  ok('…and the insider table dates its filings',
    mut('nodates') ? false : /<time dateTime=\{iso\}>/.test(ins));

  // ⚠️ THE ATTRIBUTE IS EMITTED ONLY WHEN THERE IS A DATE. An invented timestamp is worse than no
  // timestamp, so both implementations fall back to plain text rather than an empty attribute.
  ok('⚠️ neither invents a timestamp when the date is missing',
    /const iso = isoOrNull\(d\);/.test(ins) && /iso \? <time/.test(ins));

  // Build-output check: the HTML must actually carry them.
  const built = path.join(ROOT, '.next/server/app/insiders.html');
  if (!fs.existsSync(built)) L('  --    no build output; run `next build` to include this check');
  else {
    const tags = fs.readFileSync(built, 'utf8').match(/<time[^>]*>/gi) || [];
    const dated = tags.filter((t) => /datetime=/i.test(t)).length;
    // ⚠️ HTML ATTRIBUTE NAMES ARE CASE-INSENSITIVE, so React's `dateTime` serialises as an
    // attribute every parser reads as `datetime` — confirmed in a real browser, where
    // document.querySelectorAll('time[datetime]') finds them. A case-sensitive assertion here
    // would report zero and be wrong.
    ok('the built /insiders HTML carries dated evidence', tags.length > 0 && dated === tags.length,
      `${tags.length} <time>, ${dated} dated`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 12. THE SECOND WAVE: SIX MORE ROOMS, ON THE CLOSING BASIS ONLY ===');
//
// ⚠️ THE MARKET-DATA DECISION THIS WAVE IMPLEMENTS, IN THE OWNER'S WORDS: "Guests and search
// crawlers receive licensed previous-session closing prices and publicly distributable historical
// research. Registered Free users receive licensed delayed market data. Pro subscribers receive
// the fastest licensed real-time data. Never put delayed or real-time subscriber-specific data
// into public server-rendered HTML."
//
// So these rooms divide into three kinds and the assertions differ by kind:
//   NO PRICES AT ALL  /markets (catalyst board), /fear-greed (a computed index)
//   CLOSING BASIS     /heatmap movers, /scan boards, /screener rows
//   DISCLOSURE ONLY   the institutional activity feed (13F position changes)
const WAVE2 = [
  { route: '/markets', page: 'src/app/markets/page.jsx', reader: 'readMarketsRoom',
    prop: 'initialSnap', client: 'src/app/markets/MarketsClient.jsx' },
  { route: '/fear-greed', page: 'src/app/fear-greed/page.jsx', reader: 'readFearGreedRoom',
    prop: 'initialData', client: 'src/app/fear-greed/FearGreedClient.jsx' },
  { route: '/heatmap', page: 'src/app/heatmap/page.jsx', reader: 'readMoversRoom',
    prop: 'initialMovers', client: 'src/app/heatmap/MarketHeatmapClient.jsx' },
  { route: '/scan', page: 'src/app/scan/page.jsx', reader: 'readScanRoom',
    prop: 'initialBoards', client: 'src/app/scan/ScanClient.jsx' },
  { route: '/screener', page: 'src/app/screener/page.jsx', reader: 'readScreenerRoom',
    prop: 'initialData', client: 'src/app/screener/ScreenerClient.jsx' },
];
{
  const win = Number(srv.match(/ROOM_CACHE_SECONDS\s*=\s*(\d+)/)?.[1]);
  for (const r of WAVE2) {
    const page = code(r.page);
    const client = code(r.client);
    ok(`${r.route} reads its room on the server`,
      mut('unwire2') ? false : new RegExp(`${r.reader}\\s*\\(`).test(page) && /rooms-server\.mjs/.test(page));
    ok(`…and hands it to the client as ${r.prop}`, new RegExp(`${r.prop}=\\{`).test(page));
    ok(`…whose first state IS that payload`,
      mut('usestatenull2') ? false
        : new RegExp(`useState\\(\\s*${r.prop}`).test(client)
          || new RegExp(`initial: ${r.prop}`).test(client));
    const lit = page.match(/export const revalidate = (\d+);/);
    ok(`…at the shared window, as a literal`, Number(lit?.[1]) === win, lit?.[1]);
    ok(`…and reads no session and no searchParams in the page`,
      !/auth\(|currentUser|cookies\(|headers\(|searchParams/.test(page));
  }

  // ⚠️ THE ENTITLEMENT OVERRIDE CAN ONLY NARROW, AND THAT IS THE WHOLE SAFETY ARGUMENT FOR /scan.
  // loadScanContext used to resolve callerHasRealtime() unconditionally; a cached page has no
  // caller, so it STATES the unentitled view instead. `=== false` is the entire gate: any other
  // value falls through to the real resolution, so no caller can grant itself realtime.
  const sp = code('src/lib/scan/board-payload.js');
  ok('⚠️ the scan entitlement override narrows and can never widen',
    mut('widenscan') ? false
      : /const realtime = stated === false \? false : await callerHasRealtime\(\);/.test(sp));
  ok('…and the server render states it rather than resolving one',
    /buildAllScanBoards\(\{ realtime: false \}\)/.test(srv));

  // ⚠️ THE MARKETS READER MUST NAME ITS KEYS RATHER THAN SPREAD THE BLOB, AND THIS ASSERTION
  // EXISTS BECAUSE A REAL MUTATION SLIPPED PAST THE SUITE. The reader's own comment claims that
  // naming the four arrays makes "no market data" STRUCTURAL rather than a promise — but spreading
  // `...snap` alongside them passed every check, and a future pit_snapshot that gains a `tape` or a
  // `marketSnap` would then publish prices into cached HTML on the next cron deploy. A claim in a
  // comment that nothing enforces is just a hope.
  const marketsFn = (() => {
    const b = srv.slice(srv.indexOf('export async function readMarketsRoom'));
    return b.slice(0, b.indexOf('\n}\n') + 1);
  })();
  ok('⚠️ the markets reader names its keys and never spreads the snapshot',
    mut('spreadsnap') ? false
      : /catalysts: pick\(snap\.catalysts\)/.test(marketsFn) && !/\.\.\.snap/.test(marketsFn));

  // ⚠️ AND THE MOVERS PATH IS EOD BY CONSTRUCTION, NOT BY A LABEL. marketMovers with realtime
  // false takes completedSessionMovers and makes no vendor call at all.
  ok('⚠️ the heatmap movers are read on the completed-session path',
    mut('rtmovers') ? false : /marketMovers\(\{ realtime: false, limit: 10 \}\)/.test(srv));
  ok('…and a non-eod freshness is refused outright rather than rendered',
    /if \(m\.freshness && m\.freshness !== 'eod'\) return null;/.test(srv));

  // ⚠️ THE SCREENER'S DEFAULT SORT MUST EQUAL THE CLIENT'S OWN useState DEFAULT, or the server
  // renders one ranking and the browser's first render produces another — a hydration mismatch,
  // which means React discards the server's HTML and the crawler's copy is the unchecked one.
  const sortLib = code('src/lib/screener-page.mjs').match(/SCREENER_DEFAULT_SORT = '([^']+)'/)?.[1];
  const sortClient = code('src/app/screener/ScreenerClient.jsx').match(/useState\('([a-zA-Z0-9]+)'\);\s*$/m);
  ok('⚠️ the screener server render opens on the same sort the client does',
    mut('sortdrift') ? false
      : sortLib === 'insiderNet90d' && /useState\('insiderNet90d'\)/.test(code('src/app/screener/ScreenerClient.jsx')),
    `lib=${sortLib}`);
  void sortClient;

  // ⚠️ AND THE BAILOUT THAT COST THAT PAGE ITS ENTIRE RENDER MUST NOT COME BACK. useSearchParams
  // makes Next bail the nearest Suspense boundary out of static rendering; with fallback={null}
  // around this component the boundary emitted NOTHING, which is the whole explanation for the four
  // words /screener served. It was read once, in a mount effect, where the browser's own URL does.
  ok('⚠️ /screener does not re-acquire the static-render bailout',
    mut('bailout') ? false : !/useSearchParams/.test(code('src/app/screener/ScreenerClient.jsx')));

  // Every indexable room needs exactly one h1. Two had NONE.
  for (const f of ['src/app/screener/ScreenerClient.jsx', 'src/app/fear-greed/FearGreedClient.jsx']) {
    ok(`${f.split('/').slice(-1)[0]} has a heading element at all`,
      mut('noh1') ? false : /<h1/.test(code(f)));
  }
}

// ───────────────────────────────────────────────────────────────────────────
L('\n=== 13. ⚠️ NO DELAYED OR REAL-TIME DATA IN ANY CACHED PAGE ===');
{
  const dir = path.join(ROOT, '.next/server/app');
  if (!fs.existsSync(dir)) {
    L('  --    no build output; run `next build` to include these checks');
  } else {
    // ⚠️ THIS IS THE ASSERTION THE WHOLE WAVE TURNS ON, AND IT IS MADE AGAINST THE RENDERED BYTES
    // RATHER THAN THE SOURCE. Reading the readers tells you what was intended; reading the HTML
    // tells you what shipped. A prerendered page is served to everyone, so a single `delayed` or
    // `realtime` freshness marker in one is a licensing fault, not a cosmetic one.
    const ROOMS_HTML = ['index', 'markets', 'heatmap', 'fear-greed', 'scan', 'screener',
      'institutions', 'insiders', 'politicians', 'news', 'consensus', 'dividends'];
    let bad = [];
    let eodSeen = 0;
    for (const r of ROOMS_HTML) {
      const f = path.join(dir, r + '.html');
      if (!fs.existsSync(f)) continue;
      const h = fs.readFileSync(f, 'utf8');
      // The freshness markers as they appear in a serialized payload, in either quoting style.
      const rt = (h.match(/freshness[\\"':]{1,8}realtime/gi) || []).length;
      const dl = (h.match(/freshness[\\"':]{1,8}delayed/gi) || []).length;
      eodSeen += (h.match(/freshness[\\"':]{1,8}eod/gi) || []).length;
      if (rt || dl) bad.push(`${r}(realtime:${rt} delayed:${dl})`);
    }
    ok('⚠️ no prerendered room carries a realtime or delayed freshness marker',
      mut('leak') ? false : bad.length === 0, bad.join(' ') || 'none');
    // ⚠️ AND THE ABSENCE MUST NOT BE BECAUSE NOTHING IS LABELLED AT ALL. A page with no freshness
    // anywhere would pass the check above while telling a reader nothing about what they are
    // looking at — so at least one room must positively carry the completed-session label.
    ok('…and the closing basis IS positively labelled, not merely unlabelled',
      mut('nolabel') ? false : eodSeen > 0, `${eodSeen} eod markers`);
  }
}

L(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { L('FAILED:'); fails.forEach((f) => L('  - ' + f)); process.exit(1); }
L('EVERY ROOM SSR CHECK PASSED');
