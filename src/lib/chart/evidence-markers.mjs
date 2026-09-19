// EVIDENCE MARKERS — placing canonical evidence on the price series. PURE: no DB, no React, no lwc.
//
// The chart shows WHEN PUBLIC EVIDENCE ENTERED THE MARKET, against the price that followed. This
// file decides where each marker sits and what it looks like; it decides NOTHING about what the
// evidence means. Materiality, direction, quality, dedupe and noise suppression all arrive already
// settled from src/lib/evidence/* — if the chart re-derived any of them, the timeline and What
// Changed would be two opinions about the same filing, which is the exact failure the single
// engine exists to prevent.
//
// ── PLACEMENT IS A POINT-IN-TIME CLAIM ──────────────────────────────────────
//
// A marker on a candle asserts "the market could act on this here". So placement uses publicTime,
// always, and never the underlying economic date:
//
//   Congress   the DISCLOSURE date. Placing a congressional purchase on its transaction date draws
//              it on a candle from up to 289 days earlier (a real lag in our data) — a picture of
//              information nobody outside Congress had, which is unbacktestable by construction.
//   13F        the FILING date. Quarter end is months earlier; a marker there claims the market
//              knew a position while it was still being accumulated.
//   Form 4     the filing date, not the transaction date.
//   8-K/Wire   the filing / source publication timestamp.
//
// The engine already enforces publicTime >= eventTime and quarantines violations, so this file can
// trust publicTime — but it reads ONLY publicTime, so a regression upstream cannot silently move a
// marker onto the wrong candle.
//
// ── SNAPPING ────────────────────────────────────────────────────────────────
//
// Evidence lands on the FIRST BAR AT OR AFTER it became public. An 8-K filed 6pm Friday belongs on
// Monday's candle, because Monday is the first session in which anyone could trade it. Snapping
// backwards to Friday would put the marker on a session that closed before the filing existed.

// ── family appearance ────────────────────────────────────────────────────────
// Concrete hex, never `var(--cp-*)`: these are painted on a canvas, which cannot resolve CSS
// variables and silently drops the marker. chart-theme.mjs documents the same trap.
//
// Colours are the design system's own (cp-shared.jsx), brightened for the dark canvas the same way
// greenOnDark is.
const LIGHT = {
  catalyst: '#1A3A78',      // C.blue
  insiderBuy: '#1E5C38',    // C.green
  insiderSell: '#A83030',   // C.red
  congress: '#5A2A98',      // TAG.AI purple — distinct from price up/down
  institution: '#7A5818',   // C.gold
  market: '#5A6458',        // C.muted
};
const DARK = {
  catalyst: '#6FA8FF',
  insiderBuy: '#4FB37C',
  insiderSell: '#E06A6A',
  congress: '#C08CE0',
  institution: '#E0B84A',
  market: '#9AA398',
};

export const markerPalette = (theme) => (theme === 'dark' ? DARK : LIGHT);

/**
 * Shape and side per family.
 *
 * Side encodes DIRECTION where a family has one, so a column of arrows reads as buying pressure
 * without the viewer decoding colours. Families without an inherent direction sit above the bar as
 * neutral pins. Shapes stay distinguishable at 1:1 — the chart is dense already.
 */
export function markerStyleFor(ev, pal) {
  switch (ev.family) {
    case 'insider': {
      const sell = ev.direction === 'negative';
      return {
        position: sell ? 'aboveBar' : 'belowBar',
        shape: sell ? 'arrowDown' : 'arrowUp',
        color: sell ? pal.insiderSell : pal.insiderBuy,
      };
    }
    case 'catalyst':
      return { position: 'aboveBar', shape: 'square', color: pal.catalyst };
    case 'congress':
      return { position: 'aboveBar', shape: 'circle', color: pal.congress };
    case 'institution':
      return { position: 'belowBar', shape: 'circle', color: pal.institution };
    default:
      return { position: 'aboveBar', shape: 'square', color: pal.market };
  }
}

// ── snapping ─────────────────────────────────────────────────────────────────

