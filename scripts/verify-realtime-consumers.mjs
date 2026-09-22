// CHART AND WATCHLIST ACTUALLY CONSUME THE ENTITLED REALTIME PRICE.
//
//   node --env-file=.env.local scripts/verify-realtime-consumers.mjs [--mutate=<mode>]
//
// ⚠️ THE BUG THIS COVERS WAS NOT AN ENTITLEMENT BUG. Realtime was verified and live server-side
// and the Terminal still showed delayed data, because neither consumer was connected to it:
//
//   · the Chart read /api/chart-intraday — POLYGON, with `const DELAYED = true` hardcoded — and
//     labelled itself from that historical source's flag
//   · the Watchlist called loadRows() ONCE on mount with no interval, from a Finnhub quote in a
//     shared cache with no tier in the key
//
// So these assertions are about the wiring and the arithmetic, run as behaviour. Whether the
// SERVER may serve a realtime value is covered by verify-tiingo-realtime; this is about whether
// the screen shows it.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const { readFile } = await import('node:fs/promises');
const src = async (p) => (await readFile(new URL(p, import.meta.url), 'utf8'));
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const shared = await src('../src/lib/cp-shared.jsx');
const term = await src('../src/app/terminal/TerminalClient.jsx');
const chart = await src('../src/components/chart/CPChart.jsx');
const sharedCode = decomment(shared), termCode = decomment(term), chartCode = decomment(chart);

