// VERIFY THE CANONICAL CANDLE CONTRACT.
//
// The defect this guards against was not exotic: a writer stored `adjClose` instead of deriving a
// split-adjusted close, and nothing noticed for months because both are plausible numbers of the
// same magnitude. So every assertion below is written to fail on THAT mistake specifically, and
// --mutate proves each one is load-bearing rather than decorative.
//
// Run: node --env-file=.env.local scripts/verify-candle-contract.mjs [--mutate=<mode>]

import {
  tiingoDailyToCanonical, assertCanonicalCandles, assertWindowEndsAtPresent,
  CANDLE_SOURCE, CANDLE_CONVENTION, CandleContractViolation,
} from '../src/lib/market/candles.mjs';
import { CONVENTION } from '../src/lib/price-semantics.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; L(`  ok   ${name}`); } else { fail++; L(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// ── fixture: a dividend payer with a 2:1 split ───────────────────────────────
// Raw prices rise 100 -> 110, then split 2:1 (so raw halves to ~55), then rise to 60.
// adjClose is ALSO scaled down by the dividends paid after each bar — which is exactly the value
// the broken writers stored. Both series are present so a test can tell them apart.
const TODAY = '2026-01-20';
const fixture = [
  { date: '2026-01-05', open: 100, high: 101, low: 99, close: 100, volume: 1000, splitFactor: 1, divCash: 0, adjClose: 49.0 },
  { date: '2026-01-06', open: 100, high: 106, low: 100, close: 105, volume: 1100, splitFactor: 1, divCash: 0, adjClose: 51.45 },
  { date: '2026-01-07', open: 105, high: 111, low: 104, close: 110, volume: 1200, splitFactor: 1, divCash: 1.0, adjClose: 53.9 },
  // split bar: raw price halves, share count doubles
  { date: '2026-01-08', open: 55, high: 56, low: 54, close: 55.5, volume: 2400, splitFactor: 2, divCash: 0, adjClose: 54.39 },
  { date: '2026-01-09', open: 55.5, high: 58, low: 55, close: 57, volume: 2500, splitFactor: 1, divCash: 0, adjClose: 55.86 },
  { date: TODAY, open: 57, high: 61, low: 57, close: 60, volume: 2600, splitFactor: 1, divCash: 0, adjClose: 60 },
];

L('=== CONVENTION ===');
ok('canonical convention is SPLIT_ADJUSTED', CANDLE_CONVENTION === CONVENTION.SPLIT_ADJUSTED, String(CANDLE_CONVENTION));
ok("canonical Tiingo source is 'tiingo_split_adj'", CANDLE_SOURCE.TIINGO === 'tiingo_split_adj', CANDLE_SOURCE.TIINGO);

L('\n=== THE DEFECT: total return must never be produced ===');
{
  let out = tiingoDailyToCanonical(fixture, { ticker: 'TEST', today: TODAY });
  if (mut('adjclose')) {
    // The exact original bug: store the vendor's adj* field instead of deriving.
    out = fixture.map((d) => ({ ticker: 'TEST', date: d.date, open: d.adjClose, high: d.adjClose,
      low: d.adjClose, close: d.adjClose, volume: d.volume, source: CANDLE_SOURCE.TIINGO }));
  }
  const byDate = new Map(out.map((r) => [r.date, r]));
  // Pre-split raw close 110 must become 55 (one 2:1 split after it). adjClose there is 53.9.
  const pre = byDate.get('2026-01-07');
  ok('pre-split close is split-adjusted (110 -> 55), not adjClose (53.9)',
    Math.abs(pre.close - 55) < 1e-9, `got ${pre?.close}`);
  ok('output differs from the vendor adjClose series on a dividend payer',
    Math.abs(pre.close - 53.9) > 0.5, `got ${pre?.close}`);
  // Volume must scale WITH the split: 1200 raw shares pre-split = 2400 post-split shares.
  ok('volume is scaled by the split factor (1200 -> 2400)',
    Math.abs(pre.volume - 2400) < 1e-9, `got ${pre?.volume}`);
  // The most recent bar is never adjusted — it is today's tape.
  const last = byDate.get(TODAY);
  ok('the newest bar is unchanged (equals raw close 60)', Math.abs(last.close - 60) < 1e-9, `got ${last?.close}`);
  // And no cliff across the split.
  const a = byDate.get('2026-01-07').close, b = byDate.get('2026-01-08').close;
  ok('the 2:1 split leaves no cliff in the adjusted series',
    Math.abs((b - a) / a) < 0.05, `${((b - a) / a * 100).toFixed(1)}%`);
  ok('every row carries the canonical source', out.every((r) => r.source === CANDLE_SOURCE.TIINGO));
}

