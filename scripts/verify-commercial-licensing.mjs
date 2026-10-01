// THE COMMERCIAL-DATA LICENSING GUARD.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-commercial-licensing.mjs
//
// ⚠️ THIS SWEEPS THE REPOSITORY RATHER THAN CHECKING A LIST OF KNOWN CALL SITES, because a hand-kept
// list is exactly how the exposure survived an audit. The previous provenance audit enumerated six
// routes that decide real-time entitlement and missed a seventh; the pipelines suite enumerated eleven
// tracked jobs and missed thirteen. Any assertion of the form "these are all the places" is a statement
// with a shelf life. So the unit here is: every file under src/, every external host it reaches in
// EXECUTABLE code, measured against one frozen allow-list.
//
// ⚠️ AND COMMENTS ARE STRIPPED FIRST. This codebase documents its own history in detail — every removed
// provider is named in a comment explaining why it was removed. Matching raw text would report a
// violation for each explanation of a past violation, and the only way to go green would be to delete
// the institutional memory. Line comments are stripped before block comments, because market/tiingo.mjs
// contains `// /realtime/*, /consolidated/* all 404` and the other order treats that as a block opener
// and deletes 30KB of real code.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const MUT = (process.env.MUTATE || '').split(',').filter(Boolean);
const mut = (k) => MUT.includes(k);

const {
  APPROVED_COMMERCIAL_PROVIDER, APPROVED_DATA_HOSTS, UNAPPROVED_COMMERCIAL_HOSTS,
  isUnapprovedCommercialHost, isApprovedDataHost, licensedFetch, UnlicensedProviderError,
  LICENSED_CANDLE_SOURCES, UNLICENSED_CANDLE_SOURCES, servableMetaSource,
} = await import('../src/lib/licensing/providers.mjs');

