// ⚠️ WHAT COUNTS AS A MARKET SESSION. One rule, shared by every consumer.
//
// ZERO IMPORTS DELIBERATELY. The Screener rebuild reaches this through the app's module graph, and the
// nightly coverage alarm reaches it from a bare CI runner with no app bootstrap. A single import of
// anything app-shaped here would force the second caller to load a database client it does not use.
//
// ── THE DEFECT THIS EXISTS TO PREVENT ──────────────────────────────────────────────────────────────
// The Screener took the two most recent DISTINCT dates in ticker_daily_candles as "the last two
// sessions". UNIU trades at weekends, so the vendor legitimately returns Saturday and Sunday bars for
// it — and one symbol out of 13,674 became the latest session. The Screener priced 1 row out of 18,019
// and raised no error, because a missing price is not an error anywhere.
//
// It then happened a SECOND time, in the coverage alarm written to catch the first: it measured the
// newest date the same way and reported 0.0% coverage on a Sunday. An alarm that fires every weekend
// is worse than no alarm, because it teaches you to ignore it. Hence one module instead of two copies.
//
// ── THE RULE ───────────────────────────────────────────────────────────────────────────────────────
// A session is a date a QUORUM of the market traded on. The quorum is a fraction of the typical recent
// session rather than an absolute count, because the universe grows and shrinks. The yardstick is the
// MEDIAN, not the mean: with a long tail of 1-ticker weekend dates a mean's threshold lands above a
// legitimately partial session and discards the real one (median 1 → floor 50 admits a 600-ticker
// session; mean 3,104 → threshold 620 rejects it).
//
// The threshold is deliberately low. A session still mid-backfill at 30% coverage is STILL the correct
// session to price from — the aim is to exclude weekend stragglers, not to demand completeness.
//
// There is NO ticker list here, and there must not be one. A symbol exclusion needs maintaining
// forever and is wrong the first time another weekend-traded name is listed; it would also mean
// distrusting bars the vendor really did supply. The bars are real and they stay. What was wrong is
// calling a 1-ticker day a market session.

export const SESSION_QUORUM_FRACTION = 0.2;
export const SESSION_QUORUM_FLOOR = 50;

/**
 * Pick the most recent real market sessions from per-date row counts.
 * @param {Array<{date: string, n: number|string}>} counted newest-first, as the callers' SQL orders it
 * @param {number} limit how many sessions to return (2 for price + previous close)
 * @returns {string[]} dates, newest first
 */
export function pickSessionDates(counted, limit = 2) {
  if (!counted?.length) return [];
  const sorted = counted.map((c) => Number(c.n)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const quorum = Math.max(SESSION_QUORUM_FLOOR, Math.floor(median * SESSION_QUORUM_FRACTION));
  const qualifying = counted.filter((c) => Number(c.n) >= quorum);
  // ⚠️ FALL BACK RATHER THAN RETURN NOTHING. If nothing clears the bar — a table only just seeded, or
  // a universe smaller than the floor — the newest dates are better than none. Returning [] here would
  // be the original bug's mirror image: every price blank instead of one row priced.
  return (qualifying.length ? qualifying : counted).slice(0, limit).map((c) => c.date);
}
