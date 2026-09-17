// CHART COORDINATE SPACE — where a drawing is allowed to exist.
//
// THE BUG THIS FIXES. Every drawing anchor used to be clamped to an existing bar:
//
//     const idx = Math.max(0, Math.min(list.length - 1, Math.round(logical)));
//     return { time: list[idx].time, price };
//
// so an anchor could never be placed past the last candle, and a trendline projected into empty
// space — the single most common thing a trader draws — quietly snapped back onto the final bar.
// Reading it back had the same ceiling: `timeToCoordinate()` returns null for any time the scale
// does not know, so even a future time would not have rendered.
//
// THE MODEL. An anchor is a MOMENT, not a bar index. Inside the data that moment is a bar's own
// time, exactly as before, so every stored drawing keeps working and persistence is unchanged.
// Beyond the data it is extrapolated from the bar spacing — a real timestamp that simply has no
// candle under it yet.
//
// WHY A TIMESTAMP AND NOT A LOGICAL INDEX. Both would let a drawing sit in empty space, but only one
// survives the two things that happen to a chart:
//
//   NEW BARS ARRIVE   an index shifts underneath the drawing; a timestamp does not, so the anchor
//                     stays where the trader put it and the candles grow toward it.
//   TIMEFRAME CHANGES index 60 means something different on every timeframe; a timestamp means the
//                     same moment on all of them.
//
// ONE SOLUTION FOR EVERY TOOL. Trendlines, rays, Fibonacci, rectangles and notes all go through
// these two functions, so none of them carries its own idea of where it may be drawn.
//
// Pure: bar lists in, numbers out. No chart instance, no DOM.

/** Daily bars carry 'YYYY-MM-DD'; intraday bars carry UNIX seconds. Both are valid anchor times. */
export const isDateTime = (t) => typeof t === 'string';

const DAY_MS = 86_400_000;

/** A bar time as epoch milliseconds, or null when it is neither shape we understand. */
export function timeToMs(time) {
  if (typeof time === 'number' && Number.isFinite(time)) return time * 1000;
  if (typeof time === 'string') {
    const ms = Date.parse(`${time}T00:00:00Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Back to whichever shape the series uses, so an extrapolated anchor looks like every other one. */
export function msToTime(ms, asDateString) {
  if (!Number.isFinite(ms)) return null;
  if (!asDateString) return Math.round(ms / 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The spacing between bars, in milliseconds.
 *
 * Taken from the MEDIAN gap of the recent tail rather than the last pair: a session boundary, a
 * halt or a weekend makes any single gap wrong, and one wrong gap would throw every future anchor
 * off by hours.
 */
export function barSpacingMs(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const tail = bars.slice(-25);
  const gaps = [];
  for (let i = 1; i < tail.length; i += 1) {
    const a = timeToMs(tail[i - 1].time);
    const b = timeToMs(tail[i].time);
    if (a == null || b == null) continue;
    const gap = b - a;
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return null;
  gaps.sort((x, y) => x - y);
  const mid = gaps.length >> 1;
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/**
 * Where a moment sits on the logical axis — the index space Lightweight Charts draws in.
 *
 * Fractional and unbounded: a value past the last bar is how a future anchor is positioned, and a
 * negative one places a drawing to the left of the loaded history. Returns null only when there is
 * nothing to measure against.
 */
export function logicalOfTime(time, bars) {
  if (!Array.isArray(bars) || !bars.length) return null;
  const ms = timeToMs(time);
  if (ms == null) return null;

  // An exact bar wins outright — that is the common case and it must stay exact rather than being
  // reconstructed from an average spacing.
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i].time === time) return i;
  }

  const spacing = barSpacingMs(bars);
  const firstMs = timeToMs(bars[0].time);
  const lastMs = timeToMs(bars[bars.length - 1].time);
  if (firstMs == null || lastMs == null) return null;

  if (ms > lastMs) {
    if (!spacing) return bars.length - 1;
    return (bars.length - 1) + (ms - lastMs) / spacing;
  }
  if (ms < firstMs) {
    if (!spacing) return 0;
    return (ms - firstMs) / spacing;
  }

  // Between two known bars: interpolate across the pair that brackets it, so a drawing made on one
  // timeframe still lands in the right place when read on a finer one.
  for (let i = 1; i < bars.length; i += 1) {
    const prev = timeToMs(bars[i - 1].time);
    const next = timeToMs(bars[i].time);
    if (prev == null || next == null || next <= prev) continue;
    if (ms >= prev && ms <= next) return (i - 1) + (ms - prev) / (next - prev);
  }
  return null;
}

/**
 * The moment at a logical position.
 *
 * Inside the data this returns the BAR'S OWN TIME, which is what keeps anchors landing on candles
 * and keeps every previously stored drawing byte-identical. Outside it, the time is extrapolated
 * from the bar spacing — the anchor is a real moment that simply has no candle under it yet.
 */
export function timeOfLogical(logical, bars) {
  if (!Array.isArray(bars) || !bars.length || !Number.isFinite(logical)) return null;
  const lastIdx = bars.length - 1;
  const asDate = isDateTime(bars[lastIdx].time);

  if (logical >= 0 && logical <= lastIdx) {
    return bars[Math.round(logical)].time;
  }

  const spacing = barSpacingMs(bars) ?? (asDate ? DAY_MS : 60_000);
  if (logical > lastIdx) {
    const lastMs = timeToMs(bars[lastIdx].time);
    if (lastMs == null) return bars[lastIdx].time;
    return msToTime(lastMs + (logical - lastIdx) * spacing, asDate);
  }
  const firstMs = timeToMs(bars[0].time);
  if (firstMs == null) return bars[0].time;
  return msToTime(firstMs + logical * spacing, asDate);
}

/** Is this moment beyond the loaded data — i.e. drawn into empty chart space? */
export function isFutureTime(time, bars) {
  if (!Array.isArray(bars) || !bars.length) return false;
  const ms = timeToMs(time);
  const lastMs = timeToMs(bars[bars.length - 1].time);
  return ms != null && lastMs != null && ms > lastMs;
}

/**
 * Move a moment by a number of SECONDS, preserving its representation.
 *
 * Seconds because that is the unit intraday anchors are already in; a date-string anchor is
 * converted, shifted and formatted back, which is what lets a daily drawing be dragged sideways at
 * all. Previously anything on a date string refused to move horizontally.
 */
export function shiftTime(time, deltaSeconds) {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds === 0) return time;
  if (typeof time === 'number') return time + deltaSeconds;
  const ms = timeToMs(time);
  if (ms == null) return time;
  return msToTime(ms + deltaSeconds * 1000, true);
}

/** The gap between two moments, in seconds, whatever shape they are. */
export function timeDeltaSeconds(from, to) {
  const a = timeToMs(from);
  const b = timeToMs(to);
  if (a == null || b == null) return 0;
  return (b - a) / 1000;
}
