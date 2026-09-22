// THE COMMERCIAL ENTITLEMENT, TESTED AS BEHAVIOUR — including against the live API.
//
//   node --env-file=.env.local scripts/verify-tiingo-realtime.mjs [--live]
//
// The pure assertions run everywhere. `--live` additionally calls Tiingo and checks that what
// arrives matches what this code believes about it — because the two failures that mattered most
// in this integration were both "the payload changed meaning and nothing noticed":
//
//   · lastSaleTimestamp stayed null after entitlement, so liveness detection broke silently
//   · /iex volume became venue volume while still labelled consolidated
//
// Neither is visible to a unit test with a fixture, because a fixture encodes the belief being
// tested. So the live half compares against the SAME day's consolidated EOD bar and against the
// wall clock.

import {
  resolveQuoteEntitlement, isFreshQuote, QUOTE_FRESH_WINDOW_MS,
  TIINGO_VOLUME, volumeLabel,
  TIINGO_EOD_CAPABILITIES, TIINGO_REALTIME_CAPABILITIES,
} from '../src/lib/market/tiingo.mjs';
import { FRESHNESS } from '../src/lib/scan/market-capabilities.mjs';

const LIVE = process.argv.includes('--live');
const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

L('=== FREE NEVER RECEIVES A REALTIME VALUE ===');
{
  // The gate's whole job: the vendor cannot promote a quote, only our entitlement can.
  const freeOnLiveFeed = resolveQuoteEntitlement({ entitled: false, vendorIsLive: true });
  ok('an unentitled reader on a LIVE feed is served EOD',
    mut('freeleak') ? false : freeOnLiveFeed.freshness === FRESHNESS.EOD);
  ok('…and is not given the live price at all',
    mut('freeleak') ? false : freeOnLiveFeed.useLivePrice === false,
    'useLivePrice must be false so the caller falls back to prevClose');

  const proOnLiveFeed = resolveQuoteEntitlement({ entitled: true, vendorIsLive: true });
  ok('an entitled reader on a live feed gets REALTIME', proOnLiveFeed.freshness === FRESHNESS.REALTIME);
  ok('…and receives the live price', proOnLiveFeed.useLivePrice === true);

  // ⚠️ THE ROLLBACK PATH. Unsetting the flag makes `entitled` false for everyone.
  const proWithFlagOff = resolveQuoteEntitlement({ entitled: false, vendorIsLive: true });
  ok('with the entitlement flag off, even Pro falls back to EOD',
    mut('noRollback') ? false : proWithFlagOff.freshness === FRESHNESS.EOD && proWithFlagOff.useLivePrice === false);

  // A dead feed cannot be promoted by entitlement either.
  const proOnDeadFeed = resolveQuoteEntitlement({ entitled: true, vendorIsLive: false });
  ok('entitlement alone does not invent liveness', proOnDeadFeed.freshness === FRESHNESS.EOD);
  ok('…but the settled close is still served', proOnDeadFeed.useLivePrice === true);
}

L('\n=== LIVENESS COMES FROM THE TIMESTAMP, NOT FROM lastSaleTimestamp ===');
{
  const now = Date.parse('2026-09-22T14:10:00.000Z');
  ok('a quote stamped now is fresh',
    mut('stalelive') ? false : isFreshQuote('2026-09-22T14:09:58.000Z', { now }));
  ok('last session’s close is not fresh',
    mut('stalelive') ? false : !isFreshQuote('2026-09-21T20:00:00.000Z', { now }));
  ok('a missing timestamp is not fresh', !isFreshQuote(null, { now }));
  ok('an unparseable timestamp is not fresh', !isFreshQuote('not-a-date', { now }));
  ok('a wildly future timestamp is not fresh (clock problem, not a quote)',
    !isFreshQuote('2026-09-22T20:00:00.000Z', { now }));
  ok('small negative skew is tolerated',
    isFreshQuote(new Date(now + 30_000).toISOString(), { now }));
  ok('the window is minutes, not seconds — no flicker on jitter', QUOTE_FRESH_WINDOW_MS >= 60_000);
}

L('\n=== VOLUME IS NEVER CALLED THE TAPE UNLESS IT IS ===');
{
  ok('the daily bar keeps the consolidated methodology',
    TIINGO_VOLUME.COMPOSITE_EOD !== TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED);
  // ⚠️ THE FIRST VERSION OF THIS ASSERTION MATCHED THE DENIAL AS IF IT WERE A CLAIM. It searched
  // for "consolidated tape" to prove the label did NOT claim consolidation — but the correct
  // label reads "not the consolidated tape", so the honest string failed the test for honesty.
  // The question is whether the sentence ASSERTS consolidation, so strip the negation first.
  {
    const label = volumeLabel(TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED);
    const withoutDenial = label.replace(/not the consolidated tape/gi, '');
    ok('single-venue volume does not claim to be consolidated',
      mut('fakevolume') ? false
        : !/consolidated|composite/i.test(withoutDenial) && /not the consolidated tape/i.test(label),
      label);
  }
  ok('…and no longer claims a 15-minute delay nobody measured',
    !/15-minute/.test(volumeLabel(TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED)));
}

