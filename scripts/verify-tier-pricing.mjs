// TIER-SPECIFIC PRICING — what each reader is served, and what the badge over it is allowed to say.
//
//   node scripts/verify-tier-pricing.mjs
//   CP_MUT=<name> node scripts/verify-tier-pricing.mjs      (mutation testing — see MUTATIONS)
//
// ── WHAT THIS SUITE IS FOR ───────────────────────────────────────────────────────────────────────
//
// Two defects, reported together, with one shape between them:
//
//   1. The homepage Market Snapshot and ticker tape printed a HARDCODED "DELAYED" — to a paying Pro
//      subscriber, over the PREVIOUS SESSION'S closes. Measured mid-session on Monday 2026-11-23:
//      the tape served Friday 2026-11-20 closes, NVDA at 125.53 against a live print of 166.55.
//      One string literal standing in for three different products, wrong for all three.
//
//   2. Watchlist rows read 0.00%. That figure has three historical sources, all the same mistake:
//      `(c - pc) / pc` where c IS pc; `Number(null)` resolving to a finite zero; and
//      `parseFloat(x) || 0` in three separate components.
//
// So the assertions below are about two pure modules — the label and the row rule — because the
// surfaces themselves need Clerk, a database and a provider, and a regex over their source is the
// kind of test that passes while the page is wrong.
//
// ⚠️ WHAT IS DELIBERATELY NOT ASSERTED HERE: whether THIS deployment is licensed for real-time.
// That is `TIINGO_REALTIME_ENABLED` plus the KV stop order, resolved at runtime and failing closed.
// The point of reading freshness off the SERVED QUOTES is that no test, and no page, has to know:
// an unlicensed deployment stamps 'eod' and the badge says LAST CLOSE.

import { rowPrice } from '../src/lib/market/row-price.mjs';
import { changeForPrice, settledChange, sessionOf, CHANGE_BASIS } from '../src/lib/market/settled-change.mjs';
// ⚠️ THE SHIPPED IMPLEMENTATION, EXECUTED — NOT A COPY OF IT. The first version of this suite
// restated the two-line label composition locally, because cp-shared.jsx cannot be imported by a
// test, and pinned the real one with a regex. A test that runs its own copy of the logic and greps
// the production copy is the exact shape that has produced false greens in this codebase, so the
// rule was moved into a pure module and both the page and this file now call the same function.
import { priceFreshnessLabel, quotesFreshness } from '../src/lib/market/price-freshness.mjs';
import { resolveQuoteEntitlement } from '../src/lib/market/tiingo.mjs';
import { maybeN } from '../src/lib/num.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL  ${name}`); } };
const sec = (t) => console.log(`\n${t}`);

// ─────────────────────────────────────────────────────────────────────────────
sec('THE BADGE — IT DESCRIBES THE PRICES, NEVER THE SUBSCRIPTION');

ok('a real-time quote reads REAL-TIME', priceFreshnessLabel('realtime') === 'REAL-TIME');
ok('a settled close reads LAST CLOSE', priceFreshnessLabel('eod') === 'LAST CLOSE');
ok('a delayed quote reads DELAYED', priceFreshnessLabel('delayed') === 'DELAYED');

// ⚠️ THE MEASURED DELAY, NOT AN ASSUMED 15. The released snapshot was 40 minutes old when this was
// written — the capture cron fires every 15 minutes and the store holds a release back until it is
// at least 15 minutes stale, so "15-MIN DELAYED" is a number the product cannot promise.
ok('⚠️ a delayed quote quotes the delay it actually has', priceFreshnessLabel('delayed', 40) === 'DELAYED · 40M');
ok('a delay of zero or less is not quoted', priceFreshnessLabel('delayed', 0) === 'DELAYED');
ok('an unparseable delay is not quoted', priceFreshnessLabel('delayed', 'soon') === 'DELAYED');
ok('the delay is only quoted where it means something', priceFreshnessLabel('realtime', 40) === 'REAL-TIME');

