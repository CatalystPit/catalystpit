// Detects points where a daily price series stops describing the same thing on both sides, so no
// surface computes a return across one.
//
// Three real causes, all present in our data:
//   TICKER REUSE      a symbol is retired and reassigned. FIG closes at 23.83 as one security and
//                     opens at 115.50 as Figma the next session. PARA shows congressional trades
//                     around $250 in a series whose latest close is $1.00.
//   REVERSE SPLIT     not applied consistently across the series. LAZR steps 0.1884 -> 50.60 in one
//                     session, which rendered a congressional trade as +23,169.6 percent.
//   UNUSABLE QUOTES   sub-penny names whose closes oscillate between 0.0001 and 0.05 from day to
//                     day. Every percentage computed from them is quote granularity, not return.
//
// What this deliberately does NOT flag is a large honest move. The test is a SUSTAINED LEVEL SHIFT:
// the median of several closes before the step against the median of several after. A stock that
// doubles on earnings and holds it moves its median by 2x, nowhere near the 4x threshold; one that
// spikes intraday and falls back does not move its median at all. Nothing here fabricates or adjusts
// a price. It only decides which comparisons are meaningless and must not be shown.

export const WINDOW = 5;        // closes on each side of a candidate step
export const RATIO = 4;         // sustained level change that counts as a break
export const MAX_BREAKS = 3;    // more than this and the series itself is the problem
export const PENNY_LEVEL = 0.05; // recent median close below this: percentages are quote granularity
export const MIN_BARS = 2 * WINDOW + 1;
export const RECENT_BARS = 250;  // what "this is a sub-penny name" is judged on: the last year

// A hole in the series is the second signal, and the one that catches a reused symbol whose new
// listing opens at a level the sliding median alone just misses: FIG resumes after 69 quiet days at
// 4.85x its old level, which is under the RATIO threshold once the first volatile week is averaged
// in. Requiring BOTH a gap and a doubling keeps thin foreign names out of it, since those show long
// holes at an unchanged level (AJINF, INPAP and STT all gap for months and move under 1.3x).
export const GAP_DAYS = 21;
export const GAP_RATIO = 2;

// The discriminator between a corporate action and a brutal but honest session. Both can halve a
// stock; only one is out of character for the security itself. A step is measured against that
// security's OWN 95th-percentile daily move over the surrounding four months, and counts only when
// it is ANOMALY times larger. Measured on real cases: iRobot's bankruptcy slide scores 3.3 and a
// microcap's 3.7x spike day scores 3.2, while every genuine break scores 13 or higher. Nothing
// between 3.3 and 13.0 exists in this data, so the line sits in open space rather than on a guess.
export const ANOMALY = 8;
export const VOL_WINDOW = 60;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * bars: ascending [{ date: 'YYYY-MM-DD', close: number }]
 * Returns { usable, reason, breaks: [{ date, ratio, before, after }], lastBreak, bars, level }
 *
 * `lastBreak` is the whole rule at query time: a return anchored on or before it spans a break and
 * must not be shown. A return anchored after it sits entirely inside the current segment.
 */
