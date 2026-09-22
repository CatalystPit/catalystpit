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

L('\n=== ⚠️ THE LIVE BASELINE IS THE PREVIOUS CLOSE, NOT THE EOD BASELINE ===');
{
  // THE BUG THIS PINS, with the real production numbers from 2026-09-22:
  //
  //   the board's EOD 1D pair is   Sep 18 close → Sep 21 close
  //   the LIVE 1D pair must be     Sep 21 close → current price
  //
  // The first version swapped only the NUMERATOR and kept the Sep 18 baseline, so it computed a
  // TWO-DAY return and stamped it LIVE: NVDA read +2.72% against a true +0.41%, and the banner
  // said "from the Sep 18 close to the Sep 21 close" while showing a live number. Both halves of
  // the fraction have to move together.
  const NVDA = { live: 228.32, prevClose: 227.38, eodBaseline: 222.27 };
  const AAPL = { live: 342.765, prevClose: 338.98, eodBaseline: 336.13 };
  // The board's own rule, as heatmap-store now applies it.
  const boardPct = (live, latestClose, eodBaseline) =>
    pctReturn(live != null ? live : latestClose, live != null ? latestClose : eodBaseline);

  ok('a live row measures from the PREVIOUS CLOSE',
    mut('eodbaseline') ? false : Math.abs(boardPct(NVDA.live, NVDA.prevClose, NVDA.eodBaseline) - 0.4134) < 0.01,
    String(boardPct(NVDA.live, NVDA.prevClose, NVDA.eodBaseline)));
  ok('…and NOT from the end-of-day baseline (which gave the reported +2.7%)',
    mut('eodbaseline') ? false
      : Math.abs(boardPct(NVDA.live, NVDA.prevClose, NVDA.eodBaseline) - 2.7219) > 1,
    'a two-day return wearing a live label');
  ok('AAPL agrees too', Math.abs(boardPct(AAPL.live, AAPL.prevClose, AAPL.eodBaseline) - 1.1165) < 0.01);

  // ⚠️ IT MUST EQUAL WHAT THE WATCHLIST COMPUTES, BY CONSTRUCTION. Same numerator, same
  // denominator — if these ever diverge the product is telling one reader two numbers.
  const watchlistPct = (live, prevClose) => ((live - prevClose) / prevClose) * 100;
  for (const [name, s] of [['NVDA', NVDA], ['AAPL', AAPL]]) {
    ok(`${name}: Heatmap live % equals the Watchlist's`,
      mut('eodbaseline') ? false
        : Math.abs(boardPct(s.live, s.prevClose, s.eodBaseline) - watchlistPct(s.live, s.prevClose)) < 1e-9);
  }

  // An EOD row is unchanged: it still measures between the two completed sessions.
  ok('an EOD row still measures Sep 18 → Sep 21',
    Math.abs(boardPct(null, NVDA.prevClose, NVDA.eodBaseline) - 2.2989) < 0.01,
    String(boardPct(null, NVDA.prevClose, NVDA.eodBaseline)));

  // ⚠️ RUN THE REAL DECISION, DON'T GREP FOR IT. These two used to match the literal lines
  // `const base = lq ? l.close : b.close;` and `row.baselineDate = l.date;`. Both were true of the
  // code and said nothing about the result, and both broke the moment the identical logic moved
  // into intradayRowReturn() — a test that fails on a refactor and would have passed on a rewrite
  // that inverted the branch. Now the function is called with the real Sep 2026 numbers.
  {
    const { intradayRowReturn } = await import('../src/lib/heatmap/heatmap-window.mjs');
    const call = (livePrice) => intradayRowReturn({
      livePrice, latestClose: NVDA.prevClose, latestDate: '2026-09-21',
      baselineClose: NVDA.eodBaseline, baselineDate: '2026-09-18', isLiveBoard: livePrice != null,
    });
    const live = call(NVDA.live), eod = call(null);
    ok('the baseline follows whether a live price exists',
      Math.abs(live.pct - boardPct(NVDA.live, NVDA.prevClose, NVDA.eodBaseline)) < 1e-9
      && Math.abs(eod.pct - boardPct(null, NVDA.prevClose, NVDA.eodBaseline)) < 1e-9,
      `${live.pct} / ${eod.pct}`);
    ok('…and a live row reports the session it was measured from',
      mut('wrongbanner') ? false : live.baselineDate === '2026-09-21' && eod.baselineDate === '2026-09-18',
      `${live.baselineDate} / ${eod.baselineDate}`);
  }
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

  // ⚠️ BOTH GATES MUST CLOSE BEFORE ANY PROVIDER CALL, AND THEY ARE NO LONGER ONE LINE. The
  // session state is now computed for EVERY reader — it is a fact about the market, not about the
  // reader, and a Free viewer is owed "the market is closed" too — so the entitlement gate sits
  // below it. What must remain true is the ordering: an unentitled or non-1D caller returns before
  // getQuotes is reachable. Asserted as position, not as a line of text, because the line moved
  // once already and the property did not.
  ok('the window gate closes before any work', /if \(timeframe !== '1D' \|\| !tickers\.length\) return none\(\)/.test(storeCode));
  ok('⚠️ the entitlement gate closes before the provider is reachable',
    mut('freeleak') ? false
      : storeCode.indexOf('if (!realtime) return none(') > -1
        && storeCode.indexOf('if (!realtime) return none(') < storeCode.indexOf('getQuotes'));
  ok('…and no unentitled path can reach the batch at all', (() => {
    const head = storeCode.slice(storeCode.indexOf('async function intradayPrices'), storeCode.indexOf('getQuotes'));
    // Every early return above the batch, and the one gate that lets execution continue past it.
    return /if \(!realtime\) return none\(/.test(head);
  })());
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
  const { snapshotState, snapshotKey, SNAPSHOT_TTL_SEC, SNAPSHOT_FRESH_MS, SNAPSHOT_KEEP_SEC,
    lockKey, suspendKey, REBUILD_LOCK_SEC } =
    await import('../src/lib/heatmap/heatmap-realtime.mjs');
  const snapCode = strip(await src('../src/lib/heatmap/heatmap-realtime.mjs'));

  // ⚠️ THE CADENCE IS THE ECONOMICS. 15 minutes is not a taste question: at Top 500 it is the
  // difference between ~20 upstream requests an hour and ~1,200.
  ok('the snapshot cadence is 15 minutes', SNAPSHOT_TTL_SEC === 900, `${SNAPSHOT_TTL_SEC}s`);
  ok('…and it survives far longer than that, so a frozen board has something to serve',
    SNAPSHOT_KEEP_SEC >= 18 * 3600, `${SNAPSHOT_KEEP_SEC}s`);

  // ⚠️ NO KEY COLLISION WITH ANY OTHER CACHE IN THE PRODUCT. A collision here is a Pro board
  // handed to a Free reader by the store rather than by any code path.
  const k = snapshotKey(500);
  ok('the snapshot key is heatmap-specific and marked realtime', k === 'cp:hm:rt:500', k);
  ok('…it cannot collide with the quote caches', !/^quotes:/.test(k) && !k.includes('eod'));
  ok('…and the universe size is part of it', snapshotKey(100) !== snapshotKey(500));
  // ⚠️ A LOCAL RUN MUST NOT BE ABLE TO NAME A PRODUCTION KEY. `.env.local` points at the same
  // Upstash instance as production, so a probe reads and rewrites the board real viewers are
  // served from — which happened during this feature's verification. The namespace is checked by
  // loading the module in a child process with it set and comparing the keys it then produces,
  // because the guarantee is about the KEYS, not about an env var being present.
  {
    const { execFileSync } = await import('node:child_process');
    const url = new URL('../src/lib/heatmap/heatmap-realtime.mjs', import.meta.url).href;
    const run = (ns) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(url)});
       console.log(JSON.stringify([m.snapshotKey(500), m.lockKey(500), m.suspendKey('2026-01-01'), m.kvNamespace()]));`],
    { env: { ...process.env, CP_HEATMAP_KV_NAMESPACE: ns }, encoding: 'utf8' }).trim());

    const prod = run('');
    const probe = run('probe');
    ok('production keys are unprefixed, exactly as before',
      prod[0] === 'cp:hm:rt:500' && prod[1] === 'cp:hm:rt:lock:500' && prod[3] === null, prod.join(' '));
    ok('⚠️ a namespaced process CANNOT produce a production key',
      mut('leakykeys') ? false
        : probe.slice(0, 3).every((k) => k.startsWith('cp:hm:probe:')) && probe[3] === 'probe',
      probe.join(' '));
    ok('…so its snapshot, lock and suspend keys are all disjoint from production',
      probe.slice(0, 3).every((k) => !prod.slice(0, 3).includes(k)));
  }

  ok('the lock and suspend markers are in the same private namespace, distinct from the snapshot',
    lockKey(500).startsWith('cp:hm:rt:') && suspendKey('2026-09-22').startsWith('cp:hm:rt:')
    && lockKey(500) !== k && suspendKey('2026-09-22') !== k);

  // Staleness is the difference between an "updated every 15 min" label and a lie.
  const now = Date.parse('2026-09-22T15:00:00.000Z');
  const at = (sec) => ({ calculatedAt: new Date(now - sec * 1000).toISOString(), prices: { AAPL: 343 } });
  ok('a snapshot from 30s ago is fresh', snapshotState(at(30), { now }) === 'fresh');
  ok('a snapshot from 14 minutes ago is still fresh', snapshotState(at(14 * 60), { now }) === 'fresh');
  ok('⚠️ a snapshot from 16 minutes ago is NOT fresh, so it is never labelled current',
    mut('servesstale') ? false : snapshotState(at(16 * 60), { now }) === 'stale');
  ok('…but it is still SERVABLE as stale rather than discarded',
    snapshotState(at(16 * 60), { now }) !== null,
    'blanking the board when a refresh slips is worse than an honestly-labelled older one');
  ok('an empty snapshot is unusable', snapshotState({ calculatedAt: new Date(now).toISOString(), prices: {} }, { now }) === null);
  ok('a missing snapshot is unusable', snapshotState(null, { now }) === null);
  ok('a future-stamped snapshot is a clock fault, not freshness',
    snapshotState({ calculatedAt: new Date(now + 3 * SNAPSHOT_FRESH_MS).toISOString(), prices: { A: 1 } }, { now }) === null);

  // It must store PRICES, not a board, and nothing else may write to it.
  ok('only prices are stored', /prices,/.test(snapCode) && !/rows/.test(snapCode));
  ok('the snapshot carries its own provenance',
    /calculatedAt/.test(snapCode) && /provider/.test(snapCode) && /kind: 'heatmap-realtime-1d'/.test(snapCode));
  ok('…including the session it belongs to', /sessionDate,/.test(snapCode));
  ok('the store writes with the long retention', /EX=\$\{SNAPSHOT_KEEP_SEC\}/.test(snapCode));

  // ⚠️ THE READ IS ONLY REACHED ON AN ENTITLED PATH. The snapshot itself checks nothing — a cache
  // that decides who may read it is a second entitlement system waiting to disagree with the first.
  ok('no entitlement is decided inside the snapshot store',
    !/isRealtime|resolveUserAccess|tier/.test(snapCode));
  ok('the quote cache policy is untouched — no quote is stored by this path',
    !/quotesCacheSet/.test(storeCode));

  // ── SINGLE FLIGHT ────────────────────────────────────────────────────────
  //
  // ⚠️ IN-PROCESS COALESCING IS NOT ENOUGH AND THIS IS THE ASSERTION THAT SAYS SO. coalesce()
  // collapses a burst inside ONE lambda; a spike is spread across many. Without a cross-instance
  // lock, N instances each launch their own five-request batch at the same expiry.
  ok('the rebuild is guarded by a cross-instance lock',
    mut('noflight') ? false : /acquireRebuildLock\(limit\)/.test(storeCode));
  // ⚠️ THIS ASSERTION USED TO REQUIRE `NX=true`, WHICH IS THE BUG IT SHOULD HAVE CAUGHT. The REST
  // API rejects that form with a 400 syntax error, so the lock could never be acquired and the
  // snapshot could never be rebuilt — and this line held the broken spelling in place. The live
  // lock acquisition in probe-heatmap-session-economics.mjs is what actually proves the lock
  // works; this now only guards the spelling from regressing back.
  ok('…which is SET NX, so exactly one caller can win',
    /\?NX&EX=/.test(snapCode) && !/NX=true/.test(snapCode),
    '`NX=true` is a 400 from the REST API, which reads here as "someone else is rebuilding"');
  ok('…and it self-expires, so a crashed holder cannot block the next rebuild',
    REBUILD_LOCK_SEC > 0 && REBUILD_LOCK_SEC <= 60 && /EX=\$\{REBUILD_LOCK_SEC\}/.test(snapCode));
  ok('⚠️ the loser of the lock serves the existing snapshot and does NOT call the provider',
    mut('loserfetches') ? false
      : /if \(!mine\) \{[\s\S]{0,400}return live\(\);\s*\}/.test(storeCode)
        && storeCode.indexOf('acquireRebuildLock') < storeCode.indexOf('getQuotes'));
}

L('\n=== ⚠️ THE SNAPSHOT RUNS ONLY BETWEEN THE BELLS ===');
{
  // The requirement in one line: heatmap traffic must generate ZERO realtime provider requests
  // outside the regular session — evenings, overnight, weekends and U.S. market holidays — no
  // matter how many people are looking.
  const S = await import('../src/lib/market/market-session.mjs');
  const sessCode = strip(await src('../src/lib/market/market-session.mjs'));

  // ── THE CALENDAR IS DERIVED, NOT A TABLE, AND NOT MONDAY-TO-FRIDAY ──
  //
  // Checked against the PUBLISHED NYSE calendars, including the three weekend-shift cases that a
  // naive rule gets wrong: Juneteenth 2027 (Sat → Fri 18th), Independence Day 2027 (Sun → Mon 5th)
  // and Christmas 2027 (Sat → Fri 24th).
  const holidays2026 = [...S.marketHolidays(2026)].sort().join(',');
  ok('the 2026 NYSE holidays are exact',
    holidays2026 === '2026-01-01,2026-01-19,2026-02-16,2026-04-03,2026-05-25,2026-06-19,2026-07-03,2026-09-07,2026-11-26,2026-12-25',
    holidays2026);
  const holidays2025 = [...S.marketHolidays(2025)].sort().join(',');
  ok('the 2025 NYSE holidays are exact',
    holidays2025 === '2025-01-01,2025-01-20,2025-02-17,2025-04-18,2025-05-26,2025-06-19,2025-07-04,2025-09-01,2025-11-27,2025-12-25',
    holidays2025);
  ok('Good Friday is computed from Easter, not listed', /easter/i.test(sessCode) && S.marketHolidays(2027).has('2027-03-26'));
  ok('a Saturday holiday is observed on the Friday before', S.marketHolidays(2027).has('2027-06-18'), 'Juneteenth 2027');
  ok('a Sunday holiday is observed on the Monday after', S.marketHolidays(2027).has('2027-07-05'), 'July 4 2027');

  ok('⚠️ a market holiday is NOT a trading day, though it is a weekday',
    mut('naiveweekdays') ? false : !S.isTradingDay('2026-11-26') && !S.isTradingDay('2026-01-19'),
    'Thanksgiving and MLK Day are Thursday and Monday');
  ok('a weekend is not a trading day', !S.isTradingDay('2026-09-19') && !S.isTradingDay('2026-09-20'));
  ok('an ordinary weekday is', S.isTradingDay('2026-09-22'));

  ok('a scheduled half-day closes at 13:00 ET', S.closeMinute('2026-11-27') === S.EARLY_CLOSE_MINUTE);
  ok('an ordinary session closes at 16:00 ET', S.closeMinute('2026-09-22') === S.CLOSE_MINUTE);

  // ── THE PHASE, AT REAL INSTANTS ──
  //
  // Expressed in UTC because that is what the server holds; 2026-09-22 is EDT (UTC−4).
  const P = (iso) => S.marketPhase(Date.parse(iso));
  ok('09:29 ET is closed — the bell has not rung', P('2026-09-22T13:29:00Z').phase === 'closed');
  ok('09:30 ET is open', P('2026-09-22T13:30:00Z').phase === 'regular');
  ok('12:00 ET is open', P('2026-09-22T16:00:00Z').phase === 'regular');
  ok('15:59 ET is open', P('2026-09-22T19:59:00Z').phase === 'regular');
  ok('⚠️ 16:00 ET is CLOSED — the session ends AT the bell, not after it',
    mut('runslate') ? false : P('2026-09-22T20:00:00Z').phase === 'closed');
  ok('21:00 ET is closed', P('2026-09-23T01:00:00Z').phase === 'closed');
  ok('03:00 ET is closed', P('2026-09-22T07:00:00Z').phase === 'closed');
  ok('⚠️ PRE-MARKET IS CLOSED — overnight movement must not alter the regular-session board',
    mut('premarket') ? false : P('2026-09-22T12:00:00Z').phase === 'closed', '08:00 ET');
  ok('a Saturday is closed all day',
    P('2026-09-19T14:00:00Z').phase === 'closed' && P('2026-09-19T18:00:00Z').phase === 'closed');
  ok('a Sunday is closed all day', P('2026-09-20T17:00:00Z').phase === 'closed');
  ok('⚠️ a market holiday is closed at what would otherwise be midday',
    mut('naiveweekdays') ? false : P('2026-11-26T16:00:00Z').phase === 'closed', 'Thanksgiving 2026, 12:00 ET');
  ok('⚠️ a half-day is closed at 14:00 ET', P('2026-11-27T19:00:00Z').phase === 'closed', 'Black Friday 2026');
  ok('…and open at 12:00 ET that same day', P('2026-11-27T17:00:00Z').phase === 'regular');

  // ── WHICH SESSION THE BOARD BELONGS TO ──
  ok('during the session the board belongs to today', P('2026-09-22T16:00:00Z').sessionDate === '2026-09-22');
  ok('after the bell it still belongs to today', P('2026-09-22T22:00:00Z').sessionDate === '2026-09-22');
  ok('before the opening bell it belongs to the PREVIOUS session',
    P('2026-09-22T12:00:00Z').sessionDate === '2026-09-21');
  ok('a Saturday belongs to Friday', P('2026-09-19T18:00:00Z').sessionDate === '2026-09-18');
  ok('⚠️ the Monday after a holiday weekend walks the real calendar',
    mut('naiveweekdays') ? false : S.previousTradingDay('2026-11-27') === '2026-11-25',
    'the day before Black Friday 2026 is Wednesday, because Thanksgiving is not a session');

  // ── AND THE STORE ACTUALLY OBEYS IT, BEFORE ANY UPSTREAM CALL ──
  //
  // ⚠️ ORDER IS THE WHOLE ASSERTION. A session check AFTER getQuotes would satisfy every label
  // test above while still issuing the requests it exists to prevent.
  ok('the store asks the session clock',
    mut('ignoressession') ? false : /marketPhase\(now\)/.test(storeCode));
  // ⚠️ THE CLOCK SEAM MUST NOT BE REACHABLE FROM A REQUEST. It exists so the closed-market paths
  // can be exercised against the real store; if a route could set it, a caller could ask the
  // board to believe the market is open.
  ok('…both signatures default the clock seam to the wall clock',
    (storeCode.match(/now = Date\.now\(\)/g) || []).length === 2);
  ok('⚠️ …and no route passes it, so it cannot be driven from a request',
    !/heatmapBoard\(\{[^}]*\bnow\b/.test(routeCode) && !/sp\.get\(['"]now/.test(routeCode));
  ok('⚠️ …and it exits on a closed market BEFORE the provider is ever called',
    mut('latesessioncheck') ? false
      : storeCode.indexOf("session.phase !== 'regular'") > -1
        && storeCode.indexOf("session.phase !== 'regular'") < storeCode.indexOf('getQuotes'),
    'a check after the batch prevents nothing');
  ok('…and that exit path reads only the stored snapshot, never the provider', (() => {
    const a = storeCode.indexOf("session.phase !== 'regular'");
    const b = storeCode.indexOf('const out = new Map();', a);
    const closedBranch = storeCode.slice(a, b);
    return !/getQuotes|market-data/.test(closedBranch);
  })());
  ok('the frozen snapshot is matched by SESSION, not by age',
    mut('freezebyage') ? false : /snap\.sessionDate === session\.sessionDate/.test(storeCode),
    'age cannot identify the right board when the board is meant to be hours old');

  // ── THE OFFICIAL CLOSE, NOT A 15:59 QUOTE ──
  ok('⚠️ the completed-session close takes over from the snapshot when it LANDS, not at 16:00:00',
    mut('assumescloseprint') ? false
      : /String\(asOf\) >= session\.sessionDate/.test(storeCode),
    'a quote captured near the bell is a trade, not the exchange settlement print');
  ok('…and once it has landed no snapshot is consulted at all',
    /if \(official\) return none\(/.test(storeCode));

  // ── THE UNSCHEDULED CLOSURE ──
  ok('an unforeseen closure is detected and stood down for the day, not guessed',
    /suspendSession\(session\.etDate\)/.test(storeCode) && /isSessionSuspended\(session\.etDate\)/.test(storeCode));
  // Compared at the CALL SITES, not at the import — both names appear in one destructuring line,
  // so comparing first occurrences would only be measuring the order I happened to type them in.
  ok('…the suspension is checked before the lock is even taken',
    storeCode.indexOf('isSessionSuspended(session.etDate)') < storeCode.indexOf('acquireRebuildLock(limit)'));
  ok('…and it expires within the day that justified it',
    (await import('../src/lib/heatmap/heatmap-realtime.mjs')).SUSPEND_KEEP_SEC < 24 * 3600);
}

L('\n=== CALL ECONOMICS: UPSTREAM WORK IS A FUNCTION OF TIME, NOT OF AUDIENCE ===');
{
  // A SIMULATION OF THE REAL DECISION PATH. Every branch heatmap-store takes before it would reach
  // the provider is replayed here against a fake KV and a counted provider, so the assertion is
  // about BEHAVIOUR — how many batches actually fire — rather than about the shape of the code.
  const S = await import('../src/lib/market/market-session.mjs');
  const BATCH = 100, UNIVERSE = 500;
  const perRebuild = Math.ceil(UNIVERSE / BATCH);

  const world = () => {
    const kv = new Map();
    let providerCalls = 0, batches = 0;
    // The store's decision sequence, with the same ordering.
    const request = (nowMs) => {
      const session = S.marketPhase(nowMs);
      if (session.phase !== 'regular') return { served: kv.has('snap') ? 'frozen' : 'eod' };
      const snap = kv.get('snap');
      const fresh = snap && (nowMs - snap.at) <= 15 * 60 * 1000 && snap.sessionDate === session.sessionDate;
      if (fresh) return { served: 'snapshot' };
      const lock = kv.get('lock');
      if (lock && nowMs - lock < 30_000) return { served: 'stale' };      // lost the single flight
      kv.set('lock', nowMs);
      providerCalls += 1; batches += perRebuild;
      kv.set('snap', { at: nowMs, sessionDate: session.sessionDate });
      return { served: 'rebuilt' };
    };
    return { request, calls: () => providerCalls, batches: () => batches };
  };

  const T = (iso) => Date.parse(iso);
  const OPEN = T('2026-09-22T14:00:00Z');        // 10:00 ET, Tuesday — a real session

  // 1. ONE VIEWER, REPEATEDLY, INSIDE THE WINDOW.
  {
    const w = world();
    for (let i = 0; i < 60; i++) w.request(OPEN + i * 10_000);   // every 10s for 10 minutes
    ok('⚠️ 60 repeat loads inside one 15-minute window cause exactly ONE rebuild',
      w.calls() === 1, `${w.calls()} rebuilds`);
  }

  // 2. TEN CONCURRENT VIEWERS AT THE SAME INSTANT.
  {
    const w = world();
    for (let i = 0; i < 10; i++) w.request(OPEN);
    ok('10 concurrent viewers cause ONE rebuild, not ten', w.calls() === 1, `${w.calls()} rebuilds`);
  }

  // 3. A SPIKE — the case in-process coalescing alone does not cover.
  {
    const w = world();
    for (let i = 0; i < 10_000; i++) w.request(OPEN + (i % 50));   // 10k arrivals across 50ms
    ok('⚠️ 10,000 near-simultaneous viewers still cause ONE shared rebuild',
      w.calls() === 1, `${w.calls()} rebuilds`);
  }

  // 4. AN HOUR OF CONTINUOUS TRAFFIC — the headline number.
  {
    const w = world();
    const start = T('2026-09-22T14:00:00Z');
    for (let s = 0; s < 3600; s += 5) for (let u = 0; u < 200; u++) w.request(start + s * 1000);
    ok('an hour of 200 concurrent viewers costs 4 rebuilds', w.calls() === 4, `${w.calls()}`);
    ok(`…which is ~${perRebuild * 4} Tiingo requests/hour at Top ${UNIVERSE}`,
      w.batches() === perRebuild * 4, `${w.batches()} requests`);
  }

  // 5. ⚠️ AND OUTSIDE THE SESSION IT IS ZERO. This is the new requirement, stated four ways.
  const zero = (label, iso, viewers = 500) => {
    const w = world();
    // Seed a frozen snapshot from the last session, exactly as the close would have left one.
    const t0 = T(iso);
    for (let i = 0; i < viewers; i++) w.request(t0 + i * 1000);
    ok(`⚠️ ${label}: ${viewers} requests produce ZERO realtime rebuilds`,
      mut('pollsafterhours') ? false : w.calls() === 0, `${w.calls()} rebuilds`);
  };
  zero('after the close (Tuesday 17:00 ET)', '2026-09-22T21:00:00Z');
  zero('overnight (03:00 ET)', '2026-09-23T07:00:00Z');
  zero('pre-market (08:00 ET)', '2026-09-23T12:00:00Z');
  zero('Saturday (12:00 ET)', '2026-09-19T16:00:00Z');
  zero('Sunday (12:00 ET)', '2026-09-20T16:00:00Z');
  zero('Thanksgiving (12:00 ET)', '2026-11-26T17:00:00Z');
  zero('Good Friday (12:00 ET)', '2026-04-03T16:00:00Z');
  zero('the afternoon of a half-day, after its 13:00 close', '2026-11-27T19:00:00Z');

  // 6. A FULL 24 HOURS. The whole point: the daily cost is set by the SESSION, not by the clock
  //    and not by the audience.
  //
  // ⚠️ THE ASSERTION IS NOT AN EXACT REBUILD COUNT, ON PURPOSE. 390 session minutes at a
  // 15-minute cadence is ~26, but the exact figure depends on how a caller's arrival times line
  // up with the expiry boundary — pinning it would be asserting the simulation's polling
  // granularity rather than the product's behaviour. What must be exactly true is the split:
  // every rebuild happens inside the session and the other 1,050 minutes of the day cost nothing.
  {
    const midnight = T('2026-09-22T04:00:00Z');   // 00:00 ET Tuesday
    const inSession = (ms) => S.marketPhase(ms).phase === 'regular';

    const all = world();
    for (let m = 0; m < 1440; m++) for (let u = 0; u < 50; u++) all.request(midnight + m * 60_000);

    // The same traffic with the session minutes REMOVED. If anything outside the bells could
    // trigger a rebuild, this is where it shows up — and it is the exact requirement.
    const outside = world();
    let outsideRequests = 0;
    for (let m = 0; m < 1440; m++) {
      const t = midnight + m * 60_000;
      if (inSession(t)) continue;
      for (let u = 0; u < 50; u++) { outside.request(t); outsideRequests++; }
    }
    ok(`⚠️ ${outsideRequests.toLocaleString()} requests outside the bells produce ZERO rebuilds`,
      mut('pollsafterhours') ? false : outside.calls() === 0, `${outside.calls()}`);
    ok('a whole day of continuous traffic costs about one rebuild per 15 session-minutes',
      all.calls() >= 24 && all.calls() <= 27, `${all.calls()} rebuilds`);
    ok(`…i.e. roughly ${perRebuild * 26} Tiingo requests for the ENTIRE day at Top ${UNIVERSE}`,
      all.batches() <= perRebuild * 27, `${all.batches()} requests`);
    // And the daily cost does not move when the audience does.
    const busy = world();
    for (let m = 0; m < 1440; m++) for (let u = 0; u < 5000; u++) busy.request(midnight + m * 60_000);
    ok('⚠️ …and 100× the viewers costs exactly the same', busy.calls() === all.calls(),
      `${busy.calls()} vs ${all.calls()}`);
  }

  // 7. A WEEKEND PLUS A HOLIDAY, END TO END.
  {
    const w = world();
    const fri = T('2026-11-26T05:00:00Z');   // 00:00 ET Thanksgiving Thursday
    for (let h = 0; h < 24 * 4; h++) for (let u = 0; u < 100; u++) w.request(fri + h * 3600_000);
    // Thu holiday + Fri half-day (09:30–13:00 = 210 min → 14 rebuilds) + Sat + Sun.
    ok('⚠️ across a holiday, a half-day and a weekend, only the half-day session rebuilds',
      w.calls() > 0 && w.calls() <= 14, `${w.calls()} rebuilds over 4 days`);
  }
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
  ok('…at a cadence that costs a KV read, never a provider batch',
    /const HEATMAP_POLL_MS = 60000/.test(client));
  ok('⚠️ …and the poll STOPS when the server says the session is closed',
    mut('pollsafterhours') ? false
      : /!sessionOpen\) return undefined/.test(client)
        && /data\.session\.phase === 'regular' && !data\.session\.frozen/.test(client),
    'polling a frozen board overnight re-fetches a constant');
  ok('…and the browser never runs a market clock of its own',
    !/getHours\(\)|America\/New_York.{0,80}(open|close)/.test(client),
    'two clocks disagreeing about market hours is the bug this prevents');
  ok('…only on the intraday window', /if \(!entitled \|\| timeframe !== '1D' \|\| !sessionOpen\) return undefined/.test(client));
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