const epoch = (v) => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/** A bar's `time` as epoch ms. Daily bars are 'YYYY-MM-DD'; intraday bars are UNIX seconds. */
export function barEpoch(time) {
  if (typeof time === 'number') return time * 1000;
  const t = Date.parse(`${time}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * The bar an evidence item attaches to, or null when it cannot be placed.
 *
 * Returns the bar's own `time` value — in the series' domain, which is what Lightweight Charts
 * requires. A marker whose time is not a real data point is dropped by the library without warning,
 * so this never invents one.
 *
 * Out-of-range evidence yields null rather than being clamped to an end: clamping would pile every
 * older filing onto the first visible candle and assert they all became public that morning.
 */
export function snapToBar(publicTime, bars) {
  const t = epoch(publicTime);
  if (t == null || !Array.isArray(bars) || !bars.length) return null;

  const first = barEpoch(bars[0].time);
  const last = barEpoch(bars[bars.length - 1].time);
  if (first == null || last == null) return null;

  // Daily bars are dated midnight UTC, so a filing at any hour of the last session still belongs on
  // it. Without this, everything published after midnight on the final bar falls off the chart.
  const lastBarEnd = typeof bars[bars.length - 1].time === 'number' ? last : last + 86_400_000 - 1;
  if (t > lastBarEnd) return null;                 // published after the series ends
  if (t < first) return null;                      // published before the series starts

  // First bar at or after the moment it became public. Binary search: a 5Y daily series is ~1,250
  // bars and a ticker can carry hundreds of filings, so a linear scan per item is a needless O(n·m).
  let lo = 0, hi = bars.length - 1, ans = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bt = barEpoch(bars[mid].time);
    // A daily bar covers its whole day, so anything published during that day belongs to it.
    const end = typeof bars[mid].time === 'number' ? bt : bt + 86_400_000 - 1;
    if (end >= t) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
  }
  return bars[ans].time;
}

// ── grouping ─────────────────────────────────────────────────────────────────

/** Same bar + same family collapses to one marker. The key is stable and sortable. */
export const groupKey = (time, family) => `${typeof time === 'number' ? time : String(time)}|${family}`;

/**
 * How many markers a chart can carry before it stops being readable.
 *
 * When there are more groups than this, the LOWEST-MATERIALITY groups are dropped — materiality
 * being the engine's existing number, not a new one invented here. Nothing is hidden silently: the
 * caller is told how many were dropped so the UI can say so.
 */
export const MAX_MARKERS = 60;

/**
 * Build the marker array and the lookup a tooltip reads.
 *
 * Returns:
 *   markers  in Lightweight Charts v5 shape, ascending by time (the library requires it)
 *   byKey    groupKey -> the evidence behind that marker, so a click shows the real records
 *   placed / unplaced / dropped  counts, so the UI can be honest about what is not shown
 */
export function buildEvidenceMarkers(evidence, bars, { theme = 'light', maxMarkers = MAX_MARKERS } = {}) {
  const pal = markerPalette(theme);
  const list = Array.isArray(evidence) ? evidence : [];
  const groups = new Map();
  let unplaced = 0;

  for (const ev of list) {
    // ⚠️ publicTime ONLY. Never eventTime, referencePeriod, or facts.transactionDate.
    const time = snapToBar(ev?.publicTime, bars);
    if (time == null) { unplaced++; continue; }
    const key = groupKey(time, ev.family);
    const g = groups.get(key);
    if (g) {
      g.items.push(ev);
      g.materiality = Math.max(g.materiality, Number(ev.materiality) || 0);
      // A mixed-direction cluster must not masquerade as one-way pressure.
      if (g.direction !== ev.direction) g.direction = 'mixed';
    } else {
      groups.set(key, {
        key, time, family: ev.family, direction: ev.direction,
        materiality: Number(ev.materiality) || 0, items: [ev],
      });
    }
  }

  let kept = [...groups.values()];
  let dropped = 0;
  if (kept.length > maxMarkers) {
    // Deterministic: materiality, then recency, then key — so the same chart never reshuffles.
    kept.sort((a, b) => (b.materiality - a.materiality)
      || (barEpoch(b.time) - barEpoch(a.time))
      || a.key.localeCompare(b.key));
    dropped = kept.length - maxMarkers;
    kept = kept.slice(0, maxMarkers);
  }

  kept.sort((a, b) => (barEpoch(a.time) - barEpoch(b.time)) || a.key.localeCompare(b.key));

  const byKey = new Map();
  const markers = kept.map((g) => {
    byKey.set(g.key, g.items);
    const style = markerStyleFor(
      // A grouped marker with mixed directions gets the neutral treatment of its family.
      g.items.length > 1 && g.direction === 'mixed' ? { family: g.family, direction: 'mixed' } : g.items[0],
      pal,
    );
    return {
      time: g.time,
      position: style.position,
      shape: style.shape,
      color: style.color,
      // Compact by design: the count only when there IS a count. A "1" on every pin is noise.
      text: g.items.length > 1 ? String(g.items.length) : '',
      // Carried through so a click can find the group without re-deriving the key.
      id: g.key,
    };
  });

  return { markers, byKey, placed: kept.length, unplaced, dropped };
}

/**
 * The evidence behind whichever marker sits on a given bar.
 *
 * The crosshair reports a bar, not a marker, so a hover has to ask "what is on this candle" — every
 * family at once, since two families can share a bar.
 */
export function evidenceAtBar(byKey, time) {
  if (!byKey || time == null) return [];
  const out = [];
  for (const [key, items] of byKey) {
    const t = key.slice(0, key.lastIndexOf('|'));
    if (t === String(time)) out.push(...items);
  }
  return out;
}
