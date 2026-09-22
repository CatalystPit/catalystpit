// MARKET-WIDE TOP GAINERS / TOP LOSERS — the eligibility and ranking rules, as pure functions.
//
// ⚠️ THIS IS NOT THE HEATMAP UNIVERSE, AND THAT SEPARATION IS THE POINT. The heatmap answers "what
// does the market look like", weighted by size, over the Top 500. These lists answer a different
// question — "what is moving most today" — and the honest answer to it is usually a small-cap
// nobody has heard of. Measured on 2026-09-22, ALL TEN of the true top gainers were outside the
// Top 500: JAGX +388%, LHSW +105%, GRML +70%. A "Top Gainers" built from heatmap rows cannot
// surface any of them, and its top entry (+7.9%) is not the day's biggest move by a factor of 49.
//
// ── WHY THE VENDOR'S prevClose IS NOT THE BASELINE ──────────────────────────
//
// The market-wide snapshot (`GET /iex`) carries a `prevClose` per row, and using it would be the
// obvious implementation. It is wrong, measured:
//
//     ticker   our split-adjusted Sep 21 close   Tiingo /iex prevClose   ratio
//     CBIO                              16.25                   0.157   103.50
//     VWAV                              6.202                  0.3101    20.00
//     LITZ                               25.2                     6.3     4.00
//     SMU                               20.12                    5.03     4.00
//     QBTX                               26.2                    6.55     4.00
//     AXTX                              37.64                    9.41     4.00
//
// Those exact integers are REVERSE SPLITS: the snapshot's `prevClose` is not split-adjusted, while
// `ticker_daily_candles` is (`tiingo_split_adj`). Ranked on the vendor field, CBIO leads Top
// Gainers at +10,377% on a day it actually moved +1.23%, and a reader would act on it.
//
// So the numerator is the vendor's current price and the denominator is OUR stored split-adjusted
// close for ONE named session. Every row in a ranking divides by a close from the same date, which
// is what "the same baseline for every security" has to mean to be checkable.

/**
 * WHAT THE CARD SUBTITLE SHOULD SAY — the decision, separated from the formatting.
 *
 * ⚠️ IT SAYS HOW CURRENT THE LIST IS AND NOTHING ELSE. An earlier version read "Market-wide · from
 * the Sep 21, 2026 close · updated 1:33 PM ET", which explained the baseline to a reader who had
 * not asked and buried the one fact they came for. The card title already says what the list is;
 * the methodology belongs on the info icon.
 *
 * ⚠️ AND IT NEVER SAYS "LIVE" OR "REAL-TIME". The board is a periodic snapshot of a real-time
 * source, so "Updated <time>" is the honest phrasing: it states an instant rather than promising a
 * ticker. Once the session is frozen or settled the time stops being the point — the SESSION is —
 * so it becomes "Final · <date>".
 *
 * @returns { kind: 'updated', at } | { kind: 'final', date } | null
 */
export function moversNoteState(movers) {
  if (!movers) return null;
  const frozen = Boolean(movers.session?.frozen);
  if (movers.freshness === 'realtime' && !frozen) {
    return { kind: 'updated', at: movers.snapshotAt ?? null };
  }
  // The session the rankings actually represent: the frozen one after the bell, otherwise the
  // latest completed session the board was built from.
  return { kind: 'final', date: (frozen ? (movers.session?.sessionDate || movers.asOf) : movers.asOf) ?? null };
}

/** A row is only rankable if BOTH halves of the fraction are trustworthy. */
export const MOVER_REJECT = Object.freeze({
  NOT_ELIGIBLE: 'not_eligible',     // not a Stock/ADRC per the security master
  NO_BASELINE: 'no_baseline',       // no split-adjusted close for the baseline session
  NO_PRICE: 'no_price',             // no usable current price
  STALE: 'stale',                   // the print predates this session: yesterday's move, not today's
});

/**
 * Is this quote a print from the session we are ranking?
 *
 * ⚠️ WITHOUT THIS THE LIST IS 77% RUBBISH. The market-wide snapshot returns every symbol Tiingo has
 * ever carried — 42,590 rows, of which 32,327 had timestamps YEARS old (one lagging 7.6 years).
 * Their last print sits against a sub-penny baseline, so the raw ranking's top entry was
 * +33,333,233%. A delisted shell is not the day's biggest gainer; it is not trading at all.
 */
export function isSessionPrint(timestamp, sessionOpenMs) {
  if (!timestamp || !Number.isFinite(sessionOpenMs)) return false;
  const t = Date.parse(timestamp);
  return Number.isFinite(t) && t >= sessionOpenMs;
}

/**
 * Rank the market.
 *
 * @param quotes    [{ ticker, tngoLast, timestamp }] — the vendor's market-wide snapshot
 * @param baselines Map<ticker, number> — OUR split-adjusted close for `baselineDate`, eligible
 *                  symbols only. Membership IS the eligibility gate: a symbol absent from this map
 *                  is either not a Stock/ADRC or has no trustworthy close, and either way cannot be
 *                  ranked. That keeps classification in the security master instead of in a
 *                  symbol-shape heuristic here.
 * @returns { gainers, losers, counts, baselineDate }
 */
export function rankMovers(quotes, baselines, { sessionOpenMs, baselineDate = null, limit = 10 } = {}) {
  const counts = { considered: 0, ranked: 0, [MOVER_REJECT.NOT_ELIGIBLE]: 0, [MOVER_REJECT.NO_BASELINE]: 0, [MOVER_REJECT.NO_PRICE]: 0, [MOVER_REJECT.STALE]: 0 };
  const rows = [];

  for (const q of quotes || []) {
    counts.considered += 1;
    const ticker = String(q?.ticker || '').toUpperCase().trim();
    if (!ticker) { counts[MOVER_REJECT.NOT_ELIGIBLE] += 1; continue; }

    const base = baselines?.get ? baselines.get(ticker) : undefined;
    if (base == null) { counts[MOVER_REJECT.NO_BASELINE] += 1; continue; }
    if (!Number.isFinite(Number(base)) || Number(base) <= 0) { counts[MOVER_REJECT.NO_BASELINE] += 1; continue; }

    const price = Number(q.tngoLast);
    // ⚠️ `q.tngoLast != null` matters: Number(null) is 0 and 0 is finite, so a null price would
    // otherwise rank as a −100% loser — the most alarming number on the page, from a missing value.
    if (q.tngoLast == null || !Number.isFinite(price) || price <= 0) { counts[MOVER_REJECT.NO_PRICE] += 1; continue; }

    if (!isSessionPrint(q.timestamp, sessionOpenMs)) { counts[MOVER_REJECT.STALE] += 1; continue; }

    counts.ranked += 1;
    rows.push({ ticker, price, prevClose: Number(base), pct: ((price - Number(base)) / Number(base)) * 100, baselineDate });
  }

  // Ties break on ticker so the same snapshot ranked twice gives the same list.
  const byPct = (dir) => (a, b) => dir * (a.pct - b.pct) || a.ticker.localeCompare(b.ticker);
  const n = Math.max(1, limit);
  return {
    gainers: [...rows].sort(byPct(-1)).slice(0, n),
    losers: [...rows].sort(byPct(1)).slice(0, n),
    counts,
    baselineDate,
  };
}
