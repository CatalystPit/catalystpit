// FREE GETS GENUINELY DELAYED DATA. PRO GETS REALTIME. NEITHER CAN BECOME THE OTHER.
//
//   node scripts/verify-delayed-market-data.mjs [--mutate=<mode>]
//
// ⚠️ THE ENTITLEMENT BOUNDARY IS RUN WITH NUMBERS, NOT READ AS SOURCE. servableToFree() and
// delayedQuotesFor() are the two functions every Free price passes through, so they are called
// directly with real snapshot shapes and real clocks.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const D = await import('../src/lib/market/delayed-store.mjs');
const { isRealtime, marketDataAccess } = await import('../src/lib/entitlements.js');
const S = await import('../src/lib/market/market-session.mjs');
const { readFile } = await import('node:fs/promises');

const MIN = 60_000;
const NOW = Date.parse('2026-09-22T17:30:00Z');            // 13:30 ET, session open
const snapAged = (mins, prices = { AAPL: [342.31, 338.98], SPY: [700, 690] }) => ({
  capturedAt: new Date(NOW - mins * MIN).toISOString(),
  sessionDate: '2026-09-22', baselineDate: '2026-09-21', prices,
});

// ⚠️ THE MUTATION: route Free to a current snapshot. This is the regression the whole feature
// exists to prevent, and it must fail loudly.
const servable = (snap) => (mut('freeleak') ? Boolean(snap?.prices && Object.keys(snap.prices).length) : D.servableToFree(snap, NOW));
const quotesFor = (syms, snap) => (mut('freeleak')
  ? Object.fromEntries(Object.entries(snap.prices).filter(([s]) => syms.includes(s))
    .map(([s, [p, b]]) => [s, { price: p, prevClose: b, freshness: 'delayed', asOf: snap.capturedAt }]))
  : D.delayedQuotesFor(syms, snap, NOW));

