import 'server-only';

// PIT SCAN RUNTIME — where the provider-independent engine meets the server.
//
// ONE SHARED CALCULATION, NOT ONE PER USER. The scanner state lives here, in the server process, and
// every connected client reads the same result. The alternative — each browser subscribing to
// thousands of symbols and computing its own velocities — would burn vendor credits linearly with
// users, put the calculation on the weakest machine in the chain, and let two traders disagree about
// what the market just did. When ingestion moves behind a worker and Redis, this module is what
// changes; nothing above or below it does.
//
// WHAT RUNS TODAY: nothing. The interim feed is 15-minute delayed with no stream and no consolidated
// volume, so there is no ingestion wired in and `scanState()` reports `live: false` with the exact
// reason. Pit Scan renders that honestly rather than replaying fixtures — a scanner showing invented
// movement is the most damaging thing this product could ship.

import { TIINGO_EOD_CAPABILITIES, tiingoCapabilities } from '../market/tiingo.mjs';
import { INTERIM_PROVIDER, NO_PROVIDER, partitionSignals, signalAvailability, callerCapabilities } from './market-capabilities.mjs';
import { SIGNALS } from './signals.mjs';
import { createLifecycleStore } from './lifecycle.mjs';
import { createPulse } from './pulse.mjs';
import { presetsWithAvailability } from './presets.mjs';
import { availableColumns, DEFAULT_COLUMNS } from './columns.mjs';

/**
 * Which provider description is in force.
 *
 * Driven by configuration, so connecting the licensed feed is an environment change plus one
 * descriptor — not a change to any signal, filter, column or preset.
 */
export function activeCapabilities() {
  // Tiingo is the chosen V1 provider. Its descriptor is measured rather than assumed — see
  // market/tiingo.mjs — and on the current account it reports EOD quotes, no streaming and no
  // intraday volume, which is exactly why Pit Scan stays gated below.
  //
  // Activating the paid entitlement is an environment change plus that one descriptor. No signal,
  // filter, column, preset or board changes.
  // ⚠️ THE DESCRIPTOR NOW FOLLOWS THE ENTITLEMENT FLAG, WHICH IS THE CHANGE THIS FILE PROMISED.
  // "Activating the paid entitlement is an environment change plus that one descriptor" — this is
  // that one descriptor. tiingoCapabilities() returns the realtime shape only when
  // TIINGO_REALTIME_ENABLED is set, so Pit Scan's readiness flips by itself and no signal, filter,
  // column, preset or board is touched. Unsetting the variable returns every surface to EOD.
  //
  // The realtime descriptor still reports liveVolume/consolidatedVolume false, so the
  // volume-dependent signals stay dark exactly as they are today. Live prices arriving does not
  // make volume appear.
  if (process.env.TIINGO_API_KEY && String(process.env.TIINGO_ENABLED ?? 'true').toLowerCase() !== 'false') {
    return tiingoCapabilities();
  }
  // ⚠️ THERE IS NO SECOND PROVIDER TO FALL BACK TO, AND THERE USED TO BE. This read POLYGON_KEY and,
  // when it was present, described the scanner's capabilities as Polygon Stocks Starter — a provider
  // whose redistribution rights were never established. No market data flowed through this particular
  // function, but it is a provider SELECTION driven entirely by an environment variable, which is the
  // exact shape the licensing rule forbids: a key appearing in an environment must not be able to put an
  // unapproved provider back into the product, not even as a claim about what the product can do.
  //
  // Without the licensed feed there is no feed. NO_PROVIDER is what the UI already renders honestly as
  // "the scanner needs a market-data feed" rather than an empty table that reads as "nothing is moving".
  return NO_PROVIDER;
}

/**
 * Is there a feed good enough to run the scanner live?
 *
 * Deliberately strict: Pit Scan answers "what is moving RIGHT NOW", and a fifteen-minute-old answer
 * to that question is not a worse answer, it is a different and misleading one. The daily-level
 * signals would technically evaluate, but a table that updates once every fifteen minutes presented
 * as a live scanner would teach traders to trust something they should not.
 */
