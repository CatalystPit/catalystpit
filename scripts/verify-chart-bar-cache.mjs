// THE CHART'S IN-SESSION BAR CACHE — bounded, and never stale.
//
// Two ways a cache like this goes wrong, and both are worse than the round trip it removes:
//
//   1. IT GROWS. A candle series is 320 intraday bars or 1,254 daily ones, per symbol, per
//      timeframe, per session mode. A Map that is never evicted is a memory leak in a tab someone
//      leaves open all day.
//   2. IT SERVES OLD PRICES. A 5-minute chart whose newest candle is still forming must not be
//      answered from a cache for longer than that candle takes to change.
//
// Run: node scripts/verify-chart-bar-cache.mjs

import { readFileSync } from 'node:fs';
import {
  barsKey, getBars, putBars, peek, clearBars, size, keys, MAX_ENTRIES, TTL_MS,
} from '../src/lib/chart/chart-bar-cache.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);

const bars = (n = 3) => Array.from({ length: n }, (_, i) => ({ time: i, open: 1, high: 2, low: 0, close: 1.5, volume: 10 }));
const INTRA = { kind: 'intraday' };
const DAILY = { kind: 'daily' };

L('A SERIES IS IDENTIFIED BY WHAT CHANGES ITS CONTENTS');
{
  ok('symbol, timeframe and session all take part',
    barsKey('AAPL', '5m', 'regular') !== barsKey('AAPL', '5m', 'extended')
    && barsKey('AAPL', '5m', 'regular') !== barsKey('AAPL', '1D', 'regular')
    && barsKey('AAPL', '5m', 'regular') !== barsKey('NVDA', '5m', 'regular'));
  ok('⚠️ the symbol is normalised, so aapl and AAPL are one series',
    barsKey('aapl', '5m', 'regular') === barsKey('AAPL', '5m', 'regular'));
  ok('an absent session is the regular one', barsKey('AAPL', '5m') === barsKey('AAPL', '5m', 'regular'));
}

L('⚠️ IT NEVER SERVES A SERIES OLDER THAN THE BAR IT DESCRIBES');
{
  clearBars();
  const k = barsKey('QQQ', '5m', 'regular');
  putBars(k, bars(), INTRA, { now: 0 });
  ok('a fresh intraday series is served', getBars(k, { now: 1_000 })?.bars.length === 3);
  ok('…and it reports how old it is', getBars(k, { now: 5_000 })?.ageMs === 5_000);
  ok('⚠️ past its TTL it is NOT served, however much faster that would be',
    getBars(k, { now: TTL_MS.intraday + 1 }) === null);
  ok('the intraday TTL is shorter than a 5-minute bar', TTL_MS.intraday < 5 * 60_000);

  clearBars();
  const d = barsKey('QQQ', '1D', 'regular');
  putBars(d, bars(), DAILY, { now: 0 });
  ok('a completed daily series may be held longer', getBars(d, { now: TTL_MS.intraday + 1 }) !== null);
  ok('…but not indefinitely', getBars(d, { now: TTL_MS.daily + 1 }) === null);
  ok('⚠️ the two TTLs are not the same number by accident', TTL_MS.daily > TTL_MS.intraday);

  ok('a key that was never stored is a miss', getBars(barsKey('NOPE', '5m'), { now: 0 }) === null);
  ok('⚠️ an expired entry is still DISTINGUISHABLE from nothing at all, for the caller that needs it',
    peek(d) !== null && getBars(d, { now: TTL_MS.daily + 1 }) === null);
}

L('⚠️ IT IS BOUNDED, AND EVICTS THE LEAST RECENTLY USED');
{
  clearBars();
  for (let i = 0; i < MAX_ENTRIES + 4; i++) putBars(barsKey(`S${i}`, '5m'), bars(), INTRA, { now: 0 });
  ok(`it holds at most ${MAX_ENTRIES} series`, size() === MAX_ENTRIES, String(size()));
  ok('⚠️ the oldest are the ones dropped', !keys().includes(barsKey('S0', '5m')));
  ok('…and the newest are kept', keys().includes(barsKey(`S${MAX_ENTRIES + 3}`, '5m')));
  ok('the bound is small enough to be a rotation, not a browsing history', MAX_ENTRIES <= 12);

  // ⚠️ READING A SERIES MAKES IT RECENT. Without this, the symbol a trader keeps coming back to is
  // evicted by the ones they glance at once — the exact opposite of what the cache is for.
  clearBars();
  for (let i = 0; i < MAX_ENTRIES; i++) putBars(barsKey(`T${i}`, '5m'), bars(), INTRA, { now: 0 });
  getBars(barsKey('T0', '5m'), { now: 1 });                       // touch the oldest
  putBars(barsKey('NEW', '5m'), bars(), INTRA, { now: 1 });        // force one eviction
  ok('⚠️ a series that was just read survives the next eviction', keys().includes(barsKey('T0', '5m')));
  ok('…and the one that was not is the one dropped', !keys().includes(barsKey('T1', '5m')));
}

L('IT REFUSES WHAT IT CANNOT USEFULLY HOLD');
{
  clearBars();
  putBars(barsKey('X', '5m'), [], INTRA, { now: 0 });
  ok('⚠️ an empty series is not cached — a miss is better than caching "nothing"', size() === 0);
  putBars(barsKey('X', '5m'), null, INTRA, { now: 0 });
  ok('nor is a non-array', size() === 0);
  putBars('', bars(), INTRA, { now: 0 });
  ok('nor is a series with no key', size() === 0);
}

L('⚠️ THE CHART USES IT WITHOUT TRUSTING IT');
{
  const chart = readFileSync(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  ok('the chart reads the cache before it fetches', /const cached = !incremental \? getBars\(cacheKey\) : null;/.test(chart));
  ok('…and stores what it fetched', /putBars\(cacheKey, bars, m\);/.test(chart));
  // ⚠️ THE CACHE REMOVES THE BLANK, NOT THE UPDATE. A hit must still be followed by the request, or
  // the chart would stop refreshing for as long as the entry lived.
  ok('⚠️ a cache hit does not skip the refresh',
    !/if \(cached\) \{[\s\S]{0,900}return;/.test(chart));
  ok('⚠️ a cache hit shows candles instead of the loading state',
    /setStatus\('ready'\);\s*\n\s*\} else if \(!incremental\) setStatus\('loading'\);/.test(chart));
  ok('an incremental refresh never reads the cache', /!incremental \? getBars/.test(chart));
  // The symbol race guard is what stops a slow answer for the previous symbol landing on this one.
  ok('the newer symbol still wins', /if \(forSym !== symRef\.current\) return;/.test(chart));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