L('\n=== RVOL CANNOT SWITCH ON BEHIND OUR BACK ===');
{
  // ⚠️ THE NON-NEGOTIABLE ONE. The realtime descriptor exists to let PRICES go live. If it ever
  // reports volume capability, every volume-gated signal — RVOL among them — silently becomes
  // available, computed from 0.3% of the market.
  for (const [name, caps] of [['EOD', TIINGO_EOD_CAPABILITIES], ['REALTIME', TIINGO_REALTIME_CAPABILITIES]]) {
    ok(`${name}: consolidatedVolume is false`,
      mut('rvolon') ? false : caps.consolidatedVolume === false);
    ok(`${name}: liveVolume is false`, mut('rvolon') ? false : caps.liveVolume === false);
    ok(`${name}: intradayVolumeHistory is false`, caps.intradayVolumeHistory === false);
  }
  ok('the realtime descriptor DOES promote quote freshness',
    TIINGO_REALTIME_CAPABILITIES.quoteFreshness === FRESHNESS.REALTIME);
  ok('…and streaming', TIINGO_REALTIME_CAPABILITIES.streaming === true);
  ok('…and records the top-of-book that was actually measured',
    TIINGO_REALTIME_CAPABILITIES.bidAsk === true);
  ok('the EOD descriptor is unchanged by any of this',
    TIINGO_EOD_CAPABILITIES.quoteFreshness === FRESHNESS.EOD && TIINGO_EOD_CAPABILITIES.streaming === false);
}

L('\n=== FREE AND PRO CANNOT SHARE A CACHE OBJECT ===');
{
  const fs = await import('node:fs/promises');
  const route = await fs.readFile(new URL('../src/app/api/quotes/route.js', import.meta.url), 'utf8');
  const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // The key carries the tier, so one tier's payload cannot be handed to the other.
  const keyLine = /const key = `\$\{realtime \? 'rt' : 'eod'\}:/.test(code);
  ok('the cache key is namespaced by entitlement', mut('sharedkey') ? false : keyLine);

  // ⚠️ AND REALTIME IS NEVER WRITTEN TO A SHARED CACHE AT ALL. Namespacing alone would still
  // leave one entitled user's licensed quote sitting in a store another request could read.
  // ⚠️ THE BRANCH ITSELF, NOT "EVERYTHING BEFORE THE NEXT LANDMARK". This used to slice up to
  // `const cached`, which silently grew to include the whole Free path the moment a delayed tier
  // was added between them — and then failed because the FREE fallback legitimately writes an EOD
  // quote to the shared cache. The boundary being protected is that the ENTITLED branch never
  // does, so the slice now ends where that branch returns.
  const rtStart = code.indexOf('if (realtime) {');
  const rtBranch = code.slice(rtStart, code.indexOf('\n    }', rtStart));
  ok('the realtime branch never writes to the shared cache',
    mut('cacherealtime') ? false : !/quotesCacheSet/.test(rtBranch), rtBranch.trim().slice(0, 90));
  ok('…and never reads from it', !/quotesCacheGet/.test(rtBranch));
  ok('only the delayed tier is stored', /quotesCacheSet\(key/.test(code.slice(code.indexOf('const cached'))));

  // Entitlement is decided on the server from the session, never from the request.
  ok('entitlement comes from auth(), not from a query parameter',
    /const \{ userId \} = await auth\(\)/.test(code) && /resolveUserAccess\(\)/.test(code));
  ok('…and a signed-out reader defaults to delayed',
    /realtime = isRealtime\(tier\)/.test(code) && /catch \{/.test(route));
  ok('no quote response is ever publicly cacheable',
    (code.match(/'private, no-store'/g) || []).length >= 3);
}

if (LIVE) {
  L('\n=== AGAINST THE LIVE API ===');
  const KEY = process.env.TIINGO_API_KEY;
  if (!KEY) { ok('TIINGO_API_KEY present for --live', false); }
  else {
    const H = { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` };
    const syms = ['AAPL', 'NVDA', 'SPY', 'AMD'];
    const r = await fetch(`https://api.tiingo.com/iex/?tickers=${syms.join(',')}`, { headers: H });
    const rows = r.ok ? await r.json() : [];
    ok('the quote endpoint answers', Array.isArray(rows) && rows.length > 0);

    // The bug that started this: liveness must not be read from a field Tiingo leaves null.
    const anyLastSale = rows.some((q) => q.lastSaleTimestamp);
    L(`     (lastSaleTimestamp populated on any row: ${anyLastSale})`);
    ok('liveness detection does not depend on lastSaleTimestamp',
      rows.every((q) => isFreshQuote(q.timestamp) === true) || !rows.length,
      'timestamp must be the signal');

    // Volume: compare against the same day's consolidated bar rather than trusting a label.
    for (const q of rows.slice(0, 2)) {
      const sym = String(q.ticker).toUpperCase();
      const e = await fetch(`https://api.tiingo.com/tiingo/daily/${sym}/prices?startDate=2026-09-18`, { headers: H });
      const bars = e.ok ? await e.json() : [];
      const daily = Array.isArray(bars) && bars.length ? Number(bars[bars.length - 1].volume) : null;
      const share = daily ? (Number(q.volume) / daily) * 100 : null;
      ok(`${sym}: /iex volume is a small fraction of the tape, so it is NOT consolidated`,
        share != null && share < 5, `${Number(q.volume).toLocaleString()} = ${share?.toFixed(2)}% of ${daily?.toLocaleString()}`);
    }
  }
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
