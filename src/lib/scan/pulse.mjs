// PIT PULSE — the live event tape.
//
//   10:31:42  ASTS  PM HIGH BREAK
//   10:31:18  AMD   5M ACCELERATION
//   10:30:54  XYZ   NEW SESSION HIGH
//
// The engine decides what happened; this decides what is worth showing and keeps a bounded, ordered
// window of it. Every event here came from a lifecycle TRANSITION, so the tape cannot repeat itself
// while a condition merely stays true — that guarantee lives in lifecycle.mjs and this module relies
// on it rather than re-implementing it.
//
// A RING BUFFER, NOT A LOG. A tape that grows all session is a memory leak with a scrollbar. It holds
// a fixed number of the most recent events and drops the oldest, because nobody scrolls a live tape
// back two hours — that is what event history and the research harness are for.
//
// Pure, and shared: one server-side tape serves every connected client. No user's browser computes
// an event.

import { CATEGORIES } from './signals.mjs';
import { TRANSITIONS } from './lifecycle.mjs';

export const MAX_EVENTS = 500;

/**
 * The filters the tape offers.
 *
 * The first is everything; the rest map onto signal categories, plus the enrichment categories that
 * come from Catalyst Pit's own intelligence rather than from price. Those last three are declared
 * here and fed by the enrichment layer, so the tape has one vocabulary whatever the source.
 */
export const PULSE_FILTERS = [
  { id: 'all', label: 'All' },
  ...Object.entries(CATEGORIES).map(([id, label]) => ({ id, label })),
  { id: 'news', label: 'News' },
  { id: 'insider', label: 'Insider' },
  { id: 'congress', label: 'Congress' },
];

export const PULSE_FILTER_IDS = PULSE_FILTERS.map((f) => f.id);

/**
 * A bounded, newest-first tape.
 *
 * `seen` suppresses exact duplicates — the same transition arriving twice because two cycles
 * overlapped, which is a real possibility once ingestion is distributed and is precisely the thing
 * that would make the tape stutter.
 */
export function createPulse({ max = MAX_EVENTS } = {}) {
  let events = [];
  const seen = new Set();

  return {
    /** Add events, newest last. Returns how many were actually accepted. */
    push(incoming) {
      let added = 0;
      for (const e of incoming || []) {
        if (!e || !e.id || seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
        added += 1;
      }
      if (!added) return 0;
      events.sort((a, b) => b.at - a.at);
      if (events.length > max) {
        for (const dropped of events.slice(max)) seen.delete(dropped.id);
        events = events.slice(0, max);
      }
      return added;
    },

    /**
     * The tape, newest first.
     *
     * DEACTIVATIONS ARE NOT SHOWN BY DEFAULT. "No longer above its pre-market high" is true of
     * hundreds of symbols a day and is not news; the tape is for things that STARTED happening, plus
     * failures, which are.
     */
    list({ category = 'all', symbol = null, limit = 100, includeEndings = false } = {}) {
      let out = events;
      if (!includeEndings) {
        out = out.filter((e) => e.transition === TRANSITIONS.ACTIVATED || e.transition === TRANSITIONS.INVALIDATED);
      }
      if (category && category !== 'all') out = out.filter((e) => e.category === category);
      if (symbol) out = out.filter((e) => e.symbol === String(symbol).toUpperCase());
      return out.slice(0, limit);
    },

    /** Everything that has happened to one symbol — the drill-down, and the chart-marker source. */
    forSymbol(symbol, { limit = 50 } = {}) {
      const s = String(symbol || '').toUpperCase();
      return events.filter((e) => e.symbol === s).slice(0, limit);
    },

    size: () => events.length,
    clear() { events = []; seen.clear(); },
  };
}

/** ET clock format, because a market event is read in market time. */
const ET_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export const pulseTime = (ms) => (Number.isFinite(ms) ? ET_TIME.format(ms) : '—');

/** A short, shouty label for the tape, where a full sentence would not fit. */
export function pulseLabel(event) {
  if (!event) return '';
  if (event.transition === TRANSITIONS.INVALIDATED) return `${event.label} FAILED`.toUpperCase();
  return String(event.label || event.signalId || '').toUpperCase();
}
