// THE PROVIDER BOUNDARY — what a future adapter must hand over, and nothing about who it is.
//
// No vendor is chosen. This file contains no vendor name, no endpoint, no credential and no fetch.
// It is the CONTRACT: the shape an ingestion worker fills, so everything downstream of it is
// Catalyst Pit logic that a provider swap does not touch.
//
// Written now, before the choice, on purpose. The readiness audit found the architecture sound and
// the wiring absent — and the wiring is where vendor assumptions leak in if the boundary is only
// implied. Stating it makes the remaining work a checklist rather than a redesign.
//
// ⚠️ NOTHING HERE FETCHES. The functions validate and normalize what an adapter supplies; they do
// not go and get it. The ingestion worker is deliberately not built (see HANDOFF) because its
// transport — stream, poll, or batch — is a property of the provider we have not selected.

/**
 * VOLUME METHODOLOGY, and why it is two flags rather than one.
 *
 * The readiness audit's open product question. A single `consolidatedVolume` capability covered both
 * the realtime numerator and the historical baseline, and there are real feeds where those differ:
 * IEX-only realtime prints with consolidated daily history is a common shape. One flag cannot say
 * that, and either answer it can give is wrong — `true` divides a partial numerator by a consolidated
 * baseline (understating every symbol by the venue's market share), `false` darkens RVOL entirely
 * even though the two sides would agree if both were single-venue.
 *
 * So methodology is a STRING THAT TRAVELS WITH EACH NUMBER, and RVOL is computed only when the two
 * match. See rvolState() in derived.mjs — the comparison is refused, not scaled.
 */
export const VOLUME_METHODOLOGY = Object.freeze({
  CONSOLIDATED: 'consolidated',   // all venues, the tape
  SINGLE_VENUE: 'single-venue',   // one exchange's prints
  DELAYED: 'delayed',             // consolidated but not current
});

export const isKnownMethodology = (m) => Object.values(VOLUME_METHODOLOGY).includes(m);

/**
 * Whether a live number and a historical baseline may be divided by one another.
 *
 * EXACT MATCH ONLY, and unknown on either side is not a match. There is no scaling factor here by
 * design: "IEX is about 2.3% of the tape" is a market-structure estimate that changes by symbol, by
 * day and by session, and a scanner that silently applies one is inventing volume.
 */
export function methodologyCompatible(liveQuality, baselineMethodology) {
  if (!isKnownMethodology(liveQuality) || !isKnownMethodology(baselineMethodology)) return false;
  return liveQuality === baselineMethodology;
}

/**
 * THE HISTORICAL BASELINE INTERFACE.
 *
 * An adapter supplies time-of-day volume baselines through this shape and the engine asks nothing
 * about where they came from. `buildVolumeBaseline()` in volume-baseline.mjs already produces the
 * cumulative/interval curves; this wraps one with the provenance the RVOL rule needs.
 *
 * The ACTUAL ingestion of historical sessions is deliberately not built — it depends on what the
 * chosen provider can serve and at what granularity.
 */
export function baselineEntry({ symbol, baseline, methodology, sessions = null, asOf = null } = {}) {
  if (!symbol || !baseline) return null;
  return {
    symbol: String(symbol).toUpperCase(),
    ...baseline,
    // Provenance travels WITH the curve. A baseline whose methodology we do not know can never be
    // used, which is the safe default rather than an inconvenience.
    methodology: isKnownMethodology(methodology) ? methodology : null,
    sessions: sessions ?? baseline.sessions ?? null,
    asOf,
  };
}

/** A keyed map of baselines, as runCycle expects it. Entries without provenance are dropped. */
export function baselineIndex(entries) {
  const out = {};
  for (const e of entries || []) {
    const entry = e && e.symbol ? e : null;
    if (!entry || !entry.methodology) continue;
    out[String(entry.symbol).toUpperCase()] = entry;
  }
  return out;
}

/**
 * THE BENCHMARK INTERFACE.
 *
 * Relative strength needs benchmark STATE at the SAME CADENCE as the symbol — a 5-minute symbol move
 * compared against a benchmark sampled hourly is not relative strength, it is two different
 * questions subtracted. So benchmarks enter as ordinary normalized symbol states, built by the same
 * `buildSymbolState()` as everything else, and the engine treats them identically.
 *
 * SPY, QQQ and the sector ETFs are SYMBOLS TO SUBSCRIBE TO, not a special data type. That is the
 * whole interface: an adapter that can stream AAPL can stream XLK.
 */
export function benchmarkIndex(states) {
  const out = {};
  for (const s of states || []) {
    if (!s || !s.symbol) continue;
    out[String(s.symbol).toUpperCase()] = s;
  }
  return out;
}

/**
 * Whether a benchmark is fresh enough to compare against, given the symbol's own observation.
 *
 * A STALE BENCHMARK IS WORSE THAN NO BENCHMARK. If SPY stopped updating ten minutes ago and the
 * symbol did not, every symbol on the board looks strong — a market-wide false positive produced
 * entirely by a data gap. Beyond the tolerance the benchmark is dropped and relative strength is
 * null, which is the honest answer.
 */
export const BENCHMARK_STALENESS_MS = 90_000;

export function usableBenchmarks(benchmarks, now, { toleranceMs = BENCHMARK_STALENESS_MS } = {}) {
  const out = {};
  for (const [sym, state] of Object.entries(benchmarks || {})) {
    if (!state) continue;
    const at = Number.isFinite(state.now) ? state.now : null;
    if (at != null && Number.isFinite(now) && (now - at) > toleranceMs) continue;
    out[sym] = state;
  }
  return out;
}

/**
 * WHAT AN ADAPTER MUST SUPPLY. Declared as data so the readiness report can be generated from the
 * code rather than written by hand and drifting from it.
 *
 * Each entry names a normalized input and whether the downstream engine can proceed without it.
 */
export const ADAPTER_INPUTS = Object.freeze([
  { id: 'quotes', label: 'Last price per symbol', required: true, consumedBy: 'price, change, every level comparison' },
  { id: 'bars', label: 'Intraday OHLCV bars', required: true, consumedBy: 'velocity, VWAP, ranges, session extremes' },
  { id: 'bidAsk', label: 'Bid/ask', required: false, consumedBy: 'spread, liquidity filters' },
  { id: 'volume', label: 'Volume with a methodology tag', required: false, consumedBy: 'RVOL, volume acceleration, dollar volume' },
  { id: 'session', label: 'Session phase', required: false, consumedBy: 'premarket isolation, opening ranges' },
  { id: 'timestamps', label: 'Exchange timestamps in epoch ms', required: true, consumedBy: 'ordering, staleness, session assignment' },
  { id: 'baselines', label: 'Time-of-day volume history', required: false, consumedBy: 'RVOL' },
  { id: 'benchmarks', label: 'SPY / QQQ / sector ETF state', required: false, consumedBy: 'relative strength' },
  { id: 'halts', label: 'Halt state', required: false, consumedBy: 'halt column, halt signals' },
]);