export function scanReadiness(caps = activeCapabilities()) {
  // ⚠️ VOLUME IS NOT A V1 REQUIREMENT, and this gate used to say it was.
  //
  // Pit Scan V1 is price structure plus public evidence. Volume was previously required here because
  // an earlier design put RVOL near the centre of the product; it no longer is, and keeping the gate
  // would hold the whole board hostage to a feed capability the product does not need. The
  // volume-dependent SIGNALS remain individually capability-gated and simply do not run — which is
  // the correct behaviour and already tested.
  //
  // What V1 genuinely needs is a current price: "what is moving right now" cannot be answered by
  // end-of-day data, and answering it with EOD would not be a worse answer but a misleading one.
  const needs = [];
  if (caps.quoteFreshness !== 'realtime' && caps.quoteFreshness !== 'near') needs.push('real-time prices');
  return {
    live: needs.length === 0,
    // ⚠️ THE VENDOR'S ID AND LABEL USED TO TRAVEL HERE TOO, and this object is returned inside
    // scanState — so /api/pitscan shipped "Tiingo (real-time consolidated)" and the plan id to every
    // Pro client. Nothing read either one: the panel uses `live` and `reason` only. Removed rather
    // than renamed, because the attribution the Tiingo agreement requires is satisfied on the legal
    // pages and naming the vendor on a scan payload is an implementation detail, not a disclosure.
    needs,
    // Reported separately so the panel can say what is merely ABSENT rather than blocking: these
    // turn signals off, they do not stop the product.
    degraded: [
      ...(caps.consolidatedVolume ? [] : ['consolidated volume — relative-volume signals are off']),
      ...(caps.intradayVolumeHistory ? [] : ['time-of-day volume baselines — RVOL is unavailable']),
      ...(caps.streaming ? [] : ['a streaming feed — prices update by polling']),
    ],
    reason: needs.length ? `Pit Scan goes live when the market-data provider supplies ${joinList(needs)}.` : null,
  };
}

function joinList(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// The shared, process-local state. A single Node instance today; a worker plus Redis when ingestion
// is real. Nothing above this file knows which.
const store = createLifecycleStore();
const pulse = createPulse();

/**
 * What the API returns.
 *
 * ALWAYS DESCRIBES ITSELF. Even with no feed, the response carries the full capability picture — the
 * signals that would run, the ones that would not and why, the presets and the columns — so the
 * panel can show a trader exactly what the product is and what it is waiting for, rather than an
 * empty table that reads as "nothing is happening".
 */
/**
 * @param {boolean} realtime whether THIS caller is entitled to real-time, resolved server-side by the
 *   route. Pit Scan is Pro-only, but Pro is not the same as real-time-entitled: a manually flagged
 *   beta tester is Pro-tier and is deliberately served delayed data by /api/quotes, so describing
 *   their feed as realtime here would contradict the prices they actually receive.
 */
export function scanState({ preset = null, realtime = false } = {}) {
  const caps = activeCapabilities();
  // ⚠️ READINESS AND SIGNAL PARTITIONING STILL USE THE REAL PROVIDER. What a caller is entitled to
  // receive changes how the feed is DESCRIBED, never which signals the engine can compute.
  const readiness = scanReadiness(caps);
  const { enabled, disabled } = partitionSignals(SIGNALS, caps);
  const served = callerCapabilities(caps, { realtime });

  return {
    readiness,
    capabilities: {
      // ⚠️ NEITHER THE PROVIDER ID NOR ITS LABEL LEAVES THE SERVER. The label was
      // "Tiingo (real-time consolidated)"; the contractual attribution lives on the legal pages in the
      // wording the agreement specifies, and naming the vendor — or our plan tier — on a scan payload
      // is an implementation detail rather than a disclosure anyone needs. `quoteFreshness` below is
      // what describes the data, and it is already capped to this caller's entitlement.
      streaming: served.streaming,
      quoteFreshness: served.quoteFreshness,
      consolidatedVolume: served.consolidatedVolume,
      liveVolume: served.liveVolume,
      extendedHours: served.extendedHours,
      bidAsk: served.bidAsk,
      historicalDaily: served.historicalDaily,
      intradayVolumeHistory: served.intradayVolumeHistory,
    },
    signals: {
      enabled: enabled.map((s) => ({ id: s.id, label: s.label, category: s.category })),
      disabled: disabled.map((s) => ({ id: s.id, label: s.label, category: s.category, reason: s.unavailable })),
    },
    presets: presetsWithAvailability(caps).map((p) => ({
      id: p.id, label: p.label, description: p.description, available: p.available, reason: p.reason,
    })),
    columns: {
      available: availableColumns(caps, signalAvailability).map((c) => ({ id: c.id, label: c.label })),
      default: DEFAULT_COLUMNS,
    },
    // No ingestion is wired, so there is nothing to show and we say so rather than showing nothing.
    rows: [],
    events: [],
    asOf: Date.now(),
    preset,
  };
}

/** Exposed for the eventual ingestion worker; unused until a feed exists. */
export const __internals = { store, pulse };
