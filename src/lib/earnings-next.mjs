// NEXT EARNINGS — when this issuer will next report, and whether we actually know or are guessing.
//
// PURE. Dates in, a decision out. No database, no network, no clock except the one passed in.
//
// ── ⚠️ THE BUG THIS REPLACES ────────────────────────────────────────────────
//
// The old estimator took ONE median gap across a sequence of 10-Q and 10-K FILING dates and then
// rolled it forward `while (t < Date.now())`. Both halves are wrong, and together they produced a
// date a quarter late.
//
// Micron, 2026-09-30, is the worked example. Its filing cadence is a perfectly regular cycle —
// 76, 91, 98, 99 days — because the gap depends on WHICH quarter is next: the annual 10-K gets
// longer, the quarter after it is short. The median of that cycle is 92, an interval MU has never
// actually taken. Applied to a Q3→Q4 transition that has run 99, 99 and 98 days, it projected
// 2026-09-25 — five days in the past. The roll-forward then read "my estimate is in the past" as
// "that quarter must already have been reported", added another 92 days, and printed
// **2026-12-26** — skipping MU's still-unreported fiscal Q4 entirely. MU announced that quarter
// the same day the page was showing December.
//
// ⚠️ SO THE RULE IS: A PROJECTION THAT HAS PASSED MEANS THE REPORT IS DUE, NOT THAT IT HAPPENED.
// Only an actual observed announcement may advance the cycle. `imminent` carries that state out to
// the UI so a passed estimate is never re-printed as a future date, and never skipped.
//
// ── WHAT GOVERNS AN EARNINGS DATE ───────────────────────────────────────────
//
// Companies report on a fiscal rhythm, not a 91-day metronome. Two regularities beat the gap
// between consecutive events, and both are used:
//
//   YEAR-OVER-YEAR — a company reports its Q3 within days of when it reported Q3 last year, usually
//   on the same weekday. 364 days is exactly 52 weeks, so anchoring a year back keeps the weekday.
//
//   PERIOD END + LAG — the fiscal quarter END is fixed by the issuer's own calendar, so "next period
//   end plus this issuer's usual reporting lag" rests on the one date here that is not itself a guess.
//
// Each basis is scored against THIS issuer's own past events, using only information that preceded
// the event being scored, and the better one wins.
//
// ── MEASURED, WALK-FORWARD, NO LEAKAGE ──────────────────────────────────────
//
// scripts/earnings-backtest.mjs, 12,125 predictions over 300 stratified issuers. Every prediction of
// event k uses events 0..k-1 only, with "now" pinned to the day after event k-1.
//
//                    exact    <=1d    <=3d    <=7d   median  p90
//   old (shipped)    27.0%   36.8%   43.2%   61.9%      6d   28d
//   this module      34.1%   46.9%   55.6%   81.9%      2d   14d
//
// ── ⚠️ AND IT IS STILL AN ESTIMATE ──────────────────────────────────────────
//
// SEC filings are retrospective: EDGAR states when a company DID report, never when it WILL. No
// amount of modelling turns that into a confirmed calendar entry, so nothing here may be labelled
// confirmed. `basis: 'confirmed'` is reachable only from a source that actually schedules the event —
// a licensed calendar feed, or an Item 2.02 that has already been filed today.

