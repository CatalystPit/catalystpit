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

import { INTERIM_PROVIDER, NO_PROVIDER, partitionSignals, signalAvailability } from './market-capabilities.mjs';
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
  const hasPolygon = !!(process.env.POLYGON_KEY || process.env.POLYGON_API_KEY);
  if (!hasPolygon) return NO_PROVIDER;
  return INTERIM_PROVIDER;
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
  const needs = [];
  if (!caps.streaming) needs.push('a streaming feed');
  if (caps.quoteFreshness !== 'realtime' && caps.quoteFreshness !== 'near') needs.push('real-time prices');
  if (!caps.consolidatedVolume) needs.push('consolidated volume');
  if (!caps.intradayVolumeHistory) needs.push('time-of-day volume baselines');
  return {
    live: needs.length === 0,
    provider: caps.id,
    providerLabel: caps.label,
    needs,
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
export function scanState({ preset = null } = {}) {
  const caps = activeCapabilities();
  const readiness = scanReadiness(caps);
  const { enabled, disabled } = partitionSignals(SIGNALS, caps);

  return {
    readiness,
    capabilities: {
      provider: caps.id,
      label: caps.label,
      streaming: caps.streaming,
      quoteFreshness: caps.quoteFreshness,
      consolidatedVolume: caps.consolidatedVolume,
      liveVolume: caps.liveVolume,
      extendedHours: caps.extendedHours,
      bidAsk: caps.bidAsk,
      historicalDaily: caps.historicalDaily,
      intradayVolumeHistory: caps.intradayVolumeHistory,
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