L('=== ONE REALTIME SOURCE OF TRUTH, NOT ONE PER COMPONENT ===');
{
  ok('a single shared quote hook exists',
    mut('nohook') ? false : /export function useRealtimeQuotes\(/.test(sharedCode));
  ok('…it reads the canonical entitled endpoint', /fetch\(`\/api\/quotes\?symbols=/.test(sharedCode));
  ok('…and both consumers use it, rather than each polling their own way',
    mut('nohook') ? false : /useRealtimeQuotes\(/.test(termCode) && /useRealtimeQuotes\(/.test(chartCode));

  // ⚠️ THE KEY IS THE POINT. Subscribing on the ARRAY re-runs the effect every render, which turns
  // one poller into several and is how a ticker switch leaks the previous symbol's interval.
  ok('the poll is keyed on the symbols, not the array identity',
    mut('leakysub') ? false : /\}, \[key, intervalMs\]\)/.test(sharedCode));
  ok('…and the interval is cleared on unmount', /clearInterval\(timer\)/.test(sharedCode));
  ok('…and the visibility listener is removed too',
    /removeEventListener\('visibilitychange', onVis\)/.test(sharedCode));

  // No browser may hold the vendor credential or its own vendor socket.
  ok('no Tiingo key reaches the browser',
    !/TIINGO_API_KEY/.test(sharedCode) && !/TIINGO_API_KEY/.test(termCode) && !/TIINGO_API_KEY/.test(chartCode));
  ok('no component opens its own vendor websocket',
    mut('browsersocket') ? false
      : !/wss:\/\/api\.tiingo\.com/.test(sharedCode + termCode + chartCode));
}

L('\n=== THE CHART MERGES A TICK WITHOUT INVENTING A CANDLE ===');
{
  // The exact arithmetic the overlay performs, replayed.
  const merge = (last, tick) => ({
    ...last,
    close: tick,
    high: Math.max(Number(last.high), tick),
    low: Math.min(Number(last.low), tick),
  });
  const bar = { time: 1, open: 100, high: 101, low: 99, close: 100.5, volume: 12345 };

  ok('a tick above the high extends the high', merge(bar, 102).high === 102);
  ok('a tick below the low extends the low', merge(bar, 98).low === 98);
  ok('a tick inside the range moves only the close',
    merge(bar, 100.2).high === 101 && merge(bar, 100.2).low === 99 && merge(bar, 100.2).close === 100.2);
  ok('the OPEN is never rewritten by a tick',
    mut('rewritesopen') ? false : merge(bar, 102).open === 100 && merge(bar, 98).open === 100);

  // ⚠️ THE ONE THAT MATTERS MOST FOR HONESTY.
  ok('VOLUME IS NEVER TOUCHED BY A TICK',
    mut('fakevolume') ? false : merge(bar, 102).volume === 12345,
    'a live price with a fabricated volume is the RVOL fabrication wearing a candle');

  ok('the overlay updates the bar in progress, never appends one',
    mut('appendsbar') ? false
      : /bars\[bars\.length - 1\] = merged/.test(chartCode) && !/bars\.push\(/.test(chartCode));
  ok('…and it reuses the chart’s own incremental update path',
    /priceRef\.current\.update\(chartTypeOf\(typeRef\.current\)\.map\(merged\)\)/.test(chartCode));
  ok('a series torn down mid-update cannot take the panel with it',
    /catch \{ \/\* a series mid-teardown/.test(chart));
}

L('\n=== THE LABEL DESCRIBES THE PRICE, NOT THE HISTORY PROVIDER ===');
{
  ok('the footer no longer reads the historical delayed flag alone',
    mut('staleLabel') ? false : /liveIsRealtime \? 'Real-time price · ' : \(meta\?\.delayed === true/.test(chartCode));
  ok('the DELAYED badge agrees with the footer',
    /delayed=\{!liveIsRealtime && meta\?\.delayed === true\}/.test(chartCode));

  // ⚠️ REALTIME IS THE SERVER'S VERDICT. Inferring it from a moving number would let any feed
  // promote itself, which is the exact failure resolveQuoteEntitlement exists to prevent.
  ok('realtime status comes from the server stamp, not from the price',
    mut('inferslive') ? false : /freshness === 'realtime'/.test(sharedCode));
  ok('…and a stale quote is not shown as realtime',
    mut('staleaslive') ? false : /isRealtimeQuote\(liveQuote\) && !liveStale/.test(chartCode));
  // ⚠️ SCOPED TO THE REALTIME OVERLAY, NOT THE WHOLE FILE — and the first version was not, which
  // failed on two pre-existing and legitimate things: a VWAP chart INDICATOR (a study computed
  // from the chart's own bars, not a claim about our feed) and an RVOL chip fed from
  // screenerStocks.relVol, which is last.volume/avgVol over CONSOLIDATED DAILY bars. Neither
  // touches the Tiingo intraday venue feed. Banning the words everywhere would have meant
  // deleting correct features to satisfy a test.
  //
  // What must be true is narrower and sharper: the realtime path introduces no volume claim.
  const overlay = chartCode.slice(chartCode.indexOf('const { quotes: liveQuotes'),
    chartCode.indexOf('// ── polling refresh'));
  ok('the realtime overlay makes no volume, RVOL or VWAP claim',
    mut('fakevolume') ? false : !/volume|rvol|vwap/i.test(overlay.replace(/v: merged\.volume/g, '')),
    overlay.match(/.{0,40}(volume|rvol|vwap).{0,30}/i)?.[0] || '');
}

L('\n=== FREE CANNOT REACH A REALTIME VALUE THROUGH EITHER CONSUMER ===');
{
  const route = await src('../src/app/api/quotes/route.js');
  const routeCode = decomment(route);
  // The consumers send only symbols. Entitlement is not a parameter they could spoof.
  ok('the hook sends symbols and nothing else',
    mut('clientflag') ? false
      : /fetch\(`\/api\/quotes\?symbols=\$\{encodeURIComponent\(key\)\}`/.test(sharedCode)
        && !/realtime=|tier=|pro=/.test(sharedCode));
  ok('the route derives entitlement from the session',
    /const \{ userId \} = await auth\(\)/.test(routeCode) && /resolveUserAccess\(\)/.test(routeCode));
  // Scoped to the entitled branch itself — slicing to `const cached` now spans the Free delayed
  // path, whose EOD fallback legitimately writes to the shared cache.
  ok('…and realtime is never written to the shared cache', (() => {
    const i = routeCode.indexOf('if (realtime) {');
    return !/quotesCacheSet/.test(routeCode.slice(i, routeCode.indexOf('\n    }', i)));
  })());
  ok('…nor served from a public cache', /'private, no-store'/.test(routeCode));

  // The percent the watchlist renders must come from one consistent pair.
  const changeOf = (q, row) => (q && q.price != null && q.prevClose != null && q.prevClose !== 0)
    ? ((q.price - q.prevClose) / q.prevClose) * 100 : row.changePct;
  ok('percent is computed from the quote’s own price and prevClose',
    Math.abs(changeOf({ price: 110, prevClose: 100 }, { changePct: -5 }) - 10) < 1e-9);
  ok('…and falls back wholesale when the quote is incomplete',
    mut('mixespairs') ? false : changeOf({ price: 110, prevClose: null }, { changePct: -5 }) === -5,
    'a live price over another provider’s close describes neither');
  ok('…and when there is no quote at all', changeOf(undefined, { changePct: -5 }) === -5);
  ok('the watchlist now polls rather than loading once',
    mut('nopoll') ? false : /useRealtimeQuotes\(wlSymbols\)/.test(termCode));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
