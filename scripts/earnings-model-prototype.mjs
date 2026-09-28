// PROTOTYPE of the proposed earnings-date estimator. Not wired into the product — it exists to be
// backtested. PURE: dates in, a date out.
//
// ── WHY THE CURRENT ESTIMATOR IS WRONG BY CONSTRUCTION ───────────────────────
// It takes ONE median gap across a sequence that mixes 10-Q and 10-K filings. Those gaps are not
// the same length — Q3→10-K runs long because the annual report gets 60–90 days, and 10-K→Q1 runs
// short — so the "median quarterly gap" describes no real interval, and the error compounds on
// every roll-forward. Measured: within 7 days only 63%, p90 error 27 days.
//
// ── WHAT ACTUALLY GOVERNS AN EARNINGS DATE ───────────────────────────────────
// Companies report on a fiscal rhythm, not a 91-day metronome. Two regularities are far stronger
// than the gap between consecutive announcements, and this model is built on them:
//
//   YEAR-OVER-YEAR. A company reports its Q3 within days of the date it reported Q3 last year, and
//   usually on the same WEEKDAY. 364 days is exactly 52 weeks, so anchoring a year back preserves
//   the weekday for free; 365 does not.
//
//   PERIOD END + LAG. A company chooses when to announce, but its fiscal quarter END is fixed by its
//   own calendar. "The next period end, plus the lag this issuer usually takes to report" rests on
//   the one date in this problem that is not itself a guess.
//
// Both are computed, then scored against THIS issuer's own history using only events that precede
// the one being predicted, and the basis that has served this issuer better wins. Everything after
// that is correction: drift for a company whose calendar is moving, and a settle step so a
// projection never lands on a day the market is shut.
//
// Deliberately NOT modelled: BMO/AMC. Nothing in EDGAR states it, so it stays unknown.

const DAY = 86_400_000;
const d2ms = (s) => Date.parse(`${s}T00:00:00Z`);
const ms2d = (ms) => new Date(ms).toISOString().slice(0, 10);
const dow = (s) => new Date(d2ms(s)).getUTCDay();
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ── US market holidays, computed rather than listed, so the model cannot go stale ────────────────
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
const isMarketClosed = (ms) => {
  const w = new Date(ms).getUTCDay();
  if (w === 0 || w === 6) return true;
  return holidays(new Date(ms).getUTCFullYear()).has(ms);
};

/**
 * Move a projection onto a day the market is open, preferring the weekday this issuer habitually
 * reports on. A weekend landing is not a coin flip: it almost always means the Friday or the
 * Monday, and which one depends on the company's own habit.
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

/** The issuer's typical gap between announcements, from recent history only. */
function typicalGap(past) {
  const gaps = [];
  for (let i = 1; i < past.length; i++) {
    const g = (d2ms(past[i]) - d2ms(past[i - 1])) / DAY;
    if (g > 45 && g < 200) gaps.push(g);
  }
  return gaps.length ? median(gaps.slice(-6)) : null;
}

/**
 * How far this issuer's calendar has been moving, year over year. Each announcement is paired with
 * the one nearest a year before it BY DATE, never by position: an 8-K/A, a revenue pre-release or a
 * 53-week fiscal year all break "four events back", and indexing by count silently shifts quarters.
 */
function yoyDrift(past) {
  const drifts = [];
  for (const d of past) {
    const mate = nearest(past.filter((e) => d2ms(e) < d2ms(d)), d2ms(d) - 364 * DAY, 35);
    if (mate) drifts.push((d2ms(d) - d2ms(mate)) / DAY - 364);
  }
  return { drift: drifts.length >= 2 ? median(drifts.slice(-6)) : 0, drifts };
}

/** BASIS 1 — the same fiscal quarter, one year back, plus however far the calendar has drifted. */
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
  // The next period end, anchored a year back for the same reason announcements are — that also
  // handles a 52/53-week retailer, whose quarter ends move by a day or two but keep their weekday.
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
 * Estimate the next earnings-announcement date.
 *
 * @param {string[]} history  announcement dates 'YYYY-MM-DD', ascending
 * @param {number}   asOfMs   "now" — only history strictly before this may be used
 * @param {object}   opts     { periods: [{period:'YYYY-MM-DD'}] } fiscal period ends, optional
 */
export function estimateNext(history, asOfMs = Date.now(), opts = {}) {
  const past = (history || []).filter((d) => d && d2ms(d) < asOfMs).sort();
  if (past.length < 3) return null;
  const periods = (opts.periods || []).filter((p) => p.period && d2ms(p.period) < asOfMs);

  const candidates = {
    yoy: basisYoy(past),
    'period-lag': basisPeriodLag(past, periods),
  };

  // ── choose the basis on this issuer's OWN past ──────────────────────────────
  // Each basis re-predicts the last few known events from what preceded them. No information from
  // the event being predicted is used, so this is selection, not leakage.
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
    // Neither anchor is available: fall back to the recent cadence, which is still better than the
    // all-history median the old estimator uses.
    const gap = typicalGap(past);
    if (gap == null) return null;
    let ms = d2ms(past[past.length - 1]) + Math.round(gap) * DAY;
    while (ms < asOfMs) ms += Math.round(gap) * DAY;
    anchorMs = ms; basis = 'cadence';
  } else {
    const ranked = [...scored].sort((a, b) => (a.score ?? 99) - (b.score ?? 99));
    anchorMs = ranked[0].ms; basis = ranked[0].name;
  }

  const settled = settle(anchorMs, preferredWeekday(past));
  const { drifts } = yoyDrift(past);
  const spread = drifts.length >= 3
    ? Math.round(median(drifts.slice(-6).map((x) => Math.abs(x))) * 1.5)
    : null;

  return { date: ms2d(settled), basis, spreadDays: spread, observations: past.length };
}
