// WHICH COMPLETED SESSION THE BOARD IS ALLOWED TO CALL "LATEST".
//
// ⚠️ THE DEFECT THIS EXISTS TO PREVENT. The board used to take `max(date)` across the whole candle
// table as its `asOf`. That is not "the latest completed session" — it is "the first ticker of the
// next session has arrived", and during the nightly EOD ingest those are wildly different facts.
//
// Measured in production on 2026-09-22:
//
//     2026-09-22 candles:     42 tickers      ← the ingest had barely started
//     2026-09-21 candles: 12,191 tickers      ← the genuinely complete session
//
// `max(date)` returned 2026-09-22, so the whole Top 500 tried to measure against a session almost
// nothing had a print on. Result: measured 6, unmeasured 494 — a 99% blank board, served to
// customers, for as long as the ingest took to finish. It self-healed, which is exactly what made
// it easy to miss.
//
// ⚠️ THE RULE IS A QUORUM, AND ITS DENOMINATOR IS THE PREVIOUS SESSION — NOT THE UNIVERSE.
//
// A fixed fraction of the universe ("95% of 500") looks equivalent and is strictly worse, because
// it has to be calibrated against how many securities are LEGITIMATELY missing, and that number
// drifts every time something delists. Set it too low and a partial ingest slips through; set it
// too high and one extra delisting freezes the board at yesterday FOREVER, which is a far worse
// failure than the one being fixed.
//
// Comparing a candidate session against the previous session's own coverage is self-calibrating:
// a security that was missing yesterday is not required today, so the gate measures the only thing
// that actually matters — did roughly the same set of securities that printed last session print
// this one. Delistings cost nothing. A stalled ingest is caught immediately.
//
// Pure: no database, no clock, no network. The caller supplies the coverage counts.

import { isTradingDay } from '../market/market-session.mjs';
import { asDay } from './heatmap-window.mjs';

/**
 * HOW MUCH OF THE PREVIOUS SESSION'S COVERAGE A NEW SESSION MUST REPRODUCE.
 *
 * ⚠️ MEASURED, NOT CHOSEN. Across 398 consecutive settled sessions of the real Top 500 universe
 * (2025-02-19 → 2026-09-21), the day-over-day coverage ratio was:
 *
 *     min 99.20%   p1 100.00%   median 100.00%   max 118.03%
 *
 * The single worst legitimate session in nineteen months reproduced 99.20% of the day before
 * (496/500 — four securities that had stopped printing). The partial ingest this guards against
 * scored 1.21% (6/496). There is a ~98-point gap between the two populations, so the threshold is
 * not a close call; what it has to do is sit far enough below the legitimate floor that normal
 * churn never trips it.
 *
 * 95% leaves 4.2 points — about 21 securities out of 500 free to vanish overnight — and still
 * demands the board be essentially complete before it advances. Verified against all 398 sessions:
 * ZERO would have stalled at 95%, and today's 42-row partial is blocked.
 *
 * Deliberately NOT tighter. 99% would also have passed all 398, with 0.2 points of margin — a
 * single extra delisting. The asymmetry decides it: too loose shows a slightly incomplete board
 * for a few minutes, too tight strands the board on a stale session indefinitely.
 */
export const SESSION_QUORUM = 0.95;

/** Why a candidate session was not promoted — reported, never silent. */
export const SESSION_REJECT = Object.freeze({
  NOT_TRADING_DAY: 'not_trading_day',   // a candle stamped on a weekend or holiday: vendor artifact
  BELOW_QUORUM: 'below_quorum',         // the EOD ingest for that session has not finished
});

/**
 * THE CANONICAL COMPLETED SESSION, given per-session coverage of the heatmap universe.
 *
 * @param coverage  [{ date, count }] — how many of the heatmap's OWN universe have a candle on that
 *                  session. Any order; sorted here. `count` is coverage of the universe, never a
 *                  global row count: a market-wide `count(*) > 10000` would be a magic number
 *                  calibrated against securities this board does not draw.
 * @returns { date, count, previousDate, previousCount, ratio, rejected }
 *          `date` is the session the board may use. `rejected` lists the newer sessions that were
 *          held back and why, so the state is observable rather than inferred from a blank board.
 */
export function canonicalSession(coverage = []) {
  const out = { date: null, count: 0, previousDate: null, previousCount: 0, ratio: null, rejected: [] };

  // ⚠️ A SESSION IS A SESSION THE EXCHANGE HELD, and the only evidence that one occurred is a
  // candle — never the calendar. Nothing here invents a session for a date with no data, which is
  // why weekends and holidays need no special case: they carry no rows and never become candidates.
  //
  // The calendar runs in the opposite direction, as a veto: a candle stamped on a Saturday or a
  // holiday is bad vendor data, and promoting the board to it would roll the session over to a day
  // the market never opened. (Zero such dates across 400 sessions of production data — this is a
  // guard against a bad feed, not a correction to the current one.)
  const sessions = (coverage || [])
    .map((c) => ({ date: asDay(c?.date), count: Number(c?.count) || 0 }))
    .filter((c) => c.date && c.count > 0)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!sessions.length) return out;

  const usable = [];
  for (const s of sessions) {
    if (isTradingDay(s.date)) usable.push(s);
    else out.rejected.push({ date: s.date, count: s.count, reason: SESSION_REJECT.NOT_TRADING_DAY });
  }
  if (!usable.length) return out;

  // ⚠️ THE FIRST SESSION IN OUR HISTORY CANNOT BE GATED — there is nothing to compare it against,
  // and refusing to show a board at all is not an improvement on showing the only one we have.
  if (usable.length === 1) {
    return { ...out, date: usable[0].date, count: usable[0].count, ratio: null };
  }

  // Walk newest → oldest and take the first session that reproduces its predecessor's coverage.
  // Normally that is the newest one; during an ingest it is the previous complete session, which is
  // precisely the board customers were already looking at a minute ago.
  for (let i = 0; i < usable.length - 1; i++) {
    const cand = usable[i];
    const prev = usable[i + 1];
    const ratio = prev.count > 0 ? cand.count / prev.count : 0;
    if (ratio >= SESSION_QUORUM) {
      return { date: cand.date, count: cand.count, previousDate: prev.date, previousCount: prev.count, ratio, rejected: out.rejected };
    }
    out.rejected.push({ date: cand.date, count: cand.count, previousCount: prev.count, ratio, reason: SESSION_REJECT.BELOW_QUORUM });
  }

  // Every candidate was short. Fall back to the OLDEST session we fetched, which is complete by
  // construction — it was the canonical board before any of this arrived.
  const last = usable[usable.length - 1];
  return { date: last.date, count: last.count, previousDate: null, previousCount: 0, ratio: null, rejected: out.rejected };
}
