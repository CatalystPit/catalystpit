// WHAT THE ACTIVE MARKET-DATA PROVIDER CAN ACTUALLY DO.
//
// Pit Scan is built against this description, never against a vendor's name. A signal declares what
// it NEEDS; a provider declares what it HAS; and `signalAvailability()` compares the two. Nothing
// else in the scanner asks "are we on Polygon?" — so when the licensed feed lands, Pit Scan gains
// capability by editing one descriptor, not by being rewritten.
//
// THIS IS THE HONESTY BOUNDARY. The commercial feed is still being chosen, and the interim one is
// 15-minute delayed with no stream and no consolidated volume. Describing that precisely is what
// lets the product say which signals are live, which run on settled data, and which are dark —
// instead of quietly presenting delayed prints as a real-time tape, which is the single worst thing
// a scanner can do to a trader.
//
// LATENCY IS A CAPABILITY, NOT A FOOTNOTE. "Delayed" does not mean "missing": a 20-day high computed
// from settled daily candles is a fact, and saying so is fine. A five-second price acceleration
// computed from 15-minute-old prints is a lie. Signals therefore declare the freshness they need and
// are switched off — visibly, with a reason — when it is not there.

/** How fresh an observation is, coarsely, because that is the granularity decisions are made at. */
export const FRESHNESS = {
  REALTIME: 'realtime',     // sub-second to a few seconds; a live tape
  NEAR: 'near',             // seconds to about a minute behind
  DELAYED: 'delayed',       // the classic 15-minute retail delay
  EOD: 'eod',               // settled end-of-day values only
};

// Ordered worst → best, so "is what we have at least what this needs" is one comparison.
const FRESHNESS_RANK = { eod: 0, delayed: 1, near: 2, realtime: 3 };

export const freshnessAtLeast = (have, need) =>
  (FRESHNESS_RANK[have] ?? -1) >= (FRESHNESS_RANK[need] ?? 99);

/**
 * The capability vocabulary — every key a provider may declare and a signal may require.
 *
 * Kept as data rather than as loose strings so a typo in a signal's requirements is caught by a test
 * instead of silently making that signal always-available, which is the failure that would quietly
 * reintroduce fabricated output.
 */
export const CAPABILITIES = {
  streaming: 'Pushed updates rather than polling',
  quoteFreshness: 'How current a price observation is',
  observationsPerMinute: 'How many times a symbol is observed per minute',
  minBarSeconds: 'Finest intraday bar the provider will serve',
  extendedHours: 'Pre-market and after-hours data',
  liveVolume: 'Volume that updates during the session',
  consolidatedVolume: 'Volume across all venues, not one exchange',
  bidAsk: 'Live bid, ask and therefore spread',
  trades: 'Individual prints rather than aggregates',
  historicalIntraday: 'Intraday bars for past sessions',
  historicalDaily: 'Daily bars, for multi-day and multi-week levels',
  intradayVolumeHistory: 'Past sessions minute by minute, for time-of-day volume baselines',
  marketCap: 'Shares outstanding and therefore capitalisation',
  float: 'Free float, distinct from shares outstanding',
  haltStatus: 'Trading-halt and resumption state',
  universeSize: 'How many symbols can be watched at once',
};

export const CAPABILITY_KEYS = Object.keys(CAPABILITIES);

/** Every capability a signal may require, for validating the registry against typos. */
export const REQUIREABLE = new Set(CAPABILITY_KEYS);

/**
 * A provider description. Every field is a claim we can defend about the feed we are actually on.
 *
 * `null`/`false`/`0` all mean "we do not have this" and are treated identically: a signal that needs
 * it is off. There is deliberately no "assume yes" default anywhere — an unknown capability is an
 * absent one, because the failure mode of guessing wrong is a fabricated signal.
 */
export function describeProvider(partial = {}) {
  const flag = (k) => partial[k] === true;
  const count = (k) => Number(partial[k]) || 0;
  return {
    id: partial.id || 'none',
    label: partial.label || 'No market-data provider',
    streaming: flag('streaming'),
    quoteFreshness: partial.quoteFreshness || null,
    observationsPerMinute: count('observationsPerMinute'),
    minBarSeconds: count('minBarSeconds'),
    extendedHours: flag('extendedHours'),
    liveVolume: flag('liveVolume'),
    consolidatedVolume: flag('consolidatedVolume'),
    bidAsk: flag('bidAsk'),
    trades: flag('trades'),
    historicalIntraday: flag('historicalIntraday'),
    historicalDaily: flag('historicalDaily'),
    intradayVolumeHistory: flag('intradayVolumeHistory'),
    marketCap: flag('marketCap'),
    float: flag('float'),
    haltStatus: flag('haltStatus'),
    universeSize: count('universeSize'),
  };
}