// ⚠️ THE HARDCODED LITERAL IS THE BUG, SO ABSENCE MUST NOT RESOLVE TO A LIVE CLAIM.
ok('⚠️ an absent freshness is not a live one', priceFreshnessLabel(null) === 'LAST CLOSE');
ok('⚠️ an unknown freshness is not a live one', priceFreshnessLabel('bogus') === 'LAST CLOSE');
ok('⚠️ no input at all is not a live one', priceFreshnessLabel(undefined) === 'LAST CLOSE');
ok('a mixture does not claim REAL-TIME for every row', priceFreshnessLabel('mixed') === 'REAL-TIME · PARTIAL');

sec('ONE FRESHNESS FOR A ROW OF PRICES');

ok('an all-live set is live', quotesFreshness({ A: { freshness: 'realtime' }, B: { freshness: 'realtime' } }).freshness === 'realtime');
ok('an all-settled set is settled', quotesFreshness({ A: { freshness: 'eod' }, B: { freshness: 'eod' } }).freshness === 'eod');
// ⚠️ ONE UNPRICED SYMBOL MUST NOT COLLAPSE A LIVE TAPE. The scan board got this wrong twice in
// opposite directions; this reuses its conclusion rather than reaching a third one.
ok('⚠️ one settled symbol among live ones is a mixture, not a downgrade',
  quotesFreshness({ A: { freshness: 'realtime' }, B: { freshness: 'eod' } }).freshness === 'mixed');
ok('an empty set has no freshness and makes no claim',
  quotesFreshness({}).freshness === null && quotesFreshness({}).delayMinutes === null);
ok('a null payload makes no claim', quotesFreshness(null).freshness === null);
ok('non-objects in the map are ignored', quotesFreshness({ A: null, B: 7, C: { freshness: 'realtime' } }).freshness === 'realtime');

// ⚠️ THE WORST DELAY, NOT THE BEST. A badge over a row of prices may not quote the most flattering
// number in it.
ok('⚠️ the badge quotes the worst delay present',
  quotesFreshness({ A: { freshness: 'delayed', delayMinutes: 16 }, B: { freshness: 'delayed', delayMinutes: 41 } }).delayMinutes === 41);
ok('a set with no stated delay quotes none',
  quotesFreshness({ A: { freshness: 'delayed' } }).delayMinutes === null);

sec('THE ROW RULE — WHERE A PERCENTAGE MAY COME FROM');

// An entitled real-time quote: its own figure, labelled for what it is.
{
  const r = rowPrice({ entitled: { price: 166.55, changePct: 32.68, freshness: 'realtime' } });
  ok('a real-time quote supplies its own change', r.changePct === 32.68 && r.price === 166.55);
  ok('a real-time row is labelled realtime', r.changeBasis === 'realtime' && r.freshness === 'realtime');
}
{
  const r = rowPrice({ entitled: { price: 166.06, changePct: 32.28, freshness: 'delayed', delayMinutes: 40 } });
  ok('a delayed quote supplies its own change', r.changePct === 32.28);
  ok('a delayed row is labelled delayed, with its delay', r.changeBasis === 'delayed' && r.delayMinutes === 40);
}

// ── ⚠️ THE 0.00% RULE ───────────────────────────────────────────────────────
//
// A quote whose price IS the previous close reports NO percentage. The row must then fall to the
// completed session's own return — never to a zero, and never to arithmetic on two equal numbers.
//
// ⚠️ AND ONLY WHEN THAT SESSION'S CLOSE IS THIS PRICE. NVDA's real 2026-11-20 session, whose close
// 125.53 is the price being shown, so it genuinely describes it.
{
  const r = rowPrice({
    entitled: { price: 125.53, changePct: null, freshness: 'eod' },
    session: { close: 125.53, prevClose: 145.98, changePct: -14.0088, session: '2026-11-20' },
  });
  ok('⚠️ a quote with no change falls to the completed session, not to zero', r.changePct === -14.0088);
  ok('and says which session it is describing', r.changeBasis === 'last_session');
}
{
  // The exact trap: Number(null) === 0 and Number.isFinite(0) === true.
  const r = rowPrice({
    entitled: { price: 10.25, changePct: null, freshness: 'realtime' },
    session: { close: 10.25, prevClose: 10, changePct: 2.5, session: '2026-11-20' },
  });
  ok('⚠️ a null change is not a zero change', r.changePct === 2.5 && r.changeBasis === 'last_session');
}
{
  const r = rowPrice({
    cached: { c: 342.56, dp: null },
    session: { close: 342.56, prevClose: 349.21, changePct: -1.9043, session: '2026-11-20' },
  });
  ok('⚠️ a cached quote with a null dp falls to the session', r.changePct === -1.9043);
  ok('a settled cached quote is labelled eod, not delayed', r.freshness === 'eod');
}
{
  const r = rowPrice({
    close: 87.61,
    session: { close: 87.61, prevClose: 88.87, changePct: -1.4178, session: '2026-11-20' },
  });
  ok('a stored close still carries the session return', r.changePct === -1.4178 && r.price === 87.61);
  ok('a stored close is labelled eod', r.freshness === 'eod');
}