const strip = (s) => s
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|jsx|mjs|cjs|ts|tsx)$/.test(e.name)) files.push(p);
  }
})('src');
const rel = (p) => p.replace(/\\/g, '/');

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('1. THE ALLOW-LIST IS A FROZEN LITERAL, NOT CONFIGURATION');
{
  ok('⚠️ the approved commercial provider is Tiingo', APPROVED_COMMERCIAL_PROVIDER === 'tiingo');
  ok('⚠️ …and the lists are frozen, so nothing can push onto them at runtime',
    Object.isFrozen(APPROVED_DATA_HOSTS) && Object.isFrozen(UNAPPROVED_COMMERCIAL_HOSTS));
  const src = strip(readFileSync('src/lib/licensing/providers.mjs', 'utf8'));
  // ⚠️ THE POINT OF THE MODULE IS THAT IT READS NO ENVIRONMENT. If a key could widen the allow-list,
  // the guarantee "an env var cannot turn a provider back on" would be false at its source.
  ok('⚠️ the licensing module reads no environment variable at all',
    !/process\.env/.test(src), (src.match(/process\.env\.[A-Z_]*/) || [])[0] || '');
  ok('⚠️ …and no key, token or secret name appears in it', !/KEY|TOKEN|SECRET/.test(src));
  for (const h of ['api.polygon.io', 'finnhub.io', 'api.twelvedata.com', 'financialmodelingprep.com',
    'api.coingecko.com', 'api.openfigi.com', 'img.logo.dev']) {
    ok(`${h} is on the deny-list`, isUnapprovedCommercialHost(h));
    ok(`  …and is not also approved`, !isApprovedDataHost(h));
  }
  // Subdomain handling, because a deny-list that only matches exactly is trivially sidestepped.
  ok('⚠️ a subdomain of a denied host is denied too',
    isUnapprovedCommercialHost('https://static2.finnhub.io/x.png')
    && isUnapprovedCommercialHost('https://files.polygon.io/a'));
  ok('⚠️ an unknown host is not approved by default', !isApprovedDataHost('https://api.example.com/x'));
  for (const h of ['api.tiingo.com', 'data.sec.gov', 'www.sec.gov', 'api.finra.org', 'www.nasdaqtrader.com']) {
    ok(`${h} is approved`, isApprovedDataHost(h) && !isUnapprovedCommercialHost(h));
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('2. NO UNAPPROVED COMMERCIAL HOST IS REACHED FROM ANY FILE UNDER src/');
{
  // Hostnames as they appear in a request, not vendor NAMES — a name in a variable or a comment is
  // documentation; a hostname in a fetch is a request that will actually be made.
  const HOST_RE = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
  const offenders = [];
  for (const f of files) {
    const r = rel(f);
    if (r === 'src/lib/licensing/providers.mjs') continue;   // the allow-list names them by definition
    let code = strip(readFileSync(f, 'utf8'));
    if (mut('reintroduce') && r === 'src/lib/market-data.js') {
      code += '\nawait fetch("https://api.polygon.io/v2/snapshot");\n';
    }
    for (const m of code.matchAll(HOST_RE)) {
      if (isUnapprovedCommercialHost(m[1])) offenders.push(`${r} → ${m[1]}`);
    }
  }
  ok('⚠️ zero unapproved commercial hosts in executable code',
    offenders.length === 0, offenders.slice(0, 12).join(' | '));

  // ⚠️ A BARE VENDOR NAME IS NOT THE RIGHT UNIT, AND THE FIRST VERSION OF THIS CHECK PROVED IT. Matching
  // /\bpolygon\b/ over stripped code flagged four component files and a chart module for the SVG
  // <polygon> element, and flagged price-semantics.mjs for a descriptor that documents the adjustment
  // convention of rows ALREADY ON DISK — which is provenance, exactly what Phase 6 asks us to record. A
  // check that fires on `<polygon points=...>` trains its reader to ignore it.
  //
  // So the three things that actually matter are asserted directly instead:

  // (a) NO VENDOR API KEY IS READ ANYWHERE. A key read is an intent to call. This is the sweep that makes
  // "an environment variable cannot turn a provider back on" true for the whole tree rather than for a
  // list of files somebody remembered.
  const KEY_RE = /process\.env\.(POLYGON[A-Z_]*|FINNHUB[A-Z_]*|TWELVE[A-Z_]*|FMP[A-Z_]*|LOGODEV[A-Z_]*|OPENFIGI[A-Z_]*|COINGECKO[A-Z_]*|MARKETAUX[A-Z_]*|STOCKDATA[A-Z_]*|MARKET_DATA_PROVIDER)/;
  const keyReaders = [];
  for (const f of files) {
    let code = strip(readFileSync(f, 'utf8'));
    if (mut('readkey') && rel(f) === 'src/lib/market-data.js') code += '\nconst k = process.env.POLYGON_API_KEY;\n';
    const m = code.match(KEY_RE);
    if (m) keyReaders.push(`${rel(f)} → ${m[1]}`);
  }
  ok(`⚠️ no file under src/ reads a vendor API key`, keyReaders.length === 0, keyReaders.slice(0, 10).join(' | '));

  // (b) NO PROVIDER IS SELECTED BY A VENDOR NAME. A registry keyed on a string plus an env lookup is how
  // both the Twelve Data quote hole and the DIVIDEND_PROVIDER ingestion hole worked.
  // ⚠️ 'polygon' IS ALSO AN SVG ELEMENT, which this check learned the hard way: it flagged ChartUI.jsx
  // for `kind === 'polygon'` and chart-types.mjs for `['polygon', { points: ... }]` — a shape vocabulary
  // that has nothing to do with a data vendor. Dropping the word from the list would be worse, since
  // Polygon is the vendor this whole change removed, so the SVG sense is excluded by context instead: a
  // file that draws shapes talks about points, fills and strokes.
  const SELECT_RE = /(===|!==|\[)\s*['"`](polygon|finnhub|twelvedata|twelve_data|fmp|coingecko|openfigi)['"`]/i;
  const SVG_CONTEXT = /points:|points=|<polygon|fill=|strokeWidth|viewBox/;
  const selectors = [];
  for (const f of files) {
    if (rel(f) === 'src/lib/licensing/providers.mjs') continue;
    const code = strip(readFileSync(f, 'utf8'));
    const m = code.match(SELECT_RE);
    // A comparison against a STORED provenance value is legitimate and is what the read gates do, so
    // the licensing module's own vocabulary is allowed to appear beside it.
    if (!m) continue;
    const legitimate = /LICENSED_|UNLICENSED_|servableMetaSource/.test(code)   // a stored-provenance comparison
      || (/polygon/i.test(m[0]) && SVG_CONTEXT.test(code));                        // the SVG element
    if (!legitimate) selectors.push(`${rel(f)} → ${m[0]}`);
  }
  ok(`⚠️ no provider is selected by a vendor-name string`, selectors.length === 0, selectors.slice(0, 8).join(' | '));

  // (c) NO UNAPPROVED VENDOR IS NAMED IN USER-FACING COPY. A string the reader sees is a claim about where
  // our data comes from, and "Add FMP_API_KEY to enable live movers" was sitting in the Terminal.
  const COPY_RE = /['"`>][^'"`<]{0,80}(Polygon|Finnhub|Twelve Data|CoinGecko|OpenFIGI|FMP_API_KEY|logo\.dev)[^'"`<]{0,80}/;
  const copy = [];
  for (const f of files) {
    const r = rel(f);
    if (!/\.jsx$/.test(r) && !/cp-shared/.test(r)) continue;    // rendered surfaces only
    const code = strip(readFileSync(f, 'utf8'));
    const m = code.match(COPY_RE);
    if (m) copy.push(`${r} → ${m[0].slice(0, 70)}`);
  }
  ok(`⚠️ no unapproved vendor is named in rendered copy`, copy.length === 0, copy.slice(0, 6).join(' | '));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('3. CONFIGURATION MISTAKES CANNOT TURN A PROVIDER BACK ON');
{
  // ⚠️ THIS IS THE ASSERTION THE TWELVE DATA EXPOSURE NEEDED AND DID NOT HAVE. That path required no
  // code change to activate — a key appearing in an environment was enough. So every key is set here,
  // to a plausible-looking value, and the product must behave identically.
  const saved = {};
  const KEYS = ['POLYGON_API_KEY', 'POLYGON_KEY', 'FINNHUB_KEY', 'FINNHUB_API_KEY',
    'TWELVE_DATA_API_KEY', 'TWELVEDATA_API_KEY', 'FMP_API_KEY', 'MARKET_DATA_PROVIDER',
    'LOGODEV_TOKEN', 'MARKETAUX_API_KEY', 'STOCKDATA_API_KEY'];
  for (const k of KEYS) { saved[k] = process.env[k]; process.env[k] = k === 'MARKET_DATA_PROVIDER' ? 'polygon' : 'test-key-not-real'; }
  try {
    // Fresh module graph, so the module-level provider expression is evaluated WITH the keys present.
    const md = await import(`../src/lib/market-data.js?cfg=${Date.now()}`);
    ok('⚠️ marketDataProvider() is the approved provider even with MARKET_DATA_PROVIDER=polygon',
      md.marketDataProvider() === 'tiingo', md.marketDataProvider());
    const code = strip(readFileSync('src/lib/market-data.js', 'utf8'));
    ok('⚠️ …because the provider is a constant, not an env read',
      /const PROVIDER = APPROVED_COMMERCIAL_PROVIDER;/.test(code));
    ok('⚠️ …and the module reads no vendor key at all',
      !/process\.env\.(POLYGON|FINNHUB|TWELVE|FMP)/.test(code));

    // The screener rebuild is where Polygon ingested and where the Finnhub fallback lived.
    const sd = strip(readFileSync('src/lib/screener-data.js', 'utf8'));
    ok('⚠️ the screener rebuild reads no vendor key',
      !/process\.env\.(POLYGON|FINNHUB|TWELVE|FMP)/.test(sd),
      (sd.match(/process\.env\.[A-Z_]+/g) || []).filter((x) => /POLYGON|FINNHUB|TWELVE|FMP/.test(x)).join(','));
    ok('⚠️ …and has no `if (FINNHUB` fallback branch', !/if \(FINNHUB/.test(sd));
    ok('⚠️ …and writes no candle row with an unlicensed source',
      !/source: 'polygon'/.test(sd));

    for (const f of ['src/app/api/ticker/route.js', 'src/app/api/watchlist/route.js',
      'src/app/api/refresh/route.js', 'src/lib/finra-short-interest.mjs',
      'src/app/api/logo/route.js', 'src/app/api/scan/route.js',
      'src/app/api/earnings-calendar/route.js', 'src/app/api/earnings/route.js']) {
      const c = strip(readFileSync(f, 'utf8'));
      ok(`${f} reads no vendor key`, !/process\.env\.(POLYGON|FINNHUB|TWELVE|FMP|LOGODEV)/.test(c),
        (c.match(/process\.env\.[A-Z_]+/g) || []).filter((x) => /POLYGON|FINNHUB|TWELVE|FMP|LOGODEV/.test(x)).join(','));
    }
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('4. A TIINGO FAILURE FAILS CLOSED — IT DOES NOT ACTIVATE ANYTHING');
{
  // ⚠️ EXERCISED, NOT READ. "No fallback" is a claim about runtime behaviour, so the licensed provider
  // is actually made to fail and the result is inspected. A text assertion that the Polygon branch is
  // absent cannot tell you what happens when Tiingo throws.
  const code = strip(readFileSync('src/lib/market-data.js', 'utf8'));
  const afterTiingo = code.slice(code.indexOf('tiingoQuotes(syms'));
  ok('⚠️ nothing but an empty object follows the licensed attempt',
    !/fetch\(/.test(afterTiingo) && /return \{\};/.test(afterTiingo));
  ok('⚠️ …and no second provider function survives in the module',
    !/polygonQuotes|twelveQuotes/.test(code));

  // getQuotes with Tiingo unconfigured must be {} — not a different vendor's answer.
  const savedTok = process.env.TIINGO_API_KEY;
  delete process.env.TIINGO_API_KEY;
  process.env.POLYGON_API_KEY = 'test-key-not-real';
  process.env.FINNHUB_KEY = 'test-key-not-real';
  try {
    const md = await import(`../src/lib/market-data.js?nofail=${Date.now()}`);
    const out = await md.getQuotes(['AAPL', 'MSFT'], { realtime: false });
    ok('⚠️ an unconfigured licensed provider yields {} with every vendor key present',
      out && typeof out === 'object' && Object.keys(out).length === 0, JSON.stringify(out).slice(0, 120));
  } finally {
    if (savedTok === undefined) delete process.env.TIINGO_API_KEY; else process.env.TIINGO_API_KEY = savedTok;
    delete process.env.POLYGON_API_KEY; delete process.env.FINNHUB_KEY;
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('5. licensedFetch REFUSES AN UNAPPROVED HOST WHATEVER THE ENVIRONMENT SAYS');
{
  for (const u of ['https://api.polygon.io/v2/aggs', 'https://finnhub.io/api/v1/quote?symbol=AAPL',
    'https://api.twelvedata.com/quote', 'https://financialmodelingprep.com/stable/shares-float',
    'https://api.coingecko.com/api/v3/simple/price', 'https://static2.finnhub.io/logo.png']) {
    let threw = null;
    try { await licensedFetch(u); } catch (e) { threw = e; }
    ok(`refuses ${new URL(u).hostname}`, threw instanceof UnlicensedProviderError, threw ? threw.name : 'no throw');
  }
  // And an approved host is not blocked — a guard that refuses everything is useless.
  let approvedThrew = null;
  try { await licensedFetch('https://api.tiingo.com/api/test', { signal: AbortSignal.timeout(1) }); }
  catch (e) { approvedThrew = e; }
  ok('⚠️ …but does not refuse the approved provider',
    !(approvedThrew instanceof UnlicensedProviderError), approvedThrew?.name || 'resolved');
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('6. THE CANDLE WRITE CONTRACT REFUSES UNLICENSED ROWS');
{
  const { assertCanonicalCandles, CANDLE_SOURCE, UNLICENSED_SOURCES } =
    await import('../src/lib/market/candles.mjs');
  ok('⚠️ the writable source set is the licensed one only',
    Object.values(CANDLE_SOURCE).length === 1 && Object.values(CANDLE_SOURCE)[0] === 'tiingo_split_adj',
    JSON.stringify(Object.values(CANDLE_SOURCE)));
  ok('polygon is named as unlicensed rather than merely unknown', UNLICENSED_SOURCES.includes('polygon'));

  const row = (source) => [{ ticker: 'AAPL', date: '2026-09-30', open: 1, high: 2, low: 1, close: 2, volume: 10, source }];
  let e1 = null;
  try { assertCanonicalCandles(row('polygon'), { ticker: 'AAPL' }); } catch (e) { e1 = e; }
  ok('⚠️ a polygon-sourced write is refused', !!e1, 'no throw');
  ok('⚠️ …and the message says LICENSING, not "unknown source"',
    /UNLICENSED/.test(String(e1?.message)), String(e1?.message).slice(0, 110));
  let e2 = null;
  try { assertCanonicalCandles(row('tiingo_split_adj'), { ticker: 'AAPL' }); } catch (e) { e2 = e; }
  ok('…while a licensed write is accepted', e2 === null, String(e2?.message));
  // Mutation: if polygon were allowed back into the writable set, the refusal above must break.
  ok('⚠️ the refusal is the set, not a special case',
    !Object.values(CANDLE_SOURCE).includes('polygon'));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('7. STORED REFERENCE DATA OF UNKNOWN ORIGIN IS NOT SERVABLE');
{
  ok('⚠️ a NULL provenance is not servable', servableMetaSource(null) === false);
  ok('⚠️ an empty provenance is not servable', servableMetaSource('') === false);
  ok('⚠️ a polygon provenance is not servable', servableMetaSource('polygon') === false);
  ok('the SEC-derived provenance is servable', servableMetaSource('sec+tiingo') === true);
  const sd = strip(readFileSync('src/lib/screener-data.js', 'utf8'));
  ok('⚠️ the meta pipeline stamps what it writes', /source: SCREENER_META_SOURCE/.test(sd));
  ok('⚠️ …and the provenance column has NO default, so old rows stay unknown',
    /ADD COLUMN IF NOT EXISTS source TEXT`/.test(sd) && !/ADD COLUMN IF NOT EXISTS source TEXT DEFAULT/.test(sd));
  const tk = strip(readFileSync('src/app/api/ticker/route.js', 'utf8'));
  ok('⚠️ the ticker page gates reference fields on provenance', /servableMetaSource\(/.test(tk));
  ok('⚠️ …and the candle reads it does are source-filtered', /LICENSED_CANDLE_SOURCES/.test(tk));
  const ds = strip(readFileSync('src/lib/market/daily-series.mjs', 'utf8'));
  ok('⚠️ the shared daily-close reader is source-filtered',
    /inArray\(tickerDailyCandles\.source, LICENSED_CANDLE_SOURCES\)/.test(ds));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('8. THE REMOVED SURFACES DO WHAT THEY NOW CLAIM');
{
  const fl = strip(readFileSync('src/lib/finra-short-interest.mjs', 'utf8'));
  ok('⚠️ resolveFloat returns null rather than a vendor value',
    /export async function resolveFloat\(\) \{\s*return null;\s*\}/.test(fl));
  ok('⚠️ …and no float fetcher survives', !/fetchFloat/.test(fl));
  const { resolveFloat } = await import('../src/lib/finra-short-interest.mjs');
  ok('⚠️ …exercised: it resolves to null', (await resolveFloat('AAPL')) === null);

  // ⚠️ REGRESSION — A DEAD FETCHER IS NOT A CLOSED GATE. The three assertions above were green while the
  // live Screener served 114 float_shares and 101 short_float values read straight out of ticker_float,
  // whose every row carries source = 'fmp'. They only ever tested the WRITE path. Found by reading the
  // production Screener payload, not the code; the code looked finished.
  const sd2 = strip(readFileSync('src/lib/screener-data.js', 'utf8'));
  ok('⚠️ the Screener does not read ticker_float at all', !/tickerFloat/.test(sd2),
    'the table is entirely FMP — a join to it is a leak however null-safe the arithmetic is');
  ok('⚠️ …so its float column cannot carry a vendor value', /const flByT = new Map\(\);/.test(sd2));
  // AND THE SHARE COUNT, which is the half that nearly got away: the same join supplied sharesOut with the
  // vendor FIRST, so for those 114 tickers — the largest names on the site — the Screener published FMP's
  // count over the SEC one it already had. AAPL: 14,687,356,000 served against 14,594,180,000 filed.
  ok('⚠️ …and shares outstanding comes only from the provenance-gated meta',
    /sharesOut: m\?\.sharesOut \?\? null/.test(sd2) && !/sharesOut: f\?\.sharesOut/.test(sd2));

  const ec = strip(readFileSync('src/app/api/earnings-calendar/route.js', 'utf8'));
  ok('the earnings calendar always reports unconfigured', /configured: false/.test(ec) && !/fetch\(/.test(ec));

  const lg = strip(readFileSync('src/app/api/logo/route.js', 'utf8'));
  ok('the logo route fetches nothing', !/fetch\(/.test(lg) && /return miss\(\);/.test(lg));

  const rf = strip(readFileSync('src/app/api/refresh/route.js', 'utf8'));
  ok('⚠️ the tape is priced through the licensed layer', /getQuotes\(tickers, \{ realtime: false \}\)/.test(rf));
  ok('⚠️ …and the crypto fetcher returns nothing rather than a zero price',
    /async function fetchCrypto\(\) \{\s*return \{\};\s*\}/.test(rf));

  const wl = strip(readFileSync('src/app/api/watchlist/route.js', 'utf8'));
  ok('⚠️ the watchlist quote comes from the licensed layer', /getQuotes\(\[sym\], \{ realtime: false \}\)/.test(wl));

  ok('the dead Polygon intraday helper is gone', !existsSync('src/lib/polygon-intraday.mjs'));
  ok('the unused vendor chart component is gone', !existsSync('src/components/TradingViewChart.jsx'));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('9. ENTITLEMENT AND FRESHNESS GUARANTEES ARE UNTOUCHED');
{
  // ⚠️ A LICENSING FIX MUST NOT QUIETLY WIDEN ACCESS. These shared caches are served to every viewer,
  // so the quotes written into them must be the delayed ones; the entitled path stays on /api/quotes.
  for (const [f, why] of [
    ['src/app/api/ticker/route.js', 'CDN-shared'],
    ['src/app/api/watchlist/route.js', 'shared KV quote cache'],
    ['src/app/api/refresh/route.js', 'single shared tape'],
  ]) {
    const c = strip(readFileSync(f, 'utf8'));
    ok(`${f} requests realtime:false (${why})`, /realtime: false/.test(c));
    ok(`  …and never requests realtime:true`, !/realtime: true/.test(c));
  }
  const ent = strip(readFileSync('src/lib/entitlements.js', 'utf8'));
  ok('⚠️ the realtime kill switch is still consulted', /tiingoRealtimeStopped\(\)/.test(ent));
  ok('⚠️ …and the tier guard still precedes it',
    ent.indexOf('isRealtimeRule(tier)') > 0 && ent.indexOf('isRealtimeRule(tier)') < ent.indexOf('tiingoRealtimeStopped()'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
