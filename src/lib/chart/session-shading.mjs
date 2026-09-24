// EXTENDED-HOURS SESSION SHADING for the intraday chart.
//
// Pre-market (04:00–09:30 ET) and after-hours (16:00–20:00 ET) get a background wash; the regular
// session keeps the plain canvas. The point is to make the regular session legible as a block, so
// a 7am print is never read as an opening move.
//
// ── ⚠️ IT SHADES BARS, NOT CLOCK RANGES ─────────────────────────────────────
//
// The obvious implementation converts 04:00 and 09:30 to x-coordinates and fills between them.
// That is wrong here for two reasons, and both of them show up as invented sessions on screen:
//
//   · Lightweight Charts' time scale has no coordinate for a timestamp that has no bar. A market
//     holiday, a halt, or simply a symbol with no pre-market interest would still get a shaded
//     band, announcing a session that did not happen.
//   · The axis is an INDEX of bars, not a continuous clock. The gap between Friday 20:00 and
//     Monday 04:00 is one bar-width wide, so a range fill would paint straight across the weekend.
//
// Shading each contiguous RUN of bars that are themselves in the session makes both cases correct
// by construction: no bars, no shading. Weekends are not special-cased because they cannot occur —
// there are no bars to shade. This is also why the band honestly reflects a feed that starts at
// 08:00: the shaded region is exactly the pre-market data that exists, never a promise of data.

/** US equity session boundaries, in ET minutes since midnight. */
export const PRE_OPEN_MIN = 240;      // 04:00
export const RTH_OPEN_MIN = 570;      // 09:30
export const RTH_CLOSE_MIN = 960;     // 16:00
export const POST_CLOSE_MIN = 1200;   // 20:00

// One formatter, reused. Constructing an Intl.DateTimeFormat per bar is the kind of thing that
// turns a 400-bar redraw into a visible stutter on every pan.
const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
});

// ⚠️ MEMOISED ON THE TIMESTAMP. Panning re-renders constantly and the session of a given bar never
// changes, so this is computed once per bar for the life of the page.
const cache = new Map();

/** ET minutes-since-midnight for a UNIX-seconds timestamp. */
export function etMinutes(timeSec) {
  const key = timeSec;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let mins = null;
  try {
    const parts = ET.formatToParts(new Date(timeSec * 1000));
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    // 24:xx is how some ICU builds spell midnight with hour12:false.
    if (Number.isFinite(h) && Number.isFinite(m)) mins = (h % 24) * 60 + m;
  } catch { mins = null; }
  if (cache.size > 20000) cache.clear();
  cache.set(key, mins);
  return mins;
}

/**
 * 'pre' | 'rth' | 'post' | null for a bar's timestamp.
 *
 * null covers anything outside 04:00–20:00, which should not appear in an intraday payload at all;
 * returning null rather than guessing keeps an unexpected bar UNSHADED instead of mislabelled.
 */
export function sessionOf(timeSec) {
  const m = etMinutes(timeSec);
  if (m == null) return null;
  if (m >= PRE_OPEN_MIN && m < RTH_OPEN_MIN) return 'pre';
  if (m >= RTH_OPEN_MIN && m < RTH_CLOSE_MIN) return 'rth';
  if (m >= RTH_CLOSE_MIN && m < POST_CLOSE_MIN) return 'post';
  return null;
}

/** Contiguous runs of extended-hours bars: [{ from, to }] in bar timestamps. */
export function extendedRuns(bars) {
  const runs = [];
  let start = null, prev = null;
  for (const b of bars || []) {
    const t = Number(b?.time);
    if (!Number.isFinite(t)) continue;
    const s = sessionOf(t);
    const ext = s === 'pre' || s === 'post';
    if (ext && start === null) start = t;
    // A run ends when the session flips — including pre -> rth at 09:30, which is the transition
    // the whole feature exists to make visible.
    if (!ext && start !== null) { runs.push({ from: start, to: prev }); start = null; }
    if (ext) prev = t; else prev = t;
  }
  if (start !== null && prev !== null) runs.push({ from: start, to: prev });
  return runs;
}

/**
 * A Lightweight Charts v5 series primitive that paints the runs.
 *
 * @param {() => string} getColor  resolves the current theme's band colour at draw time, so a
 *                                 theme switch repaints without the primitive being rebuilt.
 */
export function createSessionShading(getColor) {
  let chart = null, requestUpdate = null, bars = [], enabled = true;

  const renderer = {
    draw(target) {
      if (!enabled || !chart || !bars.length) return;
      const color = getColor?.();
      if (!color) return;
      const runs = extendedRuns(bars);
      if (!runs.length) return;
      const ts = chart.timeScale();
      let half = 3;
      try { half = Math.max(0.5, (ts.options?.().barSpacing ?? 6) / 2); } catch { /* default */ }

      target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio, bitmapSize }) => {
        ctx.save();
        ctx.fillStyle = color;
        for (const run of runs) {
          const a = ts.timeToCoordinate(run.from);
          const b = ts.timeToCoordinate(run.to);
          // ⚠️ BOTH EDGES CAN BE null WHILE THE RUN IS ON SCREEN — it may start before the left
          // edge and end after the right. Falling back to the pane bounds keeps a long band from
          // vanishing the moment its first bar is scrolled past.
          if (a == null && b == null) continue;
          const x0 = ((a ?? 0) - half) * horizontalPixelRatio;
          const x1 = ((b ?? (bitmapSize.width / horizontalPixelRatio)) + half) * horizontalPixelRatio;
          if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) continue;
          ctx.fillRect(x0, 0, x1 - x0, bitmapSize.height);
        }
        ctx.restore();
      });
    },
  };

  const paneView = {
    renderer: () => renderer,
    // Behind everything: candles, indicators, drawings and gridlines all stay on top.
    zOrder: () => 'bottom',
  };

  return {
    attached(params) { chart = params.chart; requestUpdate = params.requestUpdate; },
    detached() { chart = null; requestUpdate = null; bars = []; },
    updateAllViews() {},
    paneViews() { return [paneView]; },
    /** Feed the primitive the same bars the price series was given. */
    setBars(next) { bars = Array.isArray(next) ? next : []; requestUpdate?.(); },
    /** Daily charts have no sessions to shade; the host turns it off rather than rebuilding. */
    setEnabled(on) { enabled = !!on; requestUpdate?.(); },
  };
}