// ⚠️ ZERO IS A REAL MARKET OUTCOME AND MUST SURVIVE. This is the assertion that stops the fix from
// becoming "hide all zeros", which would delete the one honest flat reading.
{
  const r = rowPrice({ entitled: { price: 50, changePct: 0, freshness: 'realtime' } });
  ok('⚠️ a genuine flat move is still reported as zero', r.changePct === 0 && r.changeBasis === 'realtime');
}
{
  const r = rowPrice({ session: { close: 50, prevClose: 50, changePct: 0, session: '2026-11-20' }, close: 50 });
  ok('⚠️ a genuinely flat session is still zero, not a dash', r.changePct === 0 && r.changeBasis === 'last_session');
}

// Unknown from every source → null, which the UI renders as a dash.
{
  const r = rowPrice({});
  ok('nothing known anywhere is null, never zero', r.changePct === null && r.price === null);
  ok('and claims no basis', r.changeBasis === null);
}
{
  const r = rowPrice({ close: 12.34 });
  ok('a price with no known change is a price and a dash', r.price === 12.34 && r.changePct === null);
}

sec('PRECEDENCE — THE ENTITLED SOURCE IS NOT SECOND-GUESSED');

{
  const r = rowPrice({
    entitled: { price: 166.55, changePct: 32.68, freshness: 'realtime' },
    cached: { c: 125.53, dp: null },
    close: 125.53,
    session: { changePct: -14.0088 },
  });
  ok('⚠️ a real-time price outranks the cache, the close and the session', r.price === 166.55 && r.changePct === 32.68);
}
{
  const r = rowPrice({ cached: { c: 342.56, dp: 1.5 }, close: 300, session: { changePct: -9 } });
  ok('a cached quote outranks the stored close', r.price === 342.56 && r.changePct === 1.5);
}

sec('THE LICENCE GATE — BOTH HALVES REQUIRED');

// Not new behaviour; asserted here because this suite is about what a reader is served, and this is
// the function that decides whether a live print may be served at all.
ok('entitled and live → real-time',
  resolveQuoteEntitlement({ entitled: true, vendorIsLive: true }).freshness === 'realtime');
ok('⚠️ a live vendor without entitlement is NOT real-time',
  resolveQuoteEntitlement({ entitled: false, vendorIsLive: true }).freshness === 'eod');
ok('⚠️ and an unentitled reader is served the close, not the live print',
  resolveQuoteEntitlement({ entitled: false, vendorIsLive: true }).useLivePrice === false);
ok('entitled but the vendor is quiet → not a live claim',
  resolveQuoteEntitlement({ entitled: true, vendorIsLive: false }).freshness === 'eod');
ok('no arguments at all → not a live claim',
  resolveQuoteEntitlement().freshness === 'eod');

sec('maybeN — THE READER THAT PRESERVES THE DIFFERENCE');

ok('null is unknown', maybeN(null) === null);
ok('undefined is unknown', maybeN(undefined) === null);
ok('⚠️ zero is a number, not unknown', maybeN(0) === 0);
ok('a numeric string parses', maybeN('1.25') === 1.25);
ok('a non-numeric string is unknown', maybeN('n/a') === null);

sec('THE SURFACES ACTUALLY PASS IT THROUGH');