const DAY = 86_400_000;
const d2ms = (s) => Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`);
const ms2d = (ms) => new Date(ms).toISOString().slice(0, 10);
const dow = (s) => new Date(d2ms(s)).getUTCDay();
const startOfDay = (ms) => d2ms(new Date(ms).toISOString().slice(0, 10));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ── US market holidays, COMPUTED rather than listed, so this cannot go stale ─────────────────────
function easter(y) {                                   // anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - dd - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}
const nthDow = (y, m, weekday, n) => {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return Date.UTC(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
};
const lastDow = (y, m, weekday) => {
  const last = new Date(Date.UTC(y, m + 1, 0));
  return Date.UTC(y, m + 1, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
};
const observed = (ms) => {
  const w = new Date(ms).getUTCDay();
  if (w === 6) return ms - DAY;
  if (w === 0) return ms + DAY;
  return ms;
};
const holidayCache = new Map();
function holidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const set = new Set([
    observed(Date.UTC(year, 0, 1)),        // New Year's Day
    nthDow(year, 0, 1, 3),                 // MLK — 3rd Monday of January
    nthDow(year, 1, 1, 3),                 // Washington's Birthday — 3rd Monday of February
    easter(year) - 2 * DAY,                // Good Friday
    lastDow(year, 4, 1),                   // Memorial Day — last Monday of May
    observed(Date.UTC(year, 5, 19)),       // Juneteenth
    observed(Date.UTC(year, 6, 4)),        // Independence Day
    nthDow(year, 8, 1, 1),                 // Labor Day — 1st Monday of September
    nthDow(year, 10, 4, 4),                // Thanksgiving — 4th Thursday of November
    observed(Date.UTC(year, 11, 25)),      // Christmas
  ]);
  holidayCache.set(year, set);
  return set;
}
export const isMarketClosed = (ms) => {
  const w = new Date(ms).getUTCDay();
  if (w === 0 || w === 6) return true;
  return holidays(new Date(ms).getUTCFullYear()).has(ms);
};

/**
 * Move a projection onto a day the market is open, preferring the weekday this issuer habitually
 * reports on. A weekend landing is not a coin flip — it means the Friday or the Monday, and which
 * one is the company's own habit. The old estimator had no such step: 6.7% of its live estimates
 * fell on a Saturday or Sunday, which no filing ever does.
 */
function settle(ms, preferredDow) {
  if (!isMarketClosed(ms) && (preferredDow == null || new Date(ms).getUTCDay() === preferredDow)) return ms;
  let fallback = null;
  for (let delta = 0; delta <= 4; delta++) {
    for (const cand of delta === 0 ? [ms] : [ms - delta * DAY, ms + delta * DAY]) {
      if (isMarketClosed(cand)) continue;
      if (preferredDow == null || new Date(cand).getUTCDay() === preferredDow) return cand;
      if (fallback == null) fallback = cand;
    }
  }
  return fallback ?? ms;
}

/** The event nearest a target date, or null when nothing is close enough. */
function nearest(dates, targetMs, slackDays) {
  let best = null, bestGap = Infinity;
  for (const d of dates) {
    const gap = Math.abs(d2ms(d) - targetMs);
    if (gap < bestGap) { bestGap = gap; best = d; }
  }
  return best != null && bestGap <= slackDays * DAY ? best : null;
}

/** This issuer's typical gap between announcements, from recent history only. */
function typicalGap(past) {
  const gaps = [];
  for (let i = 1; i < past.length; i++) {
    const g = (d2ms(past[i]) - d2ms(past[i - 1])) / DAY;
    if (g > 45 && g < 200) gaps.push(g);
  }
  return gaps.length ? median(gaps.slice(-6)) : null;
}

/**
 * How far this issuer's calendar has moved, year over year. Each event is paired with the one
 * nearest a year before it BY DATE, never by position: an 8-K/A, a revenue pre-release or a 53-week
 * fiscal year all break "four events back", and counting silently shifts quarters.
 */
function yoyDrift(past) {
  const drifts = [];
  for (const d of past) {
    const mate = nearest(past.filter((e) => d2ms(e) < d2ms(d)), d2ms(d) - 364 * DAY, 35);
    if (mate) drifts.push((d2ms(d) - d2ms(mate)) / DAY - 364);
  }
  return { drift: drifts.length >= 2 ? median(drifts.slice(-6)) : 0, drifts };
}

/** BASIS 1 — the same fiscal quarter a year back, plus however far the calendar has drifted. */
function basisYoy(past) {
  const gap = typicalGap(past) ?? 91;
  const lastMs = d2ms(past[past.length - 1]);
  const dueMs = lastMs + Math.round(gap) * DAY;
  const yearAgo = nearest(past, dueMs - 364 * DAY, 35);
  if (!yearAgo) return null;
  const ms = d2ms(yearAgo) + 364 * DAY + Math.round(yoyDrift(past).drift) * DAY;
  return ms > lastMs ? ms : null;
}

/** BASIS 2 — the next fiscal period end, plus the lag this issuer usually takes to report it. */
function basisPeriodLag(past, periods) {
  if (!periods || periods.length < 5) return null;
  const ends = periods.map((p) => p.period).filter(Boolean).sort();
  if (ends.length < 5) return null;

  const lags = [];
  for (const end of ends) {
    const after = past.find((d) => d2ms(d) >= d2ms(end));
    if (!after) continue;
    const lag = (d2ms(after) - d2ms(end)) / DAY;
    if (lag >= 0 && lag <= 120) lags.push(lag);
  }
  if (lags.length < 4) return null;

  const lastEnd = ends[ends.length - 1];
  // Anchored a year back for the same reason announcements are — which also handles a 52/53-week
  // retailer, whose quarter ends shift by a day or two but keep their weekday.
  const priorYear = nearest(ends, d2ms(lastEnd) + 91 * DAY - 364 * DAY, 35);
  const nextEndMs = priorYear ? d2ms(priorYear) + 364 * DAY : d2ms(lastEnd) + 91 * DAY;
  if (nextEndMs <= d2ms(lastEnd)) return null;
  return nextEndMs + Math.round(median(lags.slice(-4))) * DAY;
}

/** The weekday this issuer reports on, when it has a real habit rather than a coincidence. */
function preferredWeekday(past) {
  const counts = new Map();
  for (const d of past.slice(-8)) counts.set(dow(d), (counts.get(dow(d)) || 0) + 1);
  let best = null, bestN = 0;
  for (const [w, n] of counts) if (n > bestN) { bestN = n; best = w; }
  return bestN >= 4 ? best : null;
}

/**
 * Estimate the next earnings-announcement date from this issuer's own history.
 *
 * @param {string[]} history announcement dates 'YYYY-MM-DD' ascending (Item 2.02 event dates), or
 *                           10-Q/10-K filing dates when no announcement history exists.
 * @param {number}   asOfMs  "now" — only history strictly before this may be used.
 * @param {object}   opts    { periods: [{ period:'YYYY-MM-DD' }] } fiscal period ends, optional.
 */
export function estimateNext(history, asOfMs = Date.now(), opts = {}) {
  const past = (history || []).filter((d) => d && d2ms(d) < asOfMs).sort();
  if (past.length < 3) return null;
  const periods = (opts.periods || []).filter((p) => p.period && d2ms(p.period) < asOfMs);
  const lastEventMs = d2ms(past[past.length - 1]);

  const candidates = { yoy: basisYoy(past), 'period-lag': basisPeriodLag(past, periods) };

  // Each basis re-predicts the last few KNOWN events from what preceded them. Nothing from the event
  // being predicted is used, so this is selection on own history, not leakage.
  const scoreOf = (name) => {
    const errs = [];
    for (let i = Math.max(5, past.length - 8); i < past.length; i++) {
      const hist = past.slice(0, i);
      const ps = periods.filter((p) => d2ms(p.period) < d2ms(past[i]));
      const ms = name === 'yoy' ? basisYoy(hist) : basisPeriodLag(hist, ps);
      if (ms != null) errs.push(Math.abs((ms - d2ms(past[i])) / DAY));
    }
    return errs.length >= 3 ? median(errs) : null;
  };

  let basis = null, anchorMs = null;
  const scored = Object.entries(candidates)
    .filter(([, ms]) => ms != null)
    .map(([name, ms]) => ({ name, ms, score: scoreOf(name) }));

  if (!scored.length) {
    const gap = typicalGap(past);
    if (gap == null) return null;
    let ms = lastEventMs + Math.round(gap) * DAY;
    // ⚠️ ROLL FORWARD ONLY PAST EVENTS WE HAVE ACTUALLY OBSERVED — never past `now`.
    //
    // This is the exact line that produced MU's December date. `while (ms < now)` treats a projection
    // that has merely elapsed as one that has been fulfilled, and every extra cycle skips a real
    // unreported quarter. The only evidence a cycle completed is an announcement in `past`, and the
    // anchor already starts after the newest of those — so there is nothing left to roll past.
    while (ms <= lastEventMs) ms += Math.round(gap) * DAY;
    anchorMs = ms;
    basis = 'cadence';
  } else {
    const ranked = [...scored].sort((a, b) => (a.score ?? 99) - (b.score ?? 99));
    anchorMs = ranked[0].ms;
    basis = ranked[0].name;
  }

  const settled = settle(anchorMs, preferredWeekday(past));
  const { drifts } = yoyDrift(past);
  const spread = drifts.length >= 3
    ? Math.round(median(drifts.slice(-6).map((x) => Math.abs(x))) * 1.5)
    : null;

  return {
    date: ms2d(settled),
    basis,
    spreadDays: spread,
    observations: past.length,
    // ⚠️ THE PROJECTION HAS PASSED AND NOTHING HAS BEEN ANNOUNCED. The report is DUE — it did not
    // silently happen, and the cycle must not advance. The UI says "expected now" rather than
    // printing a stale date as though it were still ahead.
    imminent: d2ms(ms2d(settled)) <= startOfDay(asOfMs),
  };
}


/**
 * THE PRODUCT DECISION: what do we tell the reader, and how sure are we?
 *
 * @param {object} o
 * @param {Array}  o.announcements  [{ event, filed }] Item 2.02 8-Ks, ascending. The real
 *                                  announcement dates — this is what "earnings date" means.
 * @param {Array}  o.periodic       [{ filed, form, period }] 10-Q/10-K. Fallback series + period ends.
 * @param {object} o.scheduled      A licensed-calendar row for this ticker, { date, time } or null.
 * @param {number} o.now
 *
 * @returns {{date, basis, method, spreadDays, imminent, observations, series}|null}
 *
 * ⚠️ `basis` IS THE HONESTY FIELD AND ONLY TWO THINGS MAY SET IT TO 'confirmed':
 *   1. a licensed calendar that actually schedules the event, or
 *   2. an Item 2.02 already filed for today — the company has reported, so the date is a fact.
 * Everything modelled is 'estimated'. EDGAR is retrospective; it cannot confirm a future date.
 */
export function resolveNextEarnings({ announcements = [], periodic = [], scheduled = null, now = Date.now() } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);

  // 1 ── A CONFIRMED SCHEDULE WINS OUTRIGHT. A calculated date never overrides a stated one.
  if (scheduled?.date && d2ms(scheduled.date) >= startOfDay(now)) {
    return {
      date: String(scheduled.date).slice(0, 10),
      basis: 'confirmed',
      method: 'licensed-calendar',
      time: scheduled.time || null,
      spreadDays: 0,
      imminent: String(scheduled.date).slice(0, 10) === today,
      observations: null,
      series: 'calendar',
    };
  }

  const annEvents = (announcements || []).map((a) => a?.event || a?.filed).filter(Boolean).sort();

  // 2 ── ALREADY ANNOUNCED TODAY. The 8-K exists, so this is not a projection any more.
  if (annEvents.length && annEvents[annEvents.length - 1] === today) {
    return {
      date: today, basis: 'confirmed', method: 'sec-8k-item-202',
      spreadDays: 0, imminent: true, observations: annEvents.length, series: 'item-2.02',
    };
  }

  // 3 ── ESTIMATE. Announcement history is the right series and is preferred whenever it is deep
  // enough to model a year-over-year anchor; 10-Q/10-K filing dates are the fallback, and they run
  // LATE of the announcement by a median of 5 days (p10 0, p90 24 over 2,472 measured pairs).
  const useAnn = annEvents.length >= 4;
  const series = useAnn ? annEvents : (periodic || []).map((p) => p?.filed).filter(Boolean).sort();
  const est = estimateNext(series, now, { periods: periodic });
  if (!est) return null;
  return {
    ...est,
    basis: 'estimated',
    method: est.basis,
    series: useAnn ? 'item-2.02' : 'periodic',
  };
}

/**
 * Back-compatible shim for the two existing callers that pass `[{ report_date }]` and want a bare
 * date string. Same inputs, same return type — but no longer able to skip an unreported quarter.
 */
export function estimateNextEarnings(rows) {
  const periodic = (rows || [])
    .map((r) => ({ filed: r?.report_date, form: r?.form || null, period: r?.period_end || null }))
    .filter((p) => p.filed);
  return resolveNextEarnings({ periodic })?.date ?? null;
}
