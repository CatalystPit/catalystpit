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

// ⚠️ THE CANONICAL ATTENTION TAG, IMPORTED RATHER THAN RESTATED. Consensus already decided which
// single disclosures are big enough to stand alone, with stated thresholds and a version string.
// The chart asks it; it does not hold an opinion of its own about what is significant.
import { highSignificance, roleWord } from '../consensus/high-significance.mjs';

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

// ── hierarchy ────────────────────────────────────────────────────────────────
//
// ⚠️ TWO TIERS, AND THE LINE BETWEEN THEM IS NOT DRAWN HERE.
//
// A CEO's $10.0M open-market purchase was rendering as the same 1px arrow as a quarterly 13F
// breadth change — present, correctly placed, and impossible to notice without already knowing
// where to look. The fix is a hierarchy; the risk is that "important" becomes a number invented by
// the chart, which would make the canvas a second opinion about significance.
//
// So the promotion is decided by highSignificance() — the EXISTING canonical attention tag, with
// its own stated thresholds ($500K by a lead role, $1M by any insider, $1M across a cluster, a
// congressional band floor of $500K, a catalyst the engine already calls exceptional, an
// institutional change its own history calls unusual). This file asks that function a yes/no
// question and draws the answer. It sets no threshold of its own.
//
// ⚠️ WHAT THAT MEANS FOR SELLS, STATED PLAINLY: highSignificance covers open-market PURCHASES only
// — deliberately, per its own comments — so no insider sale is promoted, whatever its size. The
// alternative was to invent a sell threshold here, which is precisely what must not happen. A sale
// keeps its red down-arrow and explains itself on hover.

/** Marker sizes, in Lightweight Charts' own units. Screen pixels — zoom does not shrink them. */
export const TIER_SIZE = Object.freeze({ routine: 1, prominent: 2.6 });

/**
 * How far apart two labelled markers must sit before both may keep their text.
 *
 * ⚠️ A CLUTTER RULE, NOT A RANKING. When two labels would collide the lower-significance one loses
 * its TEXT and keeps its prominent marker, so nothing is demoted or hidden — the words simply move
 * to the hover, which is where the brief says they should go when space runs out.
 */
export const MIN_LABEL_GAP_BARS = 15;

/** 'prominent' when the canonical attention tag fires for this group, else 'routine'. */
export function tierFor(items) {
  try { return highSignificance(Array.isArray(items) ? items : [items]).high ? 'prominent' : 'routine'; }
  catch { return 'routine'; }   // an unreadable record draws as ordinary, never as loud
}

/**
 * The compact label for a promoted marker, or '' when none can be written honestly.
 *
 * ⚠️ EVERY TOKEN IS CANONICAL. The role word is the same one high-significance.mjs prints, taken
 * from the FILED title; the value is the engine's own totalValueLabel; the verb is the engine's own
 * direction. Nothing is estimated and no title is inferred — when the filed title names no lead
 * role, the label says INSIDER rather than guessing at one.
 *
 * ⚠️ AND ONLY INSIDER BUYS CARRY ONE. A label is the loudest thing on a price chart, so it is spent
 * on the case the brief names: a major open-market purchase whose facts are already sufficient.
 */
export function markerLabelFor(items) {
  const list = Array.isArray(items) ? items : [items];
  const ins = list.find((e) => e?.family === 'insider' && /buy/i.test(String(e?.type || '')));
  if (!ins) return '';
  const f = ins.facts || {};
  const value = f.totalValueLabel;
  if (!value) return '';                    // no canonical value, no label — never a computed one
  const role = roleWord(f.leadRoleTitle || f.title);
  return `${role === 'An officer' ? 'INSIDER' : role.toUpperCase()} BUY ${value}`;
}

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

  // ── tier, then labels, then collision ───────────────────────────────────────
  //
  // Tier first because it decides size and size is never dropped. Labels are assigned after, and
  // are the only thing a collision can take away.
  // `bars` may legitimately be null or empty — snapToBar already tolerates it, and every group
  // would have been dropped above, so the index is simply empty rather than a crash.
  const barIndex = new Map();
  for (const [i, b] of (Array.isArray(bars) ? bars : []).entries()) {
    barIndex.set(typeof b.time === 'number' ? b.time : String(b.time), i);
  }
  for (const g of kept) {
    g.tier = tierFor(g.items);
    g.label = g.tier === 'prominent' ? markerLabelFor(g.items) : '';
  }
  // ⚠️ THE LOSER KEEPS ITS MARKER AND LOSES ONLY ITS WORDS. Walking left to right, a label within
  // MIN_LABEL_GAP_BARS of the last one printed is dropped — the marker stays prominent and the
  // text moves to the hover, which is what the brief asks for when labels would collide.
  let lastLabelAt = null;
  for (const g of kept) {
    if (!g.label) continue;
    const i = barIndex.get(typeof g.time === 'number' ? g.time : String(g.time));
    if (lastLabelAt != null && Number.isFinite(i) && i - lastLabelAt < MIN_LABEL_GAP_BARS) { g.label = ''; continue; }
    if (Number.isFinite(i)) lastLabelAt = i;
  }

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
      size: TIER_SIZE[g.tier],
      // ⚠️ THE COUNT WHEN THERE IS A COUNT, THE LABEL ONLY WHERE IT WAS EARNED AND FITS. A routine
      // marker never carries text: a chart that annotates every dot is a chart nobody can read a
      // price on. Shape and side say buy or sell, colour says which family, size says whether the
      // canonical attention tag fired, and the hover says everything else.
      text: g.label || (g.items.length > 1 ? String(g.items.length) : ''),
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