// ⚠️ A PURE RULE NOBODY CALLS IS A GREEN TEST OVER A BROKEN PAGE — this session has produced that
// exact false green before. These read the real files to confirm the hardcoded literal is gone and
// the wiring exists. Source assertions, used only for wiring, never for behaviour.
const fs = await import('node:fs');
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const shared = read('src/lib/cp-shared.jsx');

// Comments are stripped before asserting an ABSENCE, because the explanatory note above each fix
// quotes the very string being banned — a trap this codebase has fallen into three times.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
// ⚠️ SCOPED TO THE FUNCTION, NOT TO A FIXED NUMBER OF CHARACTERS. The first version sliced 3000
// chars, which does not reach the end of TickerTape — so the "no hardcoded word" assertion was
// reading a window that contained neither the literal nor its replacement, and reported a failure
// for a fix that was in place. A window that cannot see the thing it asserts about is not a test.
const fn = (src, name) => {
  const i = src.indexOf(`export function ${name}`);
  if (i < 0) return '';
  const next = src.indexOf('\nexport ', i + 1);
  return stripComments(src.slice(i, next < 0 ? src.length : next));
};

ok('⚠️ TickerTape no longer hardcodes a freshness word',
  !/>DELAYED</.test(fn(shared, 'TickerTape')) && /priceFreshnessLabel\(/.test(fn(shared, 'TickerTape')));
ok('⚠️ MarketSnapshotCard no longer hardcodes a freshness word',
  !/>DELAYED</.test(fn(shared, 'MarketSnapshotCard')) && /priceFreshnessLabel\(/.test(fn(shared, 'MarketSnapshotCard')));
ok('MarketSnapshotCard renders a dash for an unknown change',
  /t\.chg == null \?/.test(fn(shared, 'MarketSnapshotCard')));

const home = read('src/components/CatalystPit.jsx');
ok('the homepage prices the tape from the entitled route, not only the public cache',
  /useRealtimeQuotes\(quoteSyms\)/.test(home) && /tickers=\{tickersPriced\}/.test(home));
ok('the homepage asks for the tape symbols, not just the four indices',
  /\[\.\.\.new Set\(\[\.\.\.IDX_SYMS, \.\.\.tapeSyms\]\)\]/.test(home));
ok('the homepage passes freshness to both price surfaces',
  (home.match(/freshness=\{priceFreshness\}/g) || []).length >= 2);

const news = read('src/components/NewsFeed.jsx');
ok('⚠️ the News page no longer coerces a missing change to zero',
  !/chg: parseFloat\([^)]*\) \|\| 0/.test(stripComments(news)) && /chg: maybeN\(/.test(news));
ok('the News page prices its tape from the entitled route too',
  /useRealtimeQuotes\(tapeSyms\)/.test(news));

const term = read('src/app/terminal/TerminalClient.jsx');
ok('⚠️ the Terminal tape no longer coerces a missing change to zero',
  !/chg: parseFloat\([^)]*\) \|\| 0/.test(stripComments(term)) && /chg: maybeN\(/.test(term));

const wl = read('src/app/api/watchlist/route.js');
ok('the watchlist resolves the caller\'s entitlement before pricing',
  /callerRealtimeAccess\(\)/.test(wl));
ok('⚠️ the watchlist no longer asks for realtime:false unconditionally',
  /getQuotes\(tickers, \{ realtime: true \}\)/.test(wl));
ok('the watchlist uses the shared row rule rather than inlining it',
  /rowPrice\(\{/.test(wl));

// ⚠️ REQUIREMENT: A PAID REAL-TIME PRINT NEVER ENTERS A SHARED CACHE. The entitled branch must not
// touch kvSet at all — asserted on the function body, with comments stripped.
const entitledFn = (() => {
  const i = wl.indexOf('async function entitledQuotes');
  return stripComments(wl.slice(i, wl.indexOf('async function withPrices')));
})();
ok('⚠️ the entitled quote path writes nothing to the shared cache',
  !/kvSet|quotesCacheSet/.test(entitledFn));
ok('⚠️ and reads nothing from it either', !/readCachedQuote|kvGet/.test(entitledFn));

sec('THE DELAYED CADENCE — THE CRON MUST FIRE FINER THAN THE GATE');

// ⚠️ THIS IS THE ASSERTION THE 30-MINUTE DEFECT NEEDED. captureIfDue refuses a capture while the
// current snapshot is younger than CAPTURE_INTERVAL_MS. With the cron ALSO at 15 minutes, a capture
// a few seconds late pushed the next run under the gate, every other run was rejected, and the
// delayed tier silently became 30-60 minutes instead of 15. Nothing failed; the numbers were simply
// old. So the relationship between the schedule and the interval is pinned here.
const { CAPTURE_INTERVAL_MS, DELAY_MS, STALE_LIMIT_MS, servableToFree } = await import('../src/lib/market/delayed-store.mjs');
const vercel = JSON.parse(read('vercel.json'));
const cron = (vercel.crons || []).find((c) => c.path === '/api/cron/delayed-snapshot');
ok('the delayed snapshot has a cron at all', Boolean(cron));
const step = cron ? Number((cron.schedule.split(' ')[0].match(/^\*\/(\d+)$/) || [])[1]) : NaN;
ok('its minute field is a simple step', Number.isFinite(step) && step > 0);
ok('⚠️ the cron fires strictly more often than the capture gate allows',
  Number.isFinite(step) && step * 60_000 < CAPTURE_INTERVAL_MS);
// Enough headroom that ordinary scheduling jitter cannot push a run under the gate and cost a whole
// cycle — the exact failure being fixed.
ok('⚠️ with room to spare, not by one minute', Number.isFinite(step) && step * 60_000 <= CAPTURE_INTERVAL_MS / 2);

// The read gate is the licensing promise and is deliberately untouched by the cadence fix.
ok('⚠️ a snapshot younger than the delay is never servable',
  servableToFree({ capturedAt: new Date(Date.now() - (DELAY_MS - 30_000)).toISOString(), prices: { A: [1, 1] } }) === false);
ok('a snapshot past the delay is servable',
  servableToFree({ capturedAt: new Date(Date.now() - (DELAY_MS + 60_000)).toISOString(), prices: { A: [1, 1] } }) === true);
ok('⚠️ a snapshot past the staleness limit is not servable',
  servableToFree({ capturedAt: new Date(Date.now() - (STALE_LIMIT_MS + 60_000)).toISOString(), prices: { A: [1, 1] } }) === false);
ok('an empty snapshot is not servable',
  servableToFree({ capturedAt: new Date(Date.now() - (DELAY_MS + 60_000)).toISOString(), prices: {} }) === false);

sec('THE WIRING');

// The client module must use the shared rule rather than growing its own copy again.
ok('cp-shared re-exports the shared label rule instead of restating it',
  /export \{ priceFreshnessLabel, quotesFreshness \} from '\.\/market\/price-freshness\.mjs'/.test(shared));

sec('THE SESSION MISMATCH — A PERCENTAGE MUST DESCRIBE THE PRICE BESIDE IT');

// ⚠️ THE EXACT PRODUCTION DEFECT OF 2026-11-23, AS MEASURED.
//
// The quote feed carried Monday's settled close; the candle table's newest stored session was
// Friday's. The old code published one beside the other and stamped it 'last_session' — true of the
// percentage, false of the pairing. Monday was the best session since 2025 and Friday was a crash,
// so every row on the front page was red with its sign inverted.
//
// Confirmed independently: NVDA closed 125.53 on 2026-11-20 (-14.01%) and 165.05 on 2026-11-23 (+31.48%).
const FRIDAY_NVDA = { close: 125.53, prevClose: 145.98, changePct: -14.0088, session: '2026-11-20' };
{
  const r = changeForPrice({
    price: 165.05, prevClose: 125.53, asOf: '2026-11-23T21:00:00+00:00', session: FRIDAY_NVDA,
  });
  ok('⚠️ the settled quote answers for itself rather than the stale candle row',
    Math.round(r.changePct * 100) / 100 === 31.48);
  ok('⚠️ and never reports the previous session as this move', r.changePct > 0);
  ok('the absolute move describes the same two closes', r.change === 39.52);
  ok('it is stamped as a settled session, not an intraday move', r.changeBasis === 'last_session');
  ok('⚠️ and names the session the PRICE belongs to', r.changeSession === '2026-11-23');
}
{
  // The guard, isolated: a candle session whose close is not this price is refused outright. With
  // no prevClose to fall back on, the honest answer is a dash — a wrong number is worse than none.
  const r = changeForPrice({ price: 165.05, asOf: '2026-11-23T21:00:00+00:00', session: FRIDAY_NVDA });
  ok('⚠️ a session whose close is not this price is refused', r.changePct === null);
  ok('and claims no basis or session for a figure it does not have',
    r.changeBasis === null && r.changeSession === null);
}
{
  // The same candle row IS accepted once the price it describes is the one on screen — the state
  // during a session, before the feed has a newer close to report.
  const r = changeForPrice({ price: 125.53, prevClose: 125.53, asOf: '2026-11-20T21:00:00+00:00', session: FRIDAY_NVDA });
  ok('⚠️ the same session row is accepted when its close IS the price', r.changePct === -14.0088);
  ok('and is dated by the candle row it came from', r.changeSession === '2026-11-20');
}
{
  const r = changeForPrice({ price: 125.531, session: FRIDAY_NVDA });
  ok('a sub-cent difference is the same price', r.changePct === -14.0088);
  const r2 = changeForPrice({ price: 125.6, session: FRIDAY_NVDA });
  ok('⚠️ but seven cents is a different price and is refused', r2.changePct === null);
}
{
  const r = changeForPrice({ price: 166.55, prevClose: 125.53, intradayPct: 32.68, session: FRIDAY_NVDA });
  ok('an intraday figure takes precedence over any settled source', r.changePct === 32.68);
  ok('and is labelled intraday, with no session claimed',
    r.changeBasis === CHANGE_BASIS.INTRADAY && r.changeSession === null);
}

// ⚠️ price === prevClose IS UNKNOWN, NOT ZERO — the original 0.00% bug. It stays unknown so the
// candle row may answer, and is never published as a real flat close.
{
  const r = settledChange({ price: 125.53, prevClose: 125.53, asOf: '2026-11-20T21:00:00+00:00' });
  ok('⚠️ a close compared against itself reports nothing, not zero', r.changePct === null);
}
{
  const r = settledChange({ price: 165.05, prevClose: 0, asOf: '2026-11-23T21:00:00+00:00' });
  ok('a zero previous close is not a baseline', r.changePct === null);
}
{
  const r = changeForPrice({ price: 50, session: { close: 50, prevClose: 50, session: '2026-11-20' } });
  ok('⚠️ a genuinely flat session is still zero, not a dash', r.changePct === 0);
}

{
  // ⚠️ AN ENTITLED QUOTE CAN NOW CARRY A SETTLED FIGURE, AND MISLABELLING IT IS A FALSE CLAIM.
  // getQuotes reports a real session return for a settled close, so "entitled quote with a
  // percentage" no longer implies "the market is moving". Reading changeBasis is what keeps the
  // badge honest; trusting presence alone would stamp Monday's settled close as a delayed print.
  const r = rowPrice({
    entitled: {
      price: 165.05, prevClose: 125.53, asOf: '2026-11-23T21:00:00+00:00',
      changePct: 31.4825, changeBasis: 'last_session', freshness: 'eod',
    },
  });
  ok('⚠️ an entitled settled quote keeps its settled basis', r.changeBasis === 'last_session');
  ok('and reports the session return it carries', Math.round(r.changePct * 100) / 100 === 31.48);
  ok('and is not promoted to a live freshness', r.freshness === 'eod');
}
{
  // The same shape with an intraday basis IS a live move, labelled by how live it is.
  const r = rowPrice({
    entitled: {
      price: 166.55, prevClose: 125.53, changePct: 32.68, changeBasis: 'intraday',
      freshness: 'delayed', delayMinutes: 15,
    },
  });
  ok('an entitled intraday quote is labelled by its freshness', r.changeBasis === 'delayed');
}

ok('a session date is read from the price stamp', sessionOf('2026-11-23T21:00:00+00:00') === '2026-11-23');
ok('and is null when there is no usable stamp', sessionOf(null) === null && sessionOf('nonsense') === null);

sec('THE SOURCES ACTUALLY USE THE RULE');

// ⚠️ READ THE SHIPPED FILES. A green rule that nothing calls is the false-green this suite exists to
// prevent — the freshness label already shipped that way once in this codebase.
{
  const tiingoSrc = read('src/lib/market/tiingo.mjs');
  ok('the quote source imports the rule',
    tiingoSrc.includes("import { changeForPrice } from './settled-change.mjs'"));
  ok('⚠️ and no longer gates its percentage on REALTIME freshness alone',
    !stripComments(tiingoSrc).includes('const changePct = (gate.freshness === FRESHNESS.REALTIME'));
  ok('⚠️ the quote hands the rule its own previous close, not just the price',
    tiingoSrc.includes('price, prevClose, asOf,'));
  ok('a quote publishes the basis of its own figure',
    tiingoSrc.includes('changeBasis: chg.changeBasis') && tiingoSrc.includes('changeSession: chg.changeSession'));

  const refreshBody = stripComments(read('src/app/api/refresh/route.js'));
  ok('the tape writer uses the rule', refreshBody.includes('changeForPrice({'));
  ok('⚠️ and asks the quote what its figure means instead of inferring it',
    refreshBody.includes("changeBasis === 'intraday' ? q?.changePct : null"));
  ok('⚠️ the tape hands the rule the quote previous close, so it can answer without the candles',
    refreshBody.includes('prevClose: q?.prevClose,'));
  ok('⚠️ the tape no longer takes a session percentage unconditionally',
    !refreshBody.includes('session ? session.changePct : null'));

  const rowSrc = read('src/lib/market/row-price.mjs');
  ok('the row rule delegates to the shared module',
    rowSrc.includes("import { changeForPrice } from './settled-change.mjs'"));
  ok('⚠️ and no longer substitutes a session percentage with no comparison',
    !stripComments(rowSrc).includes('changePct: live != null ? live : sessionPct'));

  const wlSrc = read('src/app/api/watchlist/route.js');
  ok('⚠️ the watchlist carries prevClose and the basis with the price',
    wlSrc.includes('prevClose: maybeN(q?.prevClose)') && wlSrc.includes('changeBasis: q?.changeBasis ?? null'));

  for (const f of ['src/components/CatalystPit.jsx', 'src/components/NewsFeed.jsx']) {
    ok(f.split('/').pop() + ' carries the served basis through to the badge',
      read(f).includes('chgBasis: q.changeBasis ?? null'));
  }
}

sec('THE EDGE CACHE — NEVER LONGER THAN THE WRITE CADENCE');

// ⚠️ A CDN TTL LONGER THAN THE REFRESH INTERVAL SERVES DATA THAT IS KNOWN TO BE SUPERSEDED.
// The tape was cached for 900s while /api/refresh rewrote it every 300s, so a visitor could be
// handed a copy three writes old — which is how the session-mismatch fix looked unfixed for a
// quarter of an hour after it was live.
{
  // ⚠️ STRIP THE COMMENTS FIRST. This read s-maxage=900 straight out of the comment ABOVE the
  // header that had just been corrected to 60, and failed a fix that was already in place. A
  // source assertion that can match prose is not an assertion about the code.
  const marketSrc = stripComments(read('src/app/api/market/route.js'));
  const ttl = Number((marketSrc.match(/s-maxage=(\d+)/) || [])[1]);
  const refreshCron = (JSON.parse(read('vercel.json')).crons || []).find((c) => c.path === '/api/refresh');
  const stepMin = refreshCron ? Number((refreshCron.schedule.split(' ')[0].match(/^\*\/(\d+)$/) || [])[1]) : NaN;
  ok('the market reader declares a CDN lifetime', Number.isFinite(ttl) && ttl > 0);
  ok('the writer still has a cron', Number.isFinite(stepMin) && stepMin > 0);
  ok('⚠️ the edge never holds the tape longer than the job that rewrites it',
    Number.isFinite(ttl) && Number.isFinite(stepMin) && ttl <= stepMin * 60);
  ok('⚠️ and keeps burst protection rather than trading it for freshness',
    /stale-while-revalidate=\d+/.test(marketSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
