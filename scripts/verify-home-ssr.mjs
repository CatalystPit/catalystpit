// ═══════════════════════════════════════════════════════════════════════════
//  VERIFY — THE HOMEPAGE'S RESEARCH IS IN THE HTML, AND HYDRATION CANNOT MOVE IT
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ WHAT THIS SUITE IS GUARDING, IN ONE SENTENCE: the front door must publish its own research to
// a reader with no JavaScript, and the browser's first render must reproduce that HTML EXACTLY,
// because React throws the server's copy away on any mismatch — which would silently undo the whole
// change while every page still looked fine in a browser.
//
// So there are two kinds of assertion here and they are not interchangeable:
//
//   PURITY      buildHomeModel must be a pure function of its inputs and an explicit clock. This is
//               what makes the server's render and the browser's first render byte-identical. A
//               Date.now() hidden anywhere in that path is a hydration bug that only appears on a
//               slow connection, which is to say in production and not on this machine.
//   PUBLICATION the model must actually carry symbols, headlines, instants and links, and page.jsx
//               must actually hand it to the client. A pure function nobody calls publishes nothing.
//
// ⚠️ AND WHAT IT CANNOT CHECK. Whether the RENDERED HTML contains those rows is a browser question,
// answered by scripts in the scratchpad against the built output and against production, not by
// string-matching source. See [[catalystpit-verify-client-rendered]]: the payload being right has
// already proved nothing about the page once in this codebase.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Comments quote the code they explain, so an assertion that greps source must strip them first —
// twice in this repo a check has matched its own explanation and reported a false result.
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

