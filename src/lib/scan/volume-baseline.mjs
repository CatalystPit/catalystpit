// TIME-OF-DAY VOLUME BASELINES.
//
// RVOL is the number traders size on, and the naive version of it is wrong in a specific, dangerous
// direction. Comparing 10:05 cumulative volume against a full-day average says every symbol is quiet
// every morning; comparing it against a *fraction* of the day assumes volume arrives evenly, which
// it emphatically does not — the open and the close carry a large share of the day, and the middle
// hours carry very little.
//
// So the baseline is BY TIME OF DAY: what has this symbol normally traded by 10:05, measured across
// its own recent sessions.
//
//   cumulative RVOL   volume so far today / volume normally done by this minute
//   interval RVOL     volume in the last N minutes / volume normally done in that same N minutes
//
// The second is what catches a symbol waking up at 14:30 after a dead morning — its cumulative RVOL
// can still be 0.9 while the last five minutes are running at eight times normal.
//
// ROBUST STATISTICS, NOT AVERAGES. One halt, one index rebalance or one earnings day in the lookback
// will drag a mean far enough to hide every subsequent real move. The baseline is a MEDIAN, and the
// dispersion is a median absolute deviation, so a single extraordinary session cannot destroy the
// reference. This matters more than it sounds: the sessions that blow out a mean are exactly the
// ones a scanner's lookback tends to contain.
//
// Pure. Builds from historical minute data the caller supplies, and returns null — never a guess —
// when there is not enough of it.

/** Minimum sessions before a baseline means anything. Below this, RVOL is reported as unavailable. */
export const MIN_SESSIONS = 10;

/** Baselines are bucketed to this many minutes, so a 09:31 print is not compared to 09:31 alone. */
export const BUCKET_MINUTES = 5;

export const bucketOf = (etMinutes) =>
  (Number.isFinite(etMinutes) ? Math.floor(etMinutes / BUCKET_MINUTES) * BUCKET_MINUTES : null);

/** The middle value. Sorting a copy, because a baseline builder must not reorder its caller's data. */
export function median(values) {
  const xs = (values || []).filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Median absolute deviation — the robust sibling of standard deviation.
 *
 * Scaled by 1.4826 so that for normally distributed data it estimates the same quantity as a
 * standard deviation, which keeps any threshold expressed in "sigmas" meaning what a reader expects.
 */
export function mad(values, centre = null) {
  const xs = (values || []).filter((v) => Number.isFinite(v));
  if (xs.length < 3) return null;
  const m = centre == null ? median(xs) : centre;
  if (m == null) return null;
  const dev = median(xs.map((v) => Math.abs(v - m)));
  return dev == null ? null : dev * 1.4826;
}

/**
 * Build a symbol's volume baseline from past sessions.
 *
 * `sessions` is an array of arrays of { etMinutes, volume } for one trading day each, oldest first.
 * Produces, per time bucket, the median cumulative volume reached by that point and the median
 * volume traded within that bucket — the two references the two RVOL flavours need.
 */
export function buildVolumeBaseline(sessions, { minSessions = MIN_SESSIONS } = {}) {
  if (!Array.isArray(sessions) || sessions.length < minSessions) return null;

  const cumulativeByBucket = new Map();
  const intervalByBucket = new Map();

  for (const session of sessions) {
    if (!Array.isArray(session) || !session.length) continue;
    const ordered = session
      .filter((x) => x && Number.isFinite(x.etMinutes) && Number.isFinite(x.volume))
      .slice()
      .sort((a, b) => a.etMinutes - b.etMinutes);
    if (!ordered.length) continue;

    let running = 0;
    const perBucket = new Map();
    for (const row of ordered) {
      running += row.volume;
      const b = bucketOf(row.etMinutes);
      perBucket.set(b, (perBucket.get(b) || 0) + row.volume);
      // The cumulative reading for a bucket is the total at the END of that bucket, so every session
      // contributes one comparable number per bucket rather than one per minute.
      cumulativeByBucket.set(b, [...(cumulativeByBucket.get(b) || []), running]);
    }
    for (const [b, v] of perBucket) intervalByBucket.set(b, [...(intervalByBucket.get(b) || []), v]);
  }

  const cumulative = new Map();
  const interval = new Map();
  for (const [b, xs] of cumulativeByBucket) {
    const m = median(xs);
    if (m != null) cumulative.set(b, { median: m, mad: mad(xs, m), n: xs.length });
  }
  for (const [b, xs] of intervalByBucket) {
    const m = median(xs);
    if (m != null) interval.set(b, { median: m, mad: mad(xs, m), n: xs.length });
  }
  if (!cumulative.size) return null;

  return { sessions: sessions.length, bucketMinutes: BUCKET_MINUTES, cumulative, interval };
}

/**
 * Cumulative RVOL: how today's volume so far compares with a normal day by this minute.
 *
 * Null when there is no baseline for this point in the session — before the open, or on a symbol
 * with too little history. An RVOL of null renders as "—" and fires nothing, which is the whole
 * point: a missing baseline must not become an RVOL of 1.0.
 */
export function cumulativeRvol(baseline, etMinutes, volumeToday) {
  if (!baseline || !Number.isFinite(volumeToday)) return null;
  const entry = baseline.cumulative.get(bucketOf(etMinutes));
  if (!entry || !(entry.median > 0)) return null;
  return {
    rvol: volumeToday / entry.median,
    expected: entry.median,
    observed: volumeToday,
    // How extreme this is in robust terms, which is what distinguishes "2× on a symbol that varies
    // wildly" from "2× on a symbol that never does".
    z: entry.mad > 0 ? (volumeToday - entry.median) / entry.mad : null,
    sessions: entry.n,
  };
}

/**
 * Interval RVOL: the last N minutes against what this symbol normally trades in that same slot.
 *
 * This is the one that catches a symbol coming alive mid-session, which cumulative RVOL smooths away.
 */
export function intervalRvol(baseline, etMinutes, volumeInInterval) {
  if (!baseline || !Number.isFinite(volumeInInterval)) return null;
  const entry = baseline.interval.get(bucketOf(etMinutes));
  if (!entry || !(entry.median > 0)) return null;
  return {
    rvol: volumeInInterval / entry.median,
    expected: entry.median,
    observed: volumeInInterval,
    z: entry.mad > 0 ? (volumeInInterval - entry.median) / entry.mad : null,
    sessions: entry.n,
  };
}

/**
 * Why a baseline is unavailable, in words, so the panel can explain a blank rather than show a dash.
 */
export function baselineStatus(baseline, caps) {
  if (!caps?.intradayVolumeHistory) {
    return { ready: false, reason: 'Time-of-day volume baselines need intraday volume history' };
  }
  if (!baseline) return { ready: false, reason: `Needs at least ${MIN_SESSIONS} sessions of history` };
  if (baseline.sessions < MIN_SESSIONS) {
    return { ready: false, reason: `Only ${baseline.sessions} sessions of history` };
  }
  return { ready: true, reason: null, sessions: baseline.sessions };
}