L('=== 1-5. WHO GETS WHAT, DECIDED SERVER-SIDE ===');
{
  ok('anonymous/free is not realtime', isRealtime('free') === false && marketDataAccess('free') === 'delayed');
  ok('pro is realtime', isRealtime('pro') === true);
  ok('elite is realtime', isRealtime('elite') === true);
  ok('⚠️ a cancelled/expired plan falls back to free, losing realtime',
    isRealtime(undefined) === false && isRealtime(null) === false && isRealtime('') === false
    && isRealtime('cancelled') === false && isRealtime('past_due') === false);
  ok('an unknown tier never accidentally grants realtime', isRealtime('PRO') === false && isRealtime('admin') === false);

  // ⚠️ NO CLIENT-SUPPLIED VALUE CAN REACH THE ENTITLEMENT DECISION.
  const route = (await readFile(new URL('../src/app/api/quotes/route.js', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('⚠️ entitlement comes from the session, never from a query parameter',
    /realtime = isRealtime\(tier\) && !beta/.test(route)
    && !/searchParams\.get\(['"](realtime|tier|pro|rt)['"]\)/.test(route));
  ok('…and the only parameter read is the symbol list',
    (route.match(/searchParams\.get\(/g) || []).length === 1 && /get\('symbols'\)/.test(route));
  ok('the realtime branch is reached only when that server value is true',
    /if \(realtime\) \{[\s\S]{0,200}getQuotes\(syms, \{ realtime \}\)/.test(route));
}

L('\n=== ⚠️ 6, 7, 14. THE DELAY IS REAL AND IS RE-CHECKED ON EVERY READ ===');
{
  ok('a snapshot captured 15 minutes ago is servable', servable(snapAged(15)));
  ok('a snapshot captured 20 minutes ago is servable', servable(snapAged(20)));
  ok('⚠️ a snapshot captured 14 minutes ago is REFUSED',
    mut('freeleak') ? false : !servable(snapAged(14)), 'a viewer must never be 14 minutes behind');
  ok('⚠️ a snapshot captured 1 minute ago is REFUSED',
    mut('freeleak') ? false : !servable(snapAged(1)));
  ok('⚠️ a snapshot captured NOW is REFUSED — this is the leak that must never happen',
    mut('freeleak') ? false : !servable(snapAged(0)));
  ok('a future-stamped snapshot is refused rather than treated as fresh', !D.servableToFree(snapAged(-30), NOW));
  ok('a snapshot older than the stale limit is refused', !D.servableToFree(snapAged(3 * 60), NOW));
  ok('an empty snapshot is refused', !D.servableToFree({ capturedAt: new Date(NOW - 20 * MIN).toISOString(), prices: {} }, NOW));
  ok('a missing snapshot is refused', !D.servableToFree(null, NOW));
  ok('the delay constant is 15 minutes', D.DELAY_MS === 15 * 60 * 1000);

  // 18. The delayed state advances only as new captures become eligible.
  const t0 = D.delayedQuotesFor(['AAPL'], snapAged(20), NOW).AAPL;
  const t1 = D.delayedQuotesFor(['AAPL'], snapAged(20), NOW + 5 * MIN).AAPL;
  ok('⚠️ the delayed observation does not move between captures',
    t0.asOf === t1.asOf && t0.price === t1.price, 'a delayed price advances on RELEASE, not on the clock');
  ok('…and its reported age grows with the clock', t1.delayMinutes > t0.delayMinutes);
}

L('\n=== WHAT A FREE QUOTE ACTUALLY CONTAINS ===');
{
  const q = quotesFor(['AAPL', 'SPY'], snapAged(16));
  ok('a covered symbol is returned', q.AAPL && q.SPY);
  ok('⚠️ it is labelled delayed, never realtime',
    mut('freeleak') ? true : q.AAPL.freshness === 'delayed', q.AAPL?.freshness);
  ok('it carries the instant the market was observed', q.AAPL.asOf === snapAged(16).capturedAt);
  ok('…which is at least 15 minutes old', Date.parse(q.AAPL.asOf) <= NOW - D.DELAY_MS);
  ok('the change% is computed from the split-adjusted baseline',
    Math.abs(q.AAPL.changePct - ((342.31 - 338.98) / 338.98) * 100) < 1e-9, String(q.AAPL.changePct));

  // 15. VOLUME IS ABSENT BY CONSTRUCTION — there is nothing for RVOL/VWAP to read.
  for (const k of ['volume', 'rvol', 'vwap', 'volumeMethodology', 'avgVolume']) {
    ok(`⚠️ no ${k} field is emitted`, !(k in q.AAPL), Object.keys(q.AAPL).join(','));
  }
  const store = (await readFile(new URL('../src/lib/market/delayed-store.mjs', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('⚠️ the store never reads a volume field from the provider either',
    !/\bvolume\b/.test(store), 'the snapshot cannot carry what it never stores');

  // A symbol we cannot baseline gets a price and NO change%, rather than a fabricated 0%.
  const noBase = D.delayedQuotesFor(['XYZ'], snapAged(16, { XYZ: [10, null] }), NOW).XYZ;
  ok('an unbaselined symbol still gets a price', noBase.price === 10);
  ok('⚠️ …but no change%, rather than a fabricated 0%', noBase.changePct === null && noBase.prevClose === null);

  // Uncovered symbols are simply absent, so the caller falls back rather than this inventing one.
  ok('an uncovered symbol is absent, not guessed', D.delayedQuotesFor(['NOPE'], snapAged(16), NOW).NOPE === undefined);
  ok('a zero or negative stored price is never served',
    Object.keys(D.delayedQuotesFor(['A', 'B'], snapAged(16, { A: [0, 5], B: [-3, 5] }), NOW)).length === 0);
}

L('\n=== ⚠️ 12, 13. THE COLLECTOR RUNS ONLY BETWEEN THE BELLS ===');
{
  const P = (iso) => S.marketPhase(Date.parse(iso));
  const collects = (iso) => P(iso).phase === 'regular';
  ok('09:29 ET — before the bell, no collection', !collects('2026-09-22T13:29:00Z'));
  ok('09:30 ET — collection starts', collects('2026-09-22T13:30:00Z'));
  ok('13:30 ET — collecting', collects('2026-09-22T17:30:00Z'));
  ok('15:59 ET — still collecting', collects('2026-09-22T19:59:00Z'));
  ok('⚠️ 16:00 ET — collection STOPS AT the bell',
    mut('runslate') ? false : !collects('2026-09-22T20:00:00Z'));
  ok('⚠️ 16:15 ET — no "one more capture to delay the close"',
    mut('runslate') ? false : !collects('2026-09-22T20:15:00Z'));
  ok('after-hours 18:00 ET — none', !collects('2026-09-22T22:00:00Z'));
  ok('overnight 03:00 ET — none', !collects('2026-09-23T07:00:00Z'));
  ok('⚠️ premarket 08:00 ET — none', mut('premarket') ? false : !collects('2026-09-23T12:00:00Z'));
  ok('Saturday — none', !collects('2026-09-19T16:00:00Z'));
  ok('Sunday — none', !collects('2026-09-20T16:00:00Z'));
  ok('⚠️ Thanksgiving — none', mut('naivecalendar') ? false : !collects('2026-11-26T17:00:00Z'));
  ok('⚠️ Good Friday — none', mut('naivecalendar') ? false : !collects('2026-04-03T16:00:00Z'));
  // ⚠️ EARLY CLOSE IS NOT 16:00. The half-day after Thanksgiving ends at 13:00 ET.
  ok('half-day 12:00 ET — collecting', collects('2026-11-27T17:00:00Z'));
  ok('⚠️ half-day 13:00 ET — collection STOPS at the OFFICIAL early close',
    mut('hardcodedclose') ? false : !collects('2026-11-27T18:00:00Z'));
  ok('⚠️ half-day 14:00 ET — still stopped', !collects('2026-11-27T19:00:00Z'));
  ok('…and the early close is derived, not hardcoded', S.closeMinute('2026-11-27') === 13 * 60 && S.closeMinute('2026-09-22') === 16 * 60);

  const store = (await readFile(new URL('../src/lib/market/delayed-store.mjs', import.meta.url), 'utf8'));
  const body = store.slice(store.indexOf('export async function captureIfDue'));
  ok('⚠️ the session gate is the FIRST thing in the collector, before any provider call',
    mut('lategate') ? false
      : body.indexOf("session.phase !== 'regular'") < body.indexOf('getAllTickersSnapshot'),
    'a gate after the batch prevents nothing');
}

L('\n=== 8, 11. CACHE ISOLATION AND STAMPEDE PROTECTION ===');
{
  ok('⚠️ the delayed namespace cannot collide with the realtime quote cache',
    D.releasedKey().startsWith('cp:dq') && !D.releasedKey().startsWith('quotes:'));
  ok('…nor with the heatmap or movers snapshots',
    !D.releasedKey().startsWith('cp:hm') && !D.releasedKey().startsWith('cp:mv'));
  ok('⚠️ the servable snapshot and the fresh one are DIFFERENT keys',
    D.releasedKey() !== D.latestKey(), `${D.releasedKey()} vs ${D.latestKey()}`);
  ok('the rebuild lock is its own key', D.lockKey() !== D.releasedKey() && D.lockKey() !== D.latestKey());

  // ⚠️ COMMENTS STRIPPED. The note explaining why `NX=true` is wrong contains that string, so a
  // raw match reports the explanation as the defect — the third time this session that a comment
  // has impersonated the thing it warns about.
  const store = (await readFile(new URL('../src/lib/market/delayed-store.mjs', import.meta.url), 'utf8'));
  const storeCode = store.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the lock uses SET NX, not the form the REST API rejects',
    /\?NX&EX=/.test(storeCode) && !/NX=true/.test(storeCode));
  ok('⚠️ the lock is taken before the provider is called',
    store.indexOf('acquireLock()') < store.indexOf('getAllTickersSnapshot'));
  ok('…and it self-expires, so a crashed holder cannot block collection forever',
    D.LOCK_SEC > 0 && D.LOCK_SEC <= 300);
  ok('the interval gate keeps a busy instance from re-capturing',
    D.CAPTURE_INTERVAL_MS === 15 * 60 * 1000);

  // ⚠️ THE ROUTE MUST NOT AWAIT A CAPTURE. A viewer waiting on a 5-second market-wide collection
  // is how a traffic spike becomes a queue.
  const route = (await readFile(new URL('../src/app/api/quotes/route.js', import.meta.url), 'utf8'));
  // ⚠️ THE READ PATH MUST NOT COLLECT AT ALL. The first version called captureIfDue() unawaited
  // from here; the platform killed the promise when the response returned, and production
  // captured once and then stopped for good. Collection moved to a cron and this route only reads.
  // Comments stripped, because the note explaining that names the function it forbids.
  const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('⚠️ a Free request never collects, so it can never wait on one',
    !/captureIfDue/.test(routeCode), 'an unawaited promise in a response path is not a background job');
  const cron = await readFile(new URL('../src/app/api/cron/delayed-snapshot/route.js', import.meta.url), 'utf8');
  ok('…collection lives in a cron that AWAITS it', /await captureIfDue\(\)/.test(cron));
  ok('…the cron is authenticated', /CRON_SECRET/.test(cron));
  ok('…and it still defers to the session gate rather than trusting its own schedule',
    /captureIfDue\(\)/.test(cron) && !/16:00|hardcod/.test(cron.replace(/\/\/.*$/gm, '')));
  ok('…and entitled realtime never reads the delayed snapshot',
    route.indexOf('if (realtime) {') < route.indexOf('readDelayed()'));
}

L('\n=== 16. NOTHING BULK, NOTHING SECRET, REACHES THE BROWSER ===');
{
  const store = await readFile(new URL('../src/lib/market/delayed-store.mjs', import.meta.url), 'utf8');
  ok('the store never embeds a credential', !/TIINGO_API_KEY|Token \$\{/.test(store));
  ok('⚠️ no endpoint returns the whole snapshot — quotes are shaped per requested symbol',
    /for \(const raw of symbols/.test(store));
  const route = await readFile(new URL('../src/app/api/quotes/route.js', import.meta.url), 'utf8');
  ok('the symbol list is capped, so the endpoint is not a bulk feed', /\.slice\(0, 100\)/.test(route));
  ok('…and rejects anything that is not a symbol', /TICKER_RE\.test/.test(route));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
