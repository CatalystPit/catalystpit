// THE 1D HEATMAP GOES INTRADAY FOR PRO, AND FOR NOBODY ELSE.
//
//   node --env-file=.env.local scripts/verify-heatmap-realtime.mjs [--mutate=<mode>] [--live]
//
// The change is deliberately one number: the NUMERATOR of the 1D return. Everything these
// assertions protect is a thing that must NOT have moved — the universe, the sectors, the tile
// sizing, the market-cap methodology, the baseline session, the other windows, and above all the
// volume that Most Active is ranked by.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const { readFile } = await import('node:fs/promises');
const src = async (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const store = await src('../src/lib/heatmap/heatmap-store.js');
const route = await src('../src/app/api/heatmap/performance/route.js');
const storeCode = strip(store), routeCode = strip(route);

// The board's arithmetic, replayed exactly as heatmap-store performs it.
const pctReturn = (num, base) => (base ? ((num - base) / base) * 100 : null);
const rowPct = (close, baseline, live) => pctReturn(live != null ? live : close, baseline);

L('=== THE INTRADAY RETURN IS (LIVE − PREVCLOSE) / PREVCLOSE ===');
{
  // AAPL: previous close 338.98, live 343.10 — the numbers from the brief.
  ok('a live price produces the intraday return',
    mut('ignoreslive') ? false : Math.abs(rowPct(338.98, 338.98, 343.10) - 1.2154) < 0.001,
    String(rowPct(338.98, 338.98, 343.10)));
  ok('without a live price it is the completed-session return',
    rowPct(340.00, 338.98, null).toFixed(4) === '0.3009');
  ok('the BASELINE is never replaced, only the numerator',
    rowPct(338.98, 100, 343.10) === rowPct(999, 100, 343.10),
    'the close must not influence the result once a live price exists');
  ok('a symbol with no quote keeps its close, so a partial feed is still correct',
    rowPct(340.00, 338.98, null) !== null);
  ok('a zero baseline yields no return rather than infinity', rowPct(343, 0, 343) === null);
}

L('=== ONLY 1D, AND ONLY FOR AN ENTITLED READER ===');
{
  // The guard the store applies before it fetches anything.
  const wants = (realtime, timeframe) => realtime && timeframe === '1D';
  ok('Pro on 1D asks for live prices', mut('anywindow') ? false : wants(true, '1D') === true);
  for (const tf of ['1W', '1M', '1Y']) {
    ok(`${tf} keeps the historical methodology`, mut('anywindow') ? false : wants(true, tf) === false);
  }
  ok('Free on 1D does not', mut('freeleak') ? false : wants(false, '1D') === false);
  ok('…and signed-out does not', wants(false, '1D') === false);

  ok('the store gates on both before doing any work',
    /if \(!realtime \|\| timeframe !== '1D' \|\| !tickers\.length\) return new Map\(\)/.test(storeCode));
  ok('entitlement is read from the session, never from a parameter',
    /const \{ userId \} = await auth\(\)/.test(routeCode) && !/sp\.get\('realtime'\)/.test(routeCode));
}

L('=== A LIVE PRICE IS ONLY USED IF THE SERVER STAMPED IT REALTIME ===');
{
  const usable = (q) => !!(q && q.freshness === 'realtime' && q.price != null
    && Number.isFinite(Number(q.price)) && Number(q.price) > 0);
  ok('a realtime-stamped quote is used', usable({ freshness: 'realtime', price: 343 }));
  ok('an eod-stamped quote is NOT, however fresh it looks',
    mut('takesanyquote') ? false : !usable({ freshness: 'eod', price: 343 }));
  // ⚠️ THIS ASSERTION CAUGHT A REAL BUG. The first implementation tested only
  // Number.isFinite(Number(q.price)) — and Number(null) is 0, which IS finite. A null price became
  // a price of zero, and (0 − prevClose)/prevClose renders that tile at exactly −100%: the most
  // alarming number on the board, produced by a missing value rather than by the market.
  ok('a quote with no price is not used', mut('nullprice') ? false : !usable({ freshness: 'realtime', price: null }));
  ok('…nor a zero price, for the same reason', !usable({ freshness: 'realtime', price: 0 }));
  ok('…nor an unparseable one', !usable({ freshness: 'realtime', price: 'n/a' }));
  ok('the store applies the same three checks',
    /q\.price != null && Number\.isFinite\(Number\(q\.price\)\) && Number\(q\.price\) > 0/.test(storeCode));
  ok('the store checks the stamp', /q\.freshness === 'realtime'/.test(storeCode));
}

L('=== THE LABEL DESCRIBES THE ROWS, NOT THE READER ===');
{
  const freshnessOf = (realtime, liveRows) => (realtime && liveRows > 0 ? 'realtime' : 'eod');
  ok('Pro with live rows is realtime', freshnessOf(true, 400) === 'realtime');
  ok('⚠️ Pro with ZERO live rows is eod, not realtime',
    mut('labelsbyreader') ? false : freshnessOf(true, 0) === 'eod',
    'an entitled reader looking at closes must not be told they are live');
  ok('Free is always eod', mut('freeleak') ? false : freshnessOf(false, 400) === 'eod');
  ok('the route computes it from the rows', /board\.rows\.filter\(\(r\) => r\.live\)\.length/.test(routeCode));
  ok('…and reports whether it was actually applied', /applied: freshness === 'realtime'/.test(routeCode));
}

L('=== A PRO BOARD CAN NEVER BE SERVED FROM A PUBLIC CACHE ===');
{
  // ⚠️ THE ONE THAT WOULD LEAK. A realtime board behind a CDN cache is a Pro board handed to the
  // next Free reader by the edge, with no code path involved at all.
  // ⚠️ THIS ASSERTION USED TO ENFORCE THE BUG. It required the header to be chosen from the
  // computed `freshness` — which sounds careful and is too late: by the time an outcome exists the
  // CDN has already been handed a `public` answer for a URL both audiences share, and every
  // entitled request afterwards is served from the edge without reaching auth(). The rule is that
  // an entitled REQUEST is never publicly cacheable, decided before any work happens.
  ok('an entitled request can never be publicly cached',
    mut('publiccache') ? false : /headers: wantsRealtime \? PRIVATE : \(freshness === 'eod' \? EOD_CACHE : PRIVATE\)/.test(routeCode));
  ok('…and an unentitled one still gets the shared public board',
    /EOD_CACHE = \{ 'Cache-Control': 'public, s-maxage=300/.test(routeCode));
  ok('…and the realtime branch is private, no-store',
    /const PRIVATE = \{ 'Cache-Control': 'private, no-store' \}/.test(routeCode));
  ok('nothing realtime is written to a shared store',
    mut('storesrt') ? false : !/kvSet|quotesCacheSet/.test(routeCode + storeCode));
  ok('concurrent viewers share a computation, not a stored value',
    /coalesce\(`heatmap:/.test(routeCode));
  ok('…keyed by entitlement so the two boards cannot collide',
    /\$\{realtime \? 'rt' : 'eod'\}/.test(routeCode));
}

L('=== NOTHING ELSE ABOUT THE BOARD MOVED ===');
{
  // ⚠️ MOST ACTIVE IS THE ONE THAT MUST NOT FOLLOW. The only intraday volume this entitlement
  // carries is one venue's, 0.17%–0.40% of the tape. Ranking by it would be the RVOL fabrication
  // under another name.
  ok('the live path never touches volume',
    mut('livevolume') ? false : !/volume/i.test(storeCode.slice(
      storeCode.indexOf('async function intradayPrices'), storeCode.indexOf('export async function heatmapBoard'))));
  ok('the row still carries the completed-session volume', /volume: l\?\.volume \?\? null/.test(storeCode));
  ok('no RVOL or VWAP appears', !/rvol|vwap/i.test(storeCode + routeCode));

  ok('the universe is unchanged', /heatmapUniverse\(limit\)/.test(storeCode));
  ok('the baseline session is unchanged', /baselineSession|anchorDateFor/.test(storeCode));
  ok('the quality gates still run', /returnBlocked\(quality\.get/.test(storeCode));
  ok('the market-cap ordering is untouched', !/marketCap/.test(
    storeCode.slice(storeCode.indexOf('async function intradayPrices'), storeCode.indexOf('export async function heatmapBoard'))));
}

L('\n=== THE SHARED SNAPSHOT COLLAPSES PROVIDER LOAD, NOT ENTITLEMENT ===');
{
  const { snapshotIsFresh, snapshotKey, SNAPSHOT_TTL_SEC, SNAPSHOT_MAX_AGE_MS } =
    await import('../src/lib/heatmap/heatmap-realtime.mjs');
  const snapCode = strip(await src('../src/lib/heatmap/heatmap-realtime.mjs'));

  ok(`the snapshot lives ~${SNAPSHOT_TTL_SEC}s`, SNAPSHOT_TTL_SEC === 15);

  // ⚠️ NO KEY COLLISION WITH ANY OTHER CACHE IN THE PRODUCT. A collision here is a Pro board
  // handed to a Free reader by the store rather than by any code path.
  const k = snapshotKey(500);
  ok('the snapshot key is heatmap-specific and marked realtime', k === 'cp:hm:rt:500', k);
  ok('…it cannot collide with the quote caches', !/^quotes:/.test(k) && !k.includes('eod'));
  ok('…and the universe size is part of it', snapshotKey(100) !== snapshotKey(500));

  // Staleness is the difference between a REALTIME label and a lie.
  const now = Date.parse('2026-09-22T15:00:00.000Z');
  const at = (sec) => ({ calculatedAt: new Date(now - sec * 1000).toISOString(), prices: { AAPL: 343 } });
  ok('a snapshot from 5s ago is fresh', snapshotIsFresh(at(5), { now }));
  ok('a snapshot from 12s ago is fresh', snapshotIsFresh(at(12), { now }));
  ok('⚠️ a snapshot from 60s ago is NOT, so it is never served as realtime',
    mut('servesstale') ? false : !snapshotIsFresh(at(60), { now }));
  ok('an empty snapshot is not fresh', !snapshotIsFresh({ calculatedAt: new Date(now).toISOString(), prices: {} }, { now }));
  ok('a missing snapshot is not fresh', !snapshotIsFresh(null, { now }));
  ok('a future-stamped snapshot is a clock fault, not freshness',
    !snapshotIsFresh({ calculatedAt: new Date(now + 5 * SNAPSHOT_MAX_AGE_MS).toISOString(), prices: { A: 1 } }, { now }));

  // It must store PRICES, not a board, and nothing else may write to it.
  ok('only prices are stored', /prices,\s*$/m.test(snapCode) || /prices,/.test(snapCode));
  ok('the snapshot carries its own provenance',
    /calculatedAt: new Date\(\)\.toISOString\(\)/.test(snapCode) && /provider/.test(snapCode) && /kind: 'heatmap-realtime-1d'/.test(snapCode));
  ok('the store writes with the TTL', /EX=\$\{SNAPSHOT_TTL_SEC\}/.test(snapCode));

  // ⚠️ THE READ IS ONLY REACHED ON AN ENTITLED PATH. The snapshot itself checks nothing — a cache
  // that decides who may read it is a second entitlement system waiting to disagree with the first.
  ok('the snapshot is read only inside the realtime-gated helper',
    mut('unentitledread') ? false
      : /if \(!realtime \|\| timeframe !== '1D'[^)]*\) return new Map\(\);[\s\S]{0,600}readSnapshot\(limit\)/.test(storeCode));
  ok('the quote cache policy is untouched — no quote is stored by this path',
    !/quotesCacheSet/.test(storeCode));
}

L('\n=== THE BOARD ACTUALLY REACHES THE READER ===');
{
  // ⚠️ THIS SECTION EXISTS BECAUSE EVERY ASSERTION ABOVE PASSED WHILE PRO SAW "END OF DAY" IN
  // PRODUCTION. The computation was right and the DELIVERY was broken in three separate places,
  // none of which a test about arithmetic could see:
  //
  //   1. the API route answered Free and Pro on the SAME URL with `public, s-maxage=300`, so the
  //      CDN served the anonymous EOD board to entitled requests and auth() never ran
  //      (confirmed in production: X-Vercel-Cache: HIT, Cache-Control: public)
  //   2. the page is statically cached with a hardcoded freshness of 'eod'
  //   3. the client fetched once and had no interval at all
  //
  // A correct number nobody receives is not a feature.
  const client = strip(await src('../src/app/heatmap/MarketHeatmapClient.jsx'));
  const page = strip(await src('../src/app/heatmap/page.jsx'));

  // 1. THE CACHE KEYS MUST DIFFER BEFORE THE ANSWER IS KNOWN.
  ok('the entitled reader requests a different URL',
    mut('sharedurl') ? false : /\$\{rt \? '&rt=1' : ''\}/.test(client));
  ok('the route reads that marker', /sp\.get\('rt'\) === '1'/.test(routeCode));
  ok('⚠️ the header is chosen from the REQUEST, not from the outcome',
    mut('lateheader') ? false : /headers: wantsRealtime \? PRIVATE :/.test(routeCode),
    'choosing from `freshness` is too late — the CDN has already cached the public answer');
  ok('the entitled fetch also bypasses the browser cache', /rt \? \{ cache: 'no-store' \} : undefined/.test(client));

  // ⚠️ AND THE MARKER GRANTS NOTHING. A Free reader appending rt=1 must still get EOD data.
  ok('rt=1 is a cache key, never an authorisation',
    mut('trustsparam') ? false
      : /realtime = isRealtime\(tier\)/.test(routeCode) && !/realtime = wantsRealtime/.test(routeCode));

  // 2. THE CLIENT MUST REPLACE THE STATIC FIRST PAINT FOR AN ENTITLED READER.
  ok('entitlement is resolved in the browser from the canonical endpoint',
    /fetch\('\/api\/me\/plan'/.test(client));
  ok('…and the board is refetched once it resolves',
    mut('keepsssr') ? false : /if \(first && !entitled\) \{ setFirst\(false\); return; \}/.test(client));
  ok('the statically cached page never claims realtime', /freshness: 'eod'/.test(page));

  // 3. AND IT MUST KEEP ASKING.
  ok('the client polls',
    mut('nopoll') ? false : /setInterval\(\(\) => \{[\s\S]{0,300}load\(timeframe, universe, true\)/.test(client));
  ok(`…at the snapshot's cadence`, /const HEATMAP_POLL_MS = 15000/.test(client));
  ok('…only on the intraday window', /if \(!entitled \|\| timeframe !== '1D'\) return undefined/.test(client));
  ok('…and the interval is cleared', /clearInterval\(id\)/.test(client));
  ok('…with a hidden tab skipped and caught up on return',
    /visibilityState === 'hidden'/.test(client) && /visibilitychange/.test(client));
}

if (process.argv.includes('--live')) {
  L('\n=== AGAINST THE LIVE FEED ===');
  const KEY = process.env.TIINGO_API_KEY;
  if (!KEY) { ok('TIINGO_API_KEY present', false); }
  else {
    const H = { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` };
    const syms = ['AAPL', 'NVDA', 'SPY', 'AMD', 'QCOM'];
    const r = await fetch(`https://api.tiingo.com/iex/?tickers=${syms.join(',')}`, { headers: H });
    const rows = r.ok ? await r.json() : [];
    ok('the universe batch answers in one request', rows.length >= 4, `${rows.length} rows`);
    let computed = 0;
    for (const q of rows) {
      const pct = pctReturn(Number(q.tngoLast), Number(q.prevClose));
      if (pct != null && Number.isFinite(pct)) computed += 1;
      L(`     ${String(q.ticker).toUpperCase().padEnd(5)} live ${q.tngoLast} vs prevClose ${q.prevClose} → ${pct?.toFixed(3)}%`);
    }
    ok('every symbol yields an intraday return', computed === rows.length);
  }
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
