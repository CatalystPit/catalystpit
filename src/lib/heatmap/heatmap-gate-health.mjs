// IS THE HEATMAP HOLDING BECAUSE THE INGEST IS RUNNING, OR BECAUSE IT DIED?
//
// The rollover gate (heatmap-session.mjs) keeps the board on the previous completed session until
// a candidate reproduces 95% of its coverage. That is correct and must stay correct — but it also
// means a DEAD EOD ingest looks exactly like a healthy one that has not finished: in both cases
// `asOf` simply stops moving. This file is the difference between those two, and nothing more.
//
// ⚠️ IT CAN ONLY OBSERVE. Nothing here promotes a session, relaxes a quorum or writes a board.
// SESSION_QUORUM is IMPORTED rather than restated so there is no second copy of the threshold that
// could drift from the one the board enforces, and so a reader can see that monitoring has no
// opinion about it. A prolonged hold is reported; it is never resolved by lowering the bar.
//
// ── WHY THE TRIGGER IS NOT `sessionGate.held` ───────────────────────────────
//
// `held` is the obvious thing to watch and it is the WRONG thing to watch, because the worst
// failure does not produce one. Measured against the real rule:
//
//     6 rows arrive for the new session   → canonical 09-21, held ['2026-09-22']
//     0 rows arrive for the new session   → canonical 09-21, held []
//
// A total ingest failure — the loader never ran, the vendor returned nothing, the key expired —
// leaves no candidate date at all, so there is nothing to hold and `held` is empty. Watching it
// would have alerted on the mild case and stayed silent on the catastrophic one.
//
// So the condition is "the board's session is BEHIND the session whose data should have loaded by
// now", which is true in both cases. `held` and its coverage numbers are carried along as
// DIAGNOSIS — they say which of the two it is — but they are not the trigger.

import { isTradingDay, previousTradingDay } from '../market/market-session.mjs';
import { SESSION_QUORUM } from './heatmap-session.mjs';
import { asDay } from './heatmap-window.mjs';

/**
 * WHEN SESSION S's EOD DATA IS ACTUALLY DUE.
 *
 * ⚠️ READ OFF THE REAL CRON, AND IT IS IN UTC. The bulk loader is `/api/cron/screener`, scheduled
 * `30 8 * * *` in vercel.json, which reaches screener-data.js step 4b: polygonEod() fetches
 * Polygon's grouped-daily starting at `now - 1 day` and step 4b writes those bars into
 * ticker_daily_candles. So session S is loaded by the run on the NEXT CALENDAR DAY at 08:30 UTC —
 * every day, including Saturday, which is what lands Friday's session.
 *
 * ⚠️ THE SCHEDULE IS UTC AND THEREFORE DRIFTS AGAINST ET: 08:30 UTC is 04:30 ET in summer and
 * 03:30 ET in winter. The deadline is kept in UTC for exactly that reason — expressing it in ET
 * would make it an hour early or late for half the year, which is how a monitor starts crying wolf
 * every November.
 */
export const EOD_INGEST_CRON_UTC_MIN = 8 * 60 + 30;   // "30 8 * * *" → /api/cron/screener

/**
 * HOW LATE IS STILL NORMAL.
 *
 * The run is market-wide: a grouped-daily fetch plus ~12,000 rows inserted in batches of 500, and
 * it shares the same invocation as the whole screener rebuild. Four hours is far more than it
 * needs and is chosen for where it LANDS rather than for how long the job takes — 12:30 UTC is
 * 08:30 ET in summer and 07:30 ET in winter, so in both halves of the year the alert fires before
 * the opening bell and there is time to act on it.
 *
 * ⚠️ GENEROUS ON PURPOSE. The cost of alerting late is a stale board for one morning; the cost of
 * alerting early is an alarm that goes off during every ordinary ingest, which trains everyone to
 * ignore it and is indistinguishable from having no monitoring at all.
 */
export const EOD_INGEST_GRACE_MIN = 4 * 60;

/** The instant session S's data stops being "on its way" and starts being late. */
export const EOD_DEADLINE_UTC_MIN = EOD_INGEST_CRON_UTC_MIN + EOD_INGEST_GRACE_MIN;   // 12:30 UTC

const DAY_MS = 86_400_000;

/** Epoch ms for the deadline by which session `sessionDate` must have loaded. */
export function ingestDeadlineMs(sessionDate) {
  const day = asDay(sessionDate);
  if (!day) return null;
  const [y, m, d] = day.split('-').map(Number);
  // The NEXT calendar day at the deadline minute, UTC.
  return Date.UTC(y, m - 1, d) + DAY_MS + EOD_DEADLINE_UTC_MIN * 60_000;
}

/**
 * THE MOST RECENT SESSION WHOSE EOD DATA SHOULD ALREADY BE LOADED.
 *
 * ⚠️ NOT "the last session that closed". Between Tuesday's closing bell and Wednesday lunchtime
 * UTC, Tuesday's candles legitimately do not exist yet and the board is CORRECTLY showing Monday.
 * Treating that ordinary overnight window as a fault is the single easiest way to make this
 * monitor useless, so the expected session walks back until it finds one whose deadline has passed.
 *
 * Weekends and holidays need no special case: previousTradingDay() walks the real NYSE calendar,
 * so on a Sunday the expected session is Friday — whose data was due Saturday — and nothing about
 * the market being shut reads as a missing ingest.
 */
