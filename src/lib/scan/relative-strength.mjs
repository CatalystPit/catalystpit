// RELATIVE STRENGTH.
//
// "Up 2%" is not interesting when the whole market is up 2%. What a trader is looking for is a
// symbol moving differently from everything else — and on a red day, a stock that is merely flat is
// the strongest thing on the screen.
//
// Measured over the SAME WINDOW for symbol and benchmark, from the same clock. Comparing a 5-minute
// move against a full-day benchmark move is the usual way this is got wrong, and it makes every
// symbol look strong in the morning.
//
// Pure. The caller supplies benchmark states; this module never fetches anything and never decides
// which benchmark is right for a symbol — that is the caller's business, because it depends on
// sector data we may or may not hold.

import { velocity } from './velocity.mjs';

/** The market-wide benchmarks. A sector ETF is added per symbol when we know its sector. */
export const CORE_BENCHMARKS = ['SPY', 'QQQ'];

/**
 * Sector → its liquid proxy ETF.
 *
 * These are the standard SPDR sector funds, matched to the sector names screener_stocks already
 * stores, so a symbol's benchmark comes from data we have rather than from a lookup we would have to
 * buy. A sector we cannot map simply has no sector benchmark, and the core two still apply.
 */
export const SECTOR_ETF = {
  'Technology': 'XLK',
  'Financial Services': 'XLF',
  'Healthcare': 'XLV',
  'Consumer Cyclical': 'XLY',
  'Consumer Defensive': 'XLP',
  'Energy': 'XLE',
  'Industrials': 'XLI',
  'Basic Materials': 'XLB',
  'Real Estate': 'XLRE',
  'Utilities': 'XLU',
  'Communication Services': 'XLC',
};

/** Which benchmarks apply to a symbol: the market always, its sector when we know it. */
export function benchmarksFor(sector) {
  const etf = sector ? SECTOR_ETF[sector] : null;
  return etf ? [...CORE_BENCHMARKS, etf] : [...CORE_BENCHMARKS];
}

/**
 * How far a symbol's move diverges from its benchmarks over one window.
 *
 * Returns the STRONGEST divergence — the benchmark it is furthest from — because that is the claim
 * worth making. Outperforming QQQ by 0.1% and SPY by 2% is a story about SPY.
 *
 * Null when the benchmark data is missing or does not cover the window: a benchmark we could not
 * measure is not a benchmark of zero, and treating it as one would make every symbol look strong.
 */
export function relativeStrength(state, benchmarkStates, { window = '5m', now } = {}) {
  if (!state || !benchmarkStates) return null;
  const at = now ?? state.now;
  const own = velocity(state.bars, window, at);
  if (!own || own.pct == null) return null;

  let best = null;
  for (const [symbol, bench] of Object.entries(benchmarkStates)) {
    if (!bench) continue;
    const bv = velocity(bench.bars, window, at);
    if (!bv || bv.pct == null) continue;
    const spread = own.pct - bv.pct;
    if (!best || Math.abs(spread) > Math.abs(best.spread)) {
      best = { benchmark: symbol, spread, symbolPct: own.pct, benchmarkPct: bv.pct, window };
    }
  }
  return best;
}

/**
 * Divergence across every benchmark, for display rather than for firing.
 *
 * The signal fires on the strongest; the panel can show the full picture when a symbol is expanded.
 */
export function relativeStrengthProfile(state, benchmarkStates, { window = '5m', now } = {}) {
  const at = now ?? state?.now;
  const own = state ? velocity(state.bars, window, at) : null;
  if (!own || own.pct == null) return [];
  const out = [];
  for (const [symbol, bench] of Object.entries(benchmarkStates || {})) {
    const bv = bench ? velocity(bench.bars, window, at) : null;
    if (!bv || bv.pct == null) continue;
    out.push({ benchmark: symbol, spread: own.pct - bv.pct, benchmarkPct: bv.pct, symbolPct: own.pct, window });
  }
  out.sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread));
  return out;
}