L('\n=== THE GUARD ===');
{
  const good = tiingoDailyToCanonical(fixture, { ticker: 'TEST', today: TODAY });
  ok('canonical rows pass the guard', threw(() => assertCanonicalCandles(good, { ticker: 'TEST' })) === null);

  const retired = good.map((r) => ({ ...r, source: mut('retired') ? CANDLE_SOURCE.TIINGO : 'tiingo' }));
  const e1 = threw(() => assertCanonicalCandles(retired));
  ok("the guard rejects the retired 'tiingo' (total-return) source",
    e1 instanceof CandleContractViolation, e1 ? e1.message : 'did not throw');

  const unknown = good.map((r) => ({ ...r, source: mut('unknown') ? CANDLE_SOURCE.TIINGO : 'mystery' }));
  ok('the guard rejects an unknown source',
    threw(() => assertCanonicalCandles(unknown)) instanceof CandleContractViolation);

  const badOhlc = good.map((r, i) => (i === 2 && !mut('ohlc') ? { ...r, low: r.high + 5 } : r));
  ok('the guard rejects impossible OHLC (low above high)',
    threw(() => assertCanonicalCandles(badOhlc)) instanceof CandleContractViolation);

  const negative = good.map((r, i) => (i === 1 && !mut('negative') ? { ...r, close: -1 } : r));
  ok('the guard rejects a non-positive price',
    threw(() => assertCanonicalCandles(negative)) instanceof CandleContractViolation);

  const badVol = good.map((r, i) => (i === 1 && !mut('volume') ? { ...r, volume: -5 } : r));
  ok('the guard rejects negative volume',
    threw(() => assertCanonicalCandles(badVol)) instanceof CandleContractViolation);

  const mismatched = good.map((r) => ({ ...r, ticker: mut('ticker') ? 'TEST' : 'OTHER' }));
  ok('the guard rejects a row whose ticker does not match the batch',
    threw(() => assertCanonicalCandles(mismatched, { ticker: 'TEST' })) instanceof CandleContractViolation);
}

L('\n=== THE WINDOW RULE ===');
{
  // splitAdjustSeries accumulates backwards, so adjusting a window that stops in the past produces
  // prices missing every split since. That must be refused, not silently written.
  const stale = threw(() => assertWindowEndsAtPresent(mut('window') ? TODAY : '2025-01-05', TODAY));
  ok('a window ending in the past is refused', stale instanceof CandleContractViolation);
  ok('a window ending today is accepted', threw(() => assertWindowEndsAtPresent(TODAY, TODAY)) === null);
  ok('a weekend trailing gap is tolerated', threw(() => assertWindowEndsAtPresent('2026-01-17', '2026-01-20')) === null);
  // The conversion must enforce it, not just expose it.
  ok('tiingoDailyToCanonical enforces the window rule',
    threw(() => tiingoDailyToCanonical(fixture, { ticker: 'TEST', today: '2027-06-01' })) instanceof CandleContractViolation);
}

L('\n=== DEGRADATION ===');
{
  ok('an empty payload yields no rows rather than throwing',
    tiingoDailyToCanonical([], { ticker: 'TEST' }).length === 0);
  ok('a malformed payload yields no rows rather than throwing',
    tiingoDailyToCanonical([{ date: null, close: 'x' }], { ticker: 'TEST' }).length === 0);
  ok('a missing ticker throws', threw(() => tiingoDailyToCanonical(fixture, {})) instanceof CandleContractViolation);
  // A bar with no splitFactor must be treated as "no split", never as a re-basing.
  const noSf = tiingoDailyToCanonical(
    [{ date: '2026-01-19', open: 10, high: 11, low: 9, close: 10, volume: 5 },
      { date: TODAY, open: 10, high: 11, low: 9, close: 10.5, volume: 5 }], { ticker: 'TEST', today: TODAY });
  ok('a missing splitFactor is treated as no split', Math.abs(noSf[0].close - 10) < 1e-9, `got ${noSf[0]?.close}`);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