export function expectedSessionDate(now = Date.now()) {
  const t = new Date(now);
  let day = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  if (!isTradingDay(day)) day = previousTradingDay(day, { inclusive: false });
  // Walk back to the newest session that is genuinely due. Bounded: a fortnight is longer than any
  // market closure in modern history, so failing to find one means something far larger is wrong.
  for (let i = 0; i < 15 && day; i++) {
    const due = ingestDeadlineMs(day);
    if (due != null && now >= due) return day;
    day = previousTradingDay(day, { inclusive: false });
  }
  return null;
}

/** What state the rollover is in. Only `stale_ingest` is a fault. */
export const ROLLOVER = Object.freeze({
  CURRENT: 'current',                 // the board is on the session it should be on
  AWAITING_INGEST: 'awaiting_ingest', // a newer session is loading and is not late yet — NORMAL
  STALE_INGEST: 'stale_ingest',       // ⚠️ the expected session's data never arrived
  UNKNOWN: 'unknown',                 // no canonical session at all — a different, louder problem
});

/**
 * THE VERDICT, plus everything needed to diagnose it without opening a database.
 *
 * @param canonical  the object `canonicalSessionDate()` returns — the SAME value the board built
 *                   itself from, not a re-derivation of it. Passing the board's own state is what
 *                   keeps this from becoming a second opinion that can disagree with the first.
 */
export function assessRollover({ canonical = null, now = Date.now() } = {}) {
  const expected = expectedSessionDate(now);
  const canonicalDate = asDay(canonical?.date) || null;

  // The newest session being held back, with the numbers that explain why.
  const blocked = (canonical?.rejected || []).filter((r) => r.reason === 'below_quorum');
  const candidate = blocked.length ? blocked[0] : null;
  const previousCoverage = candidate?.previousCount ?? canonical?.count ?? null;
  const required = previousCoverage != null ? Math.ceil(previousCoverage * SESSION_QUORUM) : null;

  const out = {
    state: ROLLOVER.UNKNOWN,
    ok: false,
    canonicalSession: canonicalDate,
    expectedSession: expected,
    // ⚠️ THE CANDIDATE MAY BE ABSENT EVEN WHEN SOMETHING IS BADLY WRONG — that is the whole reason
    // this file does not trigger on `held`. A null candidate beside a stale_ingest state means NO
    // rows arrived at all, which is a more serious failure than a partial one, not a lesser one.
    candidateSession: candidate?.date ?? null,
    candidateCoverage: candidate?.count ?? null,
    previousCoverage,
    requiredCoverage: required,
    quorum: SESSION_QUORUM,
    ratio: candidate?.ratio ?? null,
    held: blocked.map((r) => r.date),
    overdueHours: null,
    universeNote: 'coverage counts are of the heatmap universe, not the whole candle table',
  };

  if (!canonicalDate || !expected) {
    out.ok = !expected && Boolean(canonicalDate);   // no expected session yet is not a fault
    out.state = canonicalDate ? ROLLOVER.CURRENT : ROLLOVER.UNKNOWN;
    return out;
  }

  if (canonicalDate >= expected) {
    // On the expected session, or ahead of it because today's data landed early. A candidate may
    // still be held — that is the ordinary overnight state and is explicitly not a fault.
    out.state = candidate ? ROLLOVER.AWAITING_INGEST : ROLLOVER.CURRENT;
    out.ok = true;
    return out;
  }

  // ⚠️ THE FAULT. The deadline for `expected` has passed and the board is still behind it.
  const due = ingestDeadlineMs(expected);
  out.state = ROLLOVER.STALE_INGEST;
  out.ok = false;
  out.overdueHours = due == null ? null : Math.round(((now - due) / 3.6e6) * 10) / 10;
  return out;
}

/**
 * One line, structured, for the runtime log — the thing a human actually reads at 07:30.
 *
 * ⚠️ IT STATES THE COVERAGE AND THE BAR, because "the heatmap is stuck" is not actionable and
 * "42 of a required 472" says immediately whether the loader failed outright or ran and returned
 * almost nothing.
 */
export function rolloverLogLine(a) {
  const parts = [
    `state=${a.state}`,
    `canonical=${a.canonicalSession}`,
    `expected=${a.expectedSession}`,
    a.overdueHours != null ? `overdueHours=${a.overdueHours}` : null,
    a.candidateSession ? `candidate=${a.candidateSession}` : 'candidate=none',
    a.candidateCoverage != null ? `candidateCoverage=${a.candidateCoverage}` : null,
    a.previousCoverage != null ? `previousCoverage=${a.previousCoverage}` : null,
    a.requiredCoverage != null ? `requiredCoverage=${a.requiredCoverage}` : null,
    a.ratio != null ? `ratio=${(a.ratio * 100).toFixed(2)}%` : null,
    `quorum=${(a.quorum * 100).toFixed(0)}%`,
  ].filter(Boolean);
  return parts.join(' ');
}
