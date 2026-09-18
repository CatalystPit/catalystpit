// THE SCANNER ENGINE.
//
// One calculation pass over the universe, producing two things from the same work:
//
//   ROWS    the current state of every symbol that has something true about it — what the table shows
//   EVENTS  the transitions that just happened — what Pit Pulse shows
//
// Both come out of one evaluation, which is the point. Pit Scan, Custom Scanner, Movers, alerts,
// watchlist intelligence and chart markers are all views over this output; none of them recomputes a
// velocity or a level. That is the "one infrastructure, seven products" rule made structural rather
// than aspirational.
//
// CAPABILITY IS CHECKED ONCE PER CYCLE, not per symbol: the provider does not change between symbols,
// so partitioning the registry four thousand times would be four thousand times the work for the
// same answer.
//
// Pure and synchronous. It is handed states and returns results; it never fetches, never writes, and
// takes its clock from the caller — which is what lets a whole market scenario be replayed in a test.

import { partitionSignals } from './market-capabilities.mjs';
import { SIGNALS } from './signals.mjs';
import { advance, TRANSITIONS } from './lifecycle.mjs';
import { deriveRow } from './derived.mjs';
import { usableBenchmarks } from './provider-contract.mjs';
import { SECTOR_ETF, CORE_BENCHMARKS } from './relative-strength.mjs';

/**
 * Evaluate one symbol.
 *
 * Signals are evaluated in registry order, and the ones that depend on their peers run last against
 * the states already decided — so a volume-confirmed breakout can only confirm a breakout this same
 * pass actually found.
 */
export function evaluateSymbol(state, { signals, ctx = {}, store, now }) {
  if (!state) return null;
  const states = [];
  const events = [];

  const independent = signals.filter((s) => !s.dependsOnPeers);
  const dependent = signals.filter((s) => s.dependsOnPeers);

  const run = (sig, extraCtx) => {
    let evaluation = null;
    try {
      evaluation = sig.evaluate(state, { ...ctx, ...extraCtx });
    } catch {
      // A throwing signal is a bug in that signal, not a reason to lose the symbol. It is treated as
      // undeterminable, which holds the previous lifecycle state rather than publishing a change.
      evaluation = null;
    }
    const record = store.get(state.symbol, sig.id, now);
    const { record: next, event } = advance(record, evaluation, { now, config: sig.lifecycle });
    store.set(next);

    if (evaluation && evaluation.active) {
      states.push({
        id: sig.id,
        label: sig.label,
        category: sig.category,
        weight: sig.weight ?? 1,
        active: true,
        direction: evaluation.direction ?? null,
        detail: evaluation.detail ?? null,
        values: evaluation.values ?? null,
        // SINCE WHEN. The difference between "broke out" and "broke out 14 seconds ago", which is
        // most of what a trader wants from a scanner.
        since: next.triggeredAt ?? next.firstSeenAt ?? now,
      });
    }
    if (event) events.push({ ...event, label: sig.label, category: sig.category });
  };

  for (const sig of independent) run(sig);
  for (const sig of dependent) run(sig, { activeStates: states });

  return { symbol: state.symbol, states, events };
}

/**
 * One full cycle over a universe.
 *
 * `symbolStates` is the normalized state for every symbol being watched. `benchmarks` and `baselines`
 * are looked up per symbol so relative strength and RVOL get the right references without every
 * signal reaching for a global.
 */
export function runCycle({
  symbolStates,
  capabilities,
  store,
  now = Date.now(),
  benchmarks = {},
  baselines = {},
  registry = SIGNALS,
  enrich = null,
}) {
  const { enabled, disabled } = partitionSignals(registry, capabilities);

  const rows = [];
  const events = [];

  for (const state of symbolStates || []) {
    if (!state) continue;
    // A stale benchmark is worse than no benchmark: if SPY stopped updating and the symbol did not,
    // every symbol on the board looks strong. Dropped rather than compared.
    const bench = usableBenchmarks(benchmarksFor(state, benchmarks), now);
    const baseline = baselines[state.symbol] || null;
    const result = evaluateSymbol(state, {
      signals: enabled,
      store,
      now,
      ctx: { benchmarks: bench, baseline },
    });
    if (!result) continue;
    events.push(...result.events);
    if (!result.states.length) continue;

    // THE DERIVED BLOCK. Everything the columns, filters and dropdowns read — velocity, acceleration,
    // RVOL, VWAP state, levels, volatility, relative strength — computed from calculations that
    // already existed and were, until now, reachable only from tests.
    const derivedValues = deriveRow(state, { capabilities, benchmarks: bench, baseline, now });

    rows.push({
      symbol: state.symbol,
      company: state.company,
      price: state.price,
      changePct: state.prevClose ? ((state.price - state.prevClose) / state.prevClose) * 100 : null,
      gapPct: state.gapPct,
      volume: state.volume,
      dollarVolume: state.dollarVolume,
      marketCap: state.marketCap,
      float: state.float,
      spreadPct: state.spreadPct,
      haltStatus: state.haltStatus,
      sector: state.sector,
      // Spread over the row so `row.velocity`, `row.rvol`, `row.rsSpy` and the rest are where the
      // registry says they are. Null inside means unknown; a key absent from FIELD_MAP means the
      // engine does not implement it, and those are different statements.
      ...derivedValues,
      // THE SIGNAL STACK. Not a score: the list of what is true, newest first, each able to explain
      // itself. This is the row a trader reads.
      signals: result.states.slice().sort((a, b) => b.since - a.since),
      // Ranking is transparent and stated: how many independent things are true, weighted by how
      // much each matters, with the most recent trigger breaking ties. Nothing hidden.
      rank: rankOf(result.states),
      newest: Math.max(...result.states.map((s) => s.since)),
      context: enrich ? enrich(state) : (state.context || null),
    });
  }

  rows.sort((a, b) => b.rank - a.rank || b.newest - a.newest);
  events.sort((a, b) => b.at - a.at);

  return {
    rows,
    events,
    asOf: now,
    enabledSignals: enabled.map((s) => s.id),
    disabledSignals: disabled.map((s) => ({ id: s.id, label: s.label, category: s.category, reason: s.unavailable })),
  };
}

/**
 * How high a symbol sits in the list, and why.
 *
 * DELIBERATELY NOT A MODEL. It is the sum of the weights of the things that are true — so a symbol
 * with a 52-week high break and volume confirmation outranks one with a single 1-minute velocity
 * tick, and a reader can reconstruct the number from the badges on the row. There is no fitted
 * coefficient anywhere, because a number nobody can explain is worse than no ordering at all.
 */
export function rankOf(states) {
  let total = 0;
  for (const s of states) total += s.weight ?? 1;
  return total;
}

/**
 * SPY and QQQ always; the symbol's sector ETF when we know its sector.
 *
 * THE DEAD PATH, FIXED. This read `state.sectorEtf`, which `buildSymbolState` never set — so sector
 * relative strength could not fire for any symbol, ever. The mapping already existed in
 * relative-strength.mjs, keyed by the sector names `screener_stocks` already stores, so the fix is to
 * USE the existing classification rather than invent a second one: no new lookup, no vendor data, no
 * guessed sector. A symbol whose sector we do not know keeps the two core benchmarks.
 */
function benchmarksFor(state, all) {
  const out = {};
  for (const sym of CORE_BENCHMARKS) if (all[sym]) out[sym] = all[sym];
  const etf = state.sectorEtf || (state.sector ? SECTOR_ETF[state.sector] : null);
  if (etf && all[etf]) out[etf] = all[etf];
  return out;
}

export { TRANSITIONS };