let pass = 0; const fails = [];
const L = (s) => console.log(s);
function ok(label, cond, detail) {
  if (cond) { pass++; L(`  ok    ${label}${detail ? `  — ${detail}` : ''}`); }
  else { fails.push(label); L(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
}
// Mutation hooks: the harness sets VERIFY_MUTATE to force one assertion to the failing side, so a
// run can prove the assertion is actually load-bearing rather than vacuously true.
const mut = (k) => (process.env.VERIFY_MUTATE || '').split(',').includes(k);

const { buildHomeModel, isEmptyModel, minsSince, isoOrNull, toArr } =
  await import('../src/lib/home-model.mjs');

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 24, 15, 0, 0);          // a fixed clock, so ages are assertable
const iso = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();

// A realistic snapshot: what /api/cron/pit-snapshot actually writes.
const SNAP = {
  generatedAt: iso(0.1),
  stories: [
    { title: 'HPE just posted its strongest growth ever — but its stock is sinking',
      source: 'MarketWatch', published: iso(2), category: 'EARNINGS', ticker: 'HPE',
      summary: 'HPE achieves record growth but stock falls.', url: 'https://example.com/hpe' },
    { title: 'The biggest biotech deal in nearly three years carries a hefty $41 billion price tag',
      source: 'MarketWatch', published: iso(2.1), category: 'M&A', ticker: 'PFE',
      summary: 'A $41 billion acquisition.', url: 'https://example.com/biotech' },
  ],
  insiders: [
    { ticker: 'BORR', executive: 'Troim Tor Olav', title: 'Director', action: 'BUY',
      totalValue: 30500000, filingDate: '2026-11-23' },
    { ticker: 'FRD', executive: 'Taylor Mike J', title: 'President / CEO', action: 'BUY',
      totalValue: 134000, filingDate: '2026-11-24' },
  ],
  congress: [
    { ticker: 'AAPL', representative: 'Hon. Ed Case', party: 'Democrat', state: 'HI',
      memberSlug: 'ed-case', action: 'BUY', amountRange: '$1,001 - $15,000',
      transactionDate: '2026-11-10', disclosureDate: '2026-11-21' },
  ],
  catalysts: [
    { kind: 'BUY', label: 'LARGEST OPEN-MARKET BUY', sym: 'BORR', line: 'Troim Tor Olav bought',
      value: '$30.5M', date: '2026-11-23' },
  ],
};

const serverInputs = () => ({
  stories: SNAP.stories,
  insiderData: { trades: SNAP.insiders },
  politicianData: { trades: SNAP.congress },
  snapCatalysts: SNAP.catalysts,
  usingSnapshot: true,
  filings: [],
});

// ═══════════════════════════════════════════════════════════════════════════
L('=== THE MODEL IS PURE, WHICH IS WHAT MAKES HYDRATION SAFE ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ⚠️ THE ASSERTION THAT MATTERS MOST IN THIS FILE. React compares the server's HTML with the
  // browser's first render and discards the server copy on any difference. The server renders at
  // generation time and the browser renders at hydration time — possibly minutes later on a slow
  // connection — so if ANY age in the model is recomputed from the wall clock, the two renders
  // produce different strings and the research we just published is thrown away. Determinism is
  // not tidiness here; it is the mechanism.
  const a = JSON.stringify(buildHomeModel(serverInputs(), { now: NOW }));
  const b = JSON.stringify(buildHomeModel(serverInputs(), { now: NOW }));
  ok('two builds at the same instant are byte-identical', a === b);

  const later = JSON.stringify(buildHomeModel(serverInputs(), { now: NOW + 90 * 60_000 }));
  ok('…and a DIFFERENT clock really does change it, so the test above is not vacuous',
    a !== later, 'ages move with the clock, as they must');

  const src = code('src/lib/home-model.mjs');
  ok('the model module contains no wall-clock read outside its default parameter',
    mut('clock') ? false : (src.match(/Date\.now\(\)/g) || []).length === 2,
    `${(src.match(/Date\.now\(\)/g) || []).length} occurrences — the two \`now = Date.now()\` defaults`);
  ok('…and it does not fetch, query or import a client module',
    !/\bfetch\s*\(/.test(src) && !/from '\.\/db/.test(src) && !/cp-shared/.test(src));

  // The model is serialised into the HTML as an RSC prop, so it must survive JSON.
  const model = buildHomeModel(serverInputs(), { now: NOW });
  ok('the model round-trips through JSON unchanged',
    JSON.stringify(JSON.parse(JSON.stringify(model))) === JSON.stringify(model));

  // ⚠️ THE SINGLE LINE EVERYTHING ELSE DEPENDS ON, AND A MUTATION TEST FOUND IT UNGUARDED.
  //
  // A pure model, a cached read and an ISR page all come to nothing if the component's first state
  // is null again: React would render an empty page on the client, find it differs from the server's
  // HTML, and throw the server's copy away — tables, cards, consensus rows and all. The page would
  // still LOOK right a moment later, which is exactly why this needs an assertion rather than an
  // eye. Reverting `useState(initialData)` to `useState(null)` survived every other check here.
  const cpSrc = code('src/components/CatalystPit.jsx');
  ok('the client\'s FIRST state is the server\'s render, used verbatim',
    mut('nofirststate') ? false : /const \[data, setData\] = useState\(initialData\);/.test(cpSrc));
  ok('…and the skeletons do not replace it for a frame',
    /const \[loading, setLoading\] = useState\(!initialData\);/.test(cpSrc));
  ok('…and the component takes the props at all',
    /function CatalystPit\(\{ initialData = null, initialConsensus = null \}\)/.test(cpSrc));
}

// ═══════════════════════════════════════════════════════════════════════════
L('\n=== IT PUBLISHES REAL RESEARCH, NOT A SHAPE ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const m = buildHomeModel(serverInputs(), { now: NOW });

  ok('stories arrive with their publisher and their headline',
    m.news.length === 2 && m.news[0].source === 'MarketWatch'
      && m.news[0].headline.startsWith('HPE just posted'), m.news[0]?.headline?.slice(0, 40));
  ok('insider filings arrive with ticker, executive, action and dollar value',
    m.insiders.length === 2 && m.insiders[0].sym === 'BORR'
      && m.insiders[0].name === 'Troim Tor Olav' && m.insiders[0].type === 'BUY'
      && m.insiders[0].value === '$30.5M', JSON.stringify(m.insiders[0]));
  ok('congressional disclosures arrive with member, party, amount and DISCLOSURE date',
    m.politicians[0].sym === 'AAPL' && m.politicians[0].name === 'Hon. Ed Case'
      && m.politicians[0].disclosed === '2026-11-21', JSON.stringify(m.politicians[0]));
  ok('the catalyst cards carry a renderable symbol', m.catalysts.length === 1 && m.catalysts[0].sym === 'BORR');

  // ── the timestamps ──
  ok('a story carries BOTH a relative age and a machine-readable instant',
    m.news[0].mins === 120 && m.news[0].published === iso(2),
    `${m.news[0].mins}m / ${m.news[0].published}`);
  ok('…and an undated story gets a null instant rather than an invented one',
    mut('fakedate') ? false
      : buildHomeModel({ ...serverInputs(), stories: [{ title: 'x', source: 'y' }] }, { now: NOW })
        .news[0].published === null);
  ok('isoOrNull refuses to invent a date', isoOrNull(null) === null && isoOrNull('not a date') === null
    && isoOrNull('2026-11-21') === '2026-11-21T00:00:00.000Z');

  // ── NO PRICES. This is a licensing boundary, not a styling choice. ──
  ok('with no tape passed, the model carries no prices at all',
    mut('prices') ? false : m.tickers.length === 0 && m.spy_chg === null,
    'quotes stay behind /api/quotes and its per-viewer entitlement');
  const withTape = buildHomeModel({ ...serverInputs(), tape: [{ symbol: 'SPY', price: 1 }] }, { now: NOW });
  ok('…and the tape still works when a caller DOES pass one, so the omission is the page\'s choice',
    withTape.tickers.length === 1);
}

// ═══════════════════════════════════════════════════════════════════════════
L('\n=== A FAILED REFRESH MUST NOT ERASE A RENDERED PAGE ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ⚠️ THE TRAP: buildHomeModel SUCCEEDS WHEN EVERYTHING FAILED. All-null inputs produce a
  // well-formed object full of empty arrays. Before the server rendered anything that cost a
  // skeleton; now it would blank out real filings and present it as a quiet market.
  const empty = buildHomeModel({}, { now: NOW });
  ok('an all-failed fetch still returns a truthy, well-formed object — this is the hazard',
    !!empty && Array.isArray(empty.news) && empty.news.length === 0);
  ok('isEmptyModel recognises it', isEmptyModel(empty) === true && isEmptyModel(null) === true);
  ok('…and recognises a real one as NOT empty',
    isEmptyModel(buildHomeModel(serverInputs(), { now: NOW })) === false);
  ok('a model carrying only prices is still empty of research',
    isEmptyModel(buildHomeModel({ tape: [{ symbol: 'SPY', price: 1 }] }, { now: NOW })) === true);

  const cp = code('src/components/CatalystPit.jsx');
  ok('the component guards the swap rather than taking any truthy answer',
    mut('noguard') ? false : /if \(d && !\(hasData\.current && isEmptyModel\(d\)\)\)/.test(cp));
  ok('…and it is not the old unconditional `if (d) { setData', !/if \(d\) \{ setData/.test(cp));
}

// ═══════════════════════════════════════════════════════════════════════════
L('\n=== THE SERVER ACTUALLY CALLS IT, AND STAYS PREREGENERATED ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const page = code('src/app/page.jsx');
  const home = code('src/app/HomeClient.jsx');
  const srv = code('src/lib/home-server.mjs');

  ok('page.jsx is an async server component that reads the cache',
    /export default async function Page/.test(page) && /readPitSnapshot\(\)/.test(page));
  ok('…builds the model with the SAME function the browser uses',
    mut('nomodel') ? false : /buildHomeModel\(/.test(page)
      && /from '\.\.\/lib\/home-model\.mjs'/.test(page));
  ok('…and passes it through to the client component',
    /initialData=\{initialData\}/.test(page) && /initialData=\{initialData\}/.test(home));
  ok('the consensus board is passed too', /initialConsensus=\{consensus\}/.test(page)
    && /initialConsensus=\{initialConsensus\}/.test(home));

  // ── ⚠️ THE REGRESSION THIS CAUGHT ONCE ALREADY ──
  //
  // The first version read KV with `cache: 'no-store'` and the build reclassified `/` from a
  // prerendered route to `ƒ server-rendered on demand` — two KV round-trips in front of first byte
  // for every visitor, a performance regression caused by an SEO change. It is asserted rather
  // than remembered.
  ok('the page declares a revalidate window, so it is regenerated and not per-request',
    mut('dynamic') ? false : /export const revalidate = 300;/.test(page));
  ok('…and the KV read is cached for that same window, not `no-store`',
    mut('nostore') ? false : /next: \{ revalidate: HOME_CACHE_SECONDS \}/.test(srv)
      && !/cache: 'no-store'/.test(srv));
  ok('…with the two numbers actually equal',
    /HOME_CACHE_SECONDS = 300;/.test(srv) && /export const revalidate = 300;/.test(page));
  ok('nothing on the page resolves the viewer — no auth, no cookies, no headers',
    !/\bauth\(\)/.test(page) && !/cookies\(\)/.test(page) && !/headers\(\)/.test(page)
      && !/\bauth\(\)/.test(srv) && !/cookies\(\)/.test(srv));

  // ── the licensing boundary, asserted at the call site ──
  ok('the server passes NO tape and NO market snapshot',
    mut('serverprices') ? false : !/\btape:/.test(page) && !/\bmarketSnap:/.test(page),
    'prices are market-data-licensed and resolved per viewer');
  ok('…and the server reader does not touch the price keys either',
    !/ticker_tape/.test(srv) && !/market_snapshot/.test(srv));
  // ── ⚠️ THE ONE DATABASE READ, AND THE FOUR CONDITIONS ON IT ──────────────
  //
  // The first version of this change withheld the 8-K filings from the server to keep page
  // rendering query-free. Measuring production showed what that cost: the crawler's copy of Top
  // Stories led with HPE/MarketWatch while the hydrated page led with "PSQH · Exchange removal
  // from listing", because only the browser had the filings. The two pages disagreed about the
  // day's biggest catalyst and the crawler's copy was missing a delisting. So the read is here,
  // and it is fenced instead of forbidden.
  ok('the only database read is the 8-K filings, and it is bounded',
    /recentEightK\(\{ materialOnly: true, limit, days: 7, ensure: false \}\)/.test(srv),
    'one indexed SELECT … LIMIT, 7-day window');
  ok('…it runs NO DDL on a page render', mut('ddl') ? false : /ensure: false/.test(srv)
    && !/ensureEightkTable/.test(srv));
  ok('…it fails soft to an empty list, so the page degrades to journalism-only',
    /return \[\];/.test(srv) && /readHomeFilings\(12\)\.catch\(\(\) => \[\]\)/.test(page));
  ok('…and it is per revalidation window, not per request',
    /export const revalidate = 300;/.test(page), 'asserted again here because it is the whole fence');
  ok('the server reader still runs no OTHER query and imports no schema',
    !/drizzle/.test(srv) && !/from '\.\/schema/.test(srv) && !/insiderTrades|congressTrades/.test(srv));

  // ⚠️ THE POOLS MUST MATCH, which is the point of the read above.
  ok('the server and the browser now rank the SAME pool',
    mut('poolsdiffer') ? false : /filings,$/m.test(page) && !/filings: \[\]/.test(page),
    'same stories, same filings, one deskSelection');
  ok('every server read fails soft to null rather than throwing or inventing a result',
    /return null;/.test(srv) && /catch \{ return null; \}/.test(srv)
      && /\.catch\(\(\) => null\)/.test(page));
}

// ═══════════════════════════════════════════════════════════════════════════
L('\n=== THE ROWS ARE DISCOVERABLE, NOT JUST VISIBLE ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ⚠️ A DIV WITH AN onClick IS NOT A LINK. The catalyst cards and both research tables were
  // reachable only by executing JavaScript and dispatching a click, so a crawler reading this page
  // found four catalysts, ten Form 4 filings and six congressional disclosures — and could not
  // follow any of them to the ticker page each one describes.
  const cp = code('src/components/CatalystPit.jsx');
  const anchors = (cp.match(/href=\{`\/ticker\/\$\{encodeURIComponent\(/g) || []).length;
  ok('the catalyst card and both table symbol cells are real anchors to /ticker/',
    mut('nolinks') ? false : anchors >= 3, `${anchors} internal ticker links in the component`);
  ok('…and the table links stop the row handler, so one click is one navigation',
    (cp.match(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/g) || []).length >= 2);
  ok('the catalyst card is no longer a div with an onClick',
    !/<div key=\{i\} className="hov" onClick=\{\(\) => goTicker/.test(cp));
  ok('filing and disclosure dates are wrapped in <time dateTime>',
    /<time dateTime=\{isoOrNull\(ins\.filed\)/.test(cp)
      && /<time dateTime=\{isoOrNull\(p\.disclosed\)/.test(cp));

  const shared = code('src/lib/cp-shared.jsx');
  ok('a story card prints its age as a <time> element when it has an instant',
    mut('notime') ? false : /<time className=\{className\} dateTime=\{n\.published\}/.test(shared));
  ok('…and a plain span when the publisher gave us no date, rather than a fabricated one',
    /if \(!n\.published\) return <span/.test(shared));
  ok('all three age slots in the card use it', (shared.match(/<StoryAge n=\{n\}/g) || []).length === 3,
    `${(shared.match(/<StoryAge n=\{n\}/g) || []).length} call sites`);
}

// ═══════════════════════════════════════════════════════════════════════════
L('\n=== ONE MAPPING, NOT TWO — THE REASON THE EXTRACTION HAPPENED ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  // The server and the browser must not be able to disagree about the front door. The mapping
  // therefore exists exactly once, and the client's fetchAll is reduced to fetching.
  const cp = code('src/components/CatalystPit.jsx');
  ok('the client no longer contains a copy of the mapping',
    mut('twomaps') ? false : !/const tapeArr = toArr\(tape/.test(cp) && !/const storiesArr =/.test(cp));
  ok('…it calls the shared builder instead', /return buildHomeModel\(\{/.test(cp));
  ok('…and still passes the snapshot\'s pre-built catalysts through',
    /snapCatalysts: usingSnapshot \? snap\?\.catalysts : null/.test(cp));
  ok('the helpers the model needs are exported from import-free modules, not re-implemented',
    /export \{ toArr \} from '\.\/home-model\.mjs'/.test(code('src/lib/cp-shared.jsx'))
      && /export \{ safeN \} from '\.\/num\.mjs'/.test(code('src/lib/cp-shared.jsx')));
  ok('minsSince still has one implementation and it takes a clock',
    typeof minsSince === 'function' && minsSince(iso(3), NOW) === 180
      && minsSince(null, NOW) === null);
  ok('toArr still unwraps the shapes the APIs return',
    toArr({ trades: [1, 2] }).length === 2 && toArr(null).length === 0);

  // displayFacts had to leave the route for the same reason.
  const boardSrc = code('src/lib/consensus/board-display.mjs');
  const routeSrc = code('src/app/api/consensus-board/route.js');
  ok('consensus row shaping lives in one module',
    /export function displayFacts/.test(boardSrc) && !/function displayFacts/.test(routeSrc));
  ok('…and the route consumes it rather than keeping its own copy',
    /import \{ displayFacts \} from/.test(routeSrc) && /\.map\(displayFacts\)/.test(routeSrc));
  ok('…which it reaches without a database or a session',
    !/\bdb\b/.test(boardSrc) && !/auth\(/.test(boardSrc));
}

// ═══════════════════════════════════════════════════════════════════════════
L('\n=== THE EDITORIAL HIERARCHY SURVIVES THE SERVER RENDER ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ⚠️ THE CORRECTION THAT SHIPPED AT 1f9ff3fa MUST NOT BE UNDONE BY RENDERING EARLIER. Every
  // material 8-K scores 'high', so a surface that orders a mixed pool by impact tier becomes all
  // filings — which is exactly what the front door used to be. deskSelection is still the only
  // thing choosing what leads, and the server render goes through it like every other render.
  const { deskSelection } = await import('../src/lib/impact.js');
  const m = buildHomeModel(serverInputs(), { now: NOW });

  const routine = Array.from({ length: 8 }, (_, i) => ({
    ticker: `AB${i}`, primaryLabel: 'Material agreement', material: true,
    filedAt: iso(0.5 + i * 0.1), url: `https://sec.gov/${i}`,
  }));
  const withFilings = buildHomeModel({ ...serverInputs(), filings: routine }, { now: NOW });
  const sel = deskSelection(withFilings.news, withFilings.filingCards);
  ok('reporting still leads when routine filings are in the pool',
    mut('filingslead') ? false : sel.items.length > 0 && sel.items[0].source === 'MarketWatch',
    `leads with ${sel.items[0]?.source}`);
  ok('…and the module does not announce itself as a filings list',
    sel.leadingWithFilings === false);

  const bankrupt = [{ ticker: 'WXYZ', primaryLabel: 'Bankruptcy', material: true,
    filedAt: iso(1), url: 'https://sec.gov/b' }];
  const exceptional = deskSelection(
    buildHomeModel({ ...serverInputs(), filings: bankrupt }, { now: NOW }).news,
    buildHomeModel({ ...serverInputs(), filings: bankrupt }, { now: NOW }).filingCards);
  ok('a genuinely exceptional filing can still lead on its own importance',
    exceptional.items.some((x) => x.secLabel === 'Bankruptcy'));

  // ⚠️ THE EXACT SHAPE MEASURED ON PRODUCTION, 2026-11-24: twelve filings, ten of them routine,
  // one delisting notice, two MarketWatch stories. Asserted directly, because this is the case
  // that made the server read the filings in the first place.
  const asMeasured = [
    { ticker: 'PSQH', primaryLabel: 'Exchange removal from listing', material: true, filedAt: iso(2), url: 'https://sec.gov/psqh' },
    ...['TULP:Exec / board change', 'SGLY:Security-holder rights', 'PRXA:Material agreement',
      'PAL:Material agreement', 'SURG:Earnings', 'KRFG:Exec / board change', 'PETS:Material agreement',
      'SOLV:Exec / board change', 'PBT:Material agreement', 'CRMT:Material agreement'].map((s, i) => {
      const [ticker, primaryLabel] = s.split(':');
      return { ticker, primaryLabel, material: true, filedAt: iso(1 + i * 0.2), url: `https://sec.gov/${ticker}` };
    }),
  ];
  const prod = buildHomeModel({ ...serverInputs(), filings: asMeasured }, { now: NOW });
  const prodSel = deskSelection(prod.news, prod.filingCards);
  ok('the delisting notice leads, because it is exceptional and the desk says so',
    mut('routinelead') ? false : prodSel.items[0]?.sym === 'PSQH'
      && prodSel.items[0]?.secLabel === 'Exchange removal from listing',
    `${prodSel.items[0]?.sym} · ${prodSel.items[0]?.secLabel}`);
  ok('…the reporting is right behind it',
    prodSel.items[1]?.source === 'MarketWatch' && prodSel.items[2]?.source === 'MarketWatch');
  ok('…and not one of the ten routine filings reaches the module',
    mut('routinelead') ? false
      : !prodSel.items.some((x) => ['Material agreement', 'Exec / board change', 'Earnings',
        'Security-holder rights'].includes(x.secLabel)),
    `${prodSel.items.length} items, none routine`);
  ok('…and the module says out loud that a filing is leading it', prodSel.leadingWithFilings === true);
}

// ═══════════════════════════════════════════════════════════════════════════
L('\n=== WHAT MUST NOT HAVE BEEN TOUCHED ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const page = code('src/app/page.jsx');
  const cp = code('src/components/CatalystPit.jsx');
  const layout = code('src/app/layout.jsx');

  ok('the canonical, title and description are unchanged and still self-referencing',
    /pageMeta\(\{/.test(page) && /path: "\/"/.test(page)
      && /CatalystPit · Insider Trades, Congress Trades & Market Catalysts/.test(page));
  ok('the AdSense ownership tag and the structured data are still in the layout',
    /google-adsense-account|adsense/i.test(layout) && /'@type': 'Organization'/.test(layout)
      && /'@type': 'WebSite'/.test(layout));
  ok('no advertisement was placed inside the research', !/adsbygoogle/.test(cp));
  ok('the $9.99 Pro path is untouched: PlanChoice behind FreeOnly, checkout unchanged',
    /<FreeOnly>/.test(cp) && /<PlanChoice/.test(cp) && /startCheckout/.test(cp));
  ok('quotes still come from the entitlement-aware hook, per viewer',
    /useRealtimeQuotes\(quoteSyms\)/.test(cp) && /quotesFreshness\(idxQuotes\)/.test(cp));
  ok('the watchlist, notifications and teaser gates are still client-resolved',
    /<WatchlistHomeCard\/>/.test(cp) && /<HomeTeaserGate/.test(cp) && /useProEntitlement/.test(cp));
  ok('nothing private is server-rendered: no watchlist, plan or session read on the server',
    !/watchlist/i.test(page) && !/me\/plan/.test(page));
  ok('the interactive surfaces are still mounted',
    /<CompactChart/.test(cp) && /<HeatMap/.test(cp) && /<MarketBreadth/.test(cp)
      && /<FearGreedCard\/>/.test(cp));
  ok('the automatic 15-minute refresh still runs',
    /setInterval\(loadData, 15 \* 60 \* 1000\)/.test(cp));
  ok('…and the manual refresh still shows its skeleton, so it still gives feedback',
    /loadData\(\{ showSkeleton: true \}\)/.test(cp));
}

L('');
L(`${pass} passed, ${fails.length} failed`);
if (fails.length) { L('FAILED:'); fails.forEach((f) => L(`  - ${f}`)); process.exit(1); }
L('EVERY HOMEPAGE SSR CHECK PASSED');