export function analyzeSeries(bars, opts = {}) {
  const window = opts.window ?? WINDOW;
  const ratio = opts.ratio ?? RATIO;
  const maxBreaks = opts.maxBreaks ?? MAX_BREAKS;
  const pennyLevel = opts.pennyLevel ?? PENNY_LEVEL;

  const clean = (bars || []).filter((b) => b && b.date && Number(b.close) > 0);
  if (clean.length < (opts.minBars ?? MIN_BARS)) {
    return { usable: true, reason: null, breaks: [], lastBreak: null, bars: clean.length, level: null };
  }
  const closes = clean.map((b) => Number(b.close));
  // Judged on the last year, not the whole history: a long split-adjusted series legitimately
  // starts in pennies decades ago (AAPL opens at 0.10) without being a sub-penny name today.
  const level = median(closes.slice(-(opts.recentBars ?? RECENT_BARS)));

  // A sub-penny series is rejected whole rather than per-break: there is no segment of it from
  // which an honest percentage can be computed.
  if (level < pennyLevel) {
    return { usable: false, reason: 'sub_penny', breaks: [], lastBreak: null, bars: clean.length, level };
  }

  const gapDays = opts.gapDays ?? GAP_DAYS;
  const gapRatio = opts.gapRatio ?? GAP_RATIO;
  const anomaly = opts.anomaly ?? ANOMALY;
  const volWindow = opts.volWindow ?? VOL_WINDOW;

  // 95th-percentile absolute daily log move around index i, excluding the step itself.
  const localP95 = (i) => {
    const moves = [];
    for (let k = Math.max(1, i - volWindow); k < Math.min(closes.length, i + volWindow); k++) {
      if (k === i) continue;
      if (closes[k - 1] > 0 && closes[k] > 0) moves.push(Math.abs(Math.log(closes[k] / closes[k - 1])));
    }
    if (!moves.length) return 0;
    moves.sort((a, b) => a - b);
    return moves[Math.floor(moves.length * 0.95)] ?? moves[moves.length - 1];
  };

  const found = [];
  for (let i = window; i <= clean.length - window; i++) {
    const before = median(closes.slice(i - window, i));
    const after = median(closes.slice(i, i + window));
    if (!(before > 0) || !(after > 0)) continue;
    const r = after > before ? after / before : before / after;
    const hole = (Date.parse(clean[i].date) - Date.parse(clean[i - 1].date)) / 86400000;
    const kind = r >= ratio ? 'level_shift' : (hole >= gapDays && r >= gapRatio ? 'listing_gap' : null);
    if (!kind) continue;
    // Out of character for this security, or just a very bad day? Only the former is a break.
    const p95 = localP95(i);
    const step = Math.abs(Math.log(closes[i] / closes[i - 1]));
    const odds = p95 > 0 ? step / p95 : Infinity;
    if (odds < anomaly) continue;
    found.push({
      date: clean[i].date, ratio: +r.toFixed(2), before, after, kind,
      gap: Math.round(hole), anomaly: Number.isFinite(odds) ? +odds.toFixed(1) : null,
    });
  }

  // One corporate action produces a run of adjacent candidates as the windows slide across it.
  // Collapse each run to its sharpest member so the count means "events", not "bars".
  const breaks = [];
  for (const c of found) {
    const prev = breaks[breaks.length - 1];
    const adjacent = prev && (Date.parse(c.date) - Date.parse(prev.date)) / 86400000 <= window * 2;
    if (!adjacent) { breaks.push(c); continue; }
    if (c.ratio > prev.ratio) breaks[breaks.length - 1] = c;
  }

  if (breaks.length > maxBreaks) {
    return { usable: false, reason: 'too_many_breaks', breaks, lastBreak: breaks[breaks.length - 1].date, bars: clean.length, level };
  }
  return {
    usable: true,
    reason: null,
    breaks,
    lastBreak: breaks.length ? breaks[breaks.length - 1].date : null,
    bars: clean.length,
    level,
  };
}

/**
 * The single question every caller asks: may a return anchored on `anchorDate` be shown?
 * `quality` is a row from ticker_price_quality ({ usable, lastBreak }) or null when unscanned.
 * Unscanned is treated as allowed: absence of evidence is not evidence of a break, and every
 * ticker congress touches is scanned.
 */
export function returnBlocked(quality, anchorDate) {
  if (!quality) return null;
  if (quality.usable === false) return quality.reason || 'unusable_series';
  const last = quality.lastBreak;
  if (!last || !anchorDate) return null;
  const a = typeof anchorDate === 'string' ? anchorDate.slice(0, 10) : new Date(anchorDate).toISOString().slice(0, 10);
  return a <= String(last).slice(0, 10) ? 'series_break' : null;
}

// Copy shown to readers. One sentence, no jargon, and it never implies the trade was wrong.
export const BLOCK_COPY = {
  series_break: 'Price history for this symbol breaks between the trade and today, so a return would be misleading.',
  sub_penny: 'Quotes for this symbol are too small to produce a meaningful percentage.',
  too_many_breaks: 'Price history for this symbol is not continuous enough to measure a return.',
  unusable_series: 'Price history for this symbol is not reliable enough to measure a return.',
};