/**
 * THE PROVIDER WE ARE ON TODAY.
 *
 * Measured, not aspirational. Polygon's Stocks Starter plan: 15-minute delayed aggregates, no
 * websocket, single-venue volume, no quotes, minute bars and daily history. Everything Pit Scan
 * needs a live tape for is consequently dark, and the UI says so rather than showing an empty table
 * that reads as "nothing is moving".
 */
export const INTERIM_PROVIDER = describeProvider({
  id: 'polygon-starter',
  label: 'Polygon Stocks Starter (interim)',
  streaming: false,
  quoteFreshness: FRESHNESS.DELAYED,
  observationsPerMinute: 1,
  minBarSeconds: 60,
  extendedHours: true,
  liveVolume: false,
  // Single-venue aggregates. Presenting these as consolidated volume would misstate RVOL on every
  // symbol, which is why every volume signal is gated on this one flag.
  consolidatedVolume: false,
  bidAsk: false,
  trades: false,
  historicalIntraday: true,
  historicalDaily: true,
  // We hold daily candles, not past sessions minute by minute — so no time-of-day volume baseline.
  intradayVolumeHistory: false,
  marketCap: true,
  float: true,
  haltStatus: false,
  universeSize: 50,
});

/**
 * WHAT A REAL-TIME PROFESSIONAL FEED LOOKS LIKE.
 *
 * Not a provider we have. It exists so the test suite can prove that the dark signals genuinely come
 * alive against a capable feed — that they are switched off by capability and not by being broken —
 * and so the eventual integration has a target shape to satisfy.
 */
export const FULL_PROVIDER = describeProvider({
  id: 'reference-realtime',
  label: 'Reference real-time feed',
  streaming: true,
  quoteFreshness: FRESHNESS.REALTIME,
  observationsPerMinute: 60,
  minBarSeconds: 1,
  extendedHours: true,
  liveVolume: true,
  consolidatedVolume: true,
  bidAsk: true,
  trades: true,
  historicalIntraday: true,
  historicalDaily: true,
  intradayVolumeHistory: true,
  marketCap: true,
  float: true,
  haltStatus: true,
  universeSize: 10000,
});

/** Nothing configured at all — the state a fresh environment is in. */
export const NO_PROVIDER = describeProvider({});

const LABELS = {
  extendedHours: 'extended-hours data',
  liveVolume: 'live volume',
  consolidatedVolume: 'consolidated volume',
  bidAsk: 'live bid and ask',
  trades: 'trade prints',
  historicalIntraday: 'intraday history',
  historicalDaily: 'daily history',
  intradayVolumeHistory: 'time-of-day volume history',
  marketCap: 'market capitalisation',
  float: 'float data',
  haltStatus: 'halt status',
};

/**
 * What a signal's requirements are checked against.
 *
 * A requirement is only compared when the signal states it, so a signal that needs nothing special
 * is available wherever there is any data at all.
 */
export function signalAvailability(signal, caps) {
  const need = signal?.requires || {};
  const provider = caps || NO_PROVIDER;
  const missing = [];

  if (need.streaming && !provider.streaming) missing.push('a streaming feed');
  if (need.quoteFreshness && !freshnessAtLeast(provider.quoteFreshness, need.quoteFreshness)) {
    missing.push(`${need.quoteFreshness} prices`);
  }
  if (need.observationsPerMinute && provider.observationsPerMinute < need.observationsPerMinute) {
    missing.push(`${need.observationsPerMinute} observations a minute`);
  }
  // A FINER bar is a SMALLER number of seconds, so this comparison is inverted on purpose.
  if (need.minBarSeconds && (!provider.minBarSeconds || provider.minBarSeconds > need.minBarSeconds)) {
    missing.push(`${need.minBarSeconds}-second bars`);
  }
  for (const flag of Object.keys(LABELS)) {
    if (need[flag] && !provider[flag]) missing.push(LABELS[flag]);
  }

  return {
    available: missing.length === 0,
    missing,
    // A sentence a trader can read in the panel, not an error code.
    reason: missing.length ? `Needs ${joinList(missing)}` : null,
  };
}

function joinList(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Split a registry into what can run and what cannot, with a reason for each exclusion.
 *
 * The API returns both, so the panel can show the dark signals explicitly. A capability the product
 * does not have yet is a roadmap item the trader is allowed to see, not something to hide.
 */
export function partitionSignals(signals, caps) {
  const enabled = [];
  const disabled = [];
  for (const sig of signals) {
    const a = signalAvailability(sig, caps);
    if (a.available) enabled.push(sig);
    else disabled.push({ ...sig, unavailable: a.reason, missing: a.missing });
  }
  return { enabled, disabled };
}

/** Every requirement key used across a registry — so a test can catch a misspelled capability. */
export function requirementKeysUsed(signals) {
  const keys = new Set();
  for (const s of signals || []) for (const k of Object.keys(s.requires || {})) keys.add(k);
  return [...keys];
}
