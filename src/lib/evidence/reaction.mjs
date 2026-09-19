// MARKET REACTION — what the stock did after evidence became public. PURE: no DB, no network.
//
// DESCRIPTIVE, NOT CAUSAL, AND NOT A FORECAST. This records what the tape did in the sessions
// following a disclosure. It does not claim the disclosure caused the move, and nothing here may be
// worded or consumed as though it did. Every label the UI uses is temporal ("after public
// disclosure"), never consequential ("impact", "result", "signal performance").
//
// ── THE ANCHOR IS THE WHOLE PROBLEM ─────────────────────────────────────────
//
// A reaction number is only honest if the price it starts from contains NO information from the
// disclosure. Anchor one session too late and the move is already in the price, so the reaction
// reads as nothing. Anchor one session too early and pre-disclosure drift is attributed to the
// filing — which is the causal claim this file exists not to make.
//
// So the rule is: ANCHOR AT THE LAST CLOSE THAT PRECEDED PUBLICATION. Horizons count trading
// sessions forward from there. By construction the anchor price cannot contain the news.
//
// ── PRECISION WE HAVE VERSUS PRECISION WE DO NOT ────────────────────────────
//
// 8-K carries a real filing timestamp (`filed_at` is timestamptz — "2026-09-15 21:38:22+00"), so
// we know whether it landed before or after the 4pm ET close and can anchor exactly.
//
// Form 4, Congress and 13F are DATE columns. We know the day and nothing more. Inventing an hour
// for them would be fabricated precision, so they use the day-level rule: the last close before
// that day. Their first horizon therefore spans the publication day itself, which is the correct
// reading of "what happened after this became public" when the day is all we know.
//
// ── WHAT IS NEVER DONE ──────────────────────────────────────────────────────
//
// No extrapolation. A horizon that has not fully elapsed returns null, never a partial return
// wearing a longer label. No return is computed across a price break (ticker reuse, an unadjusted
// reverse split) — the existing continuity data says where those are, and a return spanning one is
// a number about two different securities.

/** Trading sessions forward from the anchor. Not calendar days. */
export const HORIZONS = Object.freeze([1, 5, 20, 63]);

/** The benchmark every relative number is measured against. */
export const BENCHMARK = 'SPY';

const epoch = (v) => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Does this timestamp carry a real time of day, or is it a bare date?
 *
 * A DATE column parses to exactly midnight UTC. A genuine filing timestamp essentially never does —
 * midnight UTC is 7pm or 8pm ET, and EDGAR is closed. When it somehow did, this reads the filing as
 * day-resolution and anchors one session earlier, which is the conservative direction: it can only
 * widen the window, never attribute a pre-filing move to the filing.
 */
export function hasClockTime(publicTime) {
  const t = epoch(publicTime);
  if (t == null) return false;
  return t % 86_400_000 !== 0;
}

// The US cash session closes at 4pm ET. Intl resolves that against the real DST calendar rather than
// a guessed UTC offset, which would be wrong for half the year.
const ET = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
});

/** { date: 'YYYY-MM-DD', hour: 0..23 } in US Eastern, or null. */
export function easternParts(publicTime) {
  const t = epoch(publicTime);
  if (t == null) return null;
  const parts = Object.fromEntries(ET.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  if (!parts.year || !Number.isFinite(hour)) return null;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour };
}

export const SESSION_CLOSE_HOUR_ET = 16;

/**
 * The last calendar date whose close preceded publication.
 *
 * With a clock: a filing at 5:38pm ET is after that day's close, so that day's close is a valid
 * anchor. A filing at 9am ET is before it, so the anchor is the previous session.
 * Without a clock: the previous session, always.
 */
export function anchorCutoffDate(publicTime) {
  const t = epoch(publicTime);
  if (t == null) return null;
  if (hasClockTime(publicTime)) {
    const et = easternParts(publicTime);
    if (!et) return null;
    if (et.hour >= SESSION_CLOSE_HOUR_ET) return et.date;      // filed after the close
    return isoDayBefore(et.date);
  }
  // Date-only: the day itself is the publication day, so the anchor is the day before it.
  return isoDayBefore(new Date(t).toISOString().slice(0, 10));
}

function isoDayBefore(iso) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t - 86_400_000).toISOString().slice(0, 10) : null;
}

/**
 * Index of the anchor bar: the LAST session on or before the cutoff.
 *
 * Returns null when publication predates the series — there is no close before it to anchor on, and
 * inventing one by clamping to bar zero would measure from a price that did not precede the event.
 */
export function anchorIndex(publicTime, bars) {
  const cutoff = anchorCutoffDate(publicTime);
  if (!cutoff || !Array.isArray(bars) || !bars.length) return null;
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (String(bars[mid].date) <= cutoff) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans < 0 ? null : ans;
}

const pct = (from, to) => (from > 0 && Number.isFinite(to) ? ((to - from) / from) * 100 : null);
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/**
 * Does a price break fall inside (anchorDate, endDate]?
 *
 * A break is the first bar of a NEW segment, so a return whose window contains one compares two
 * different securities. `breaks` is the ticker's break dates as 'YYYY-MM-DD'.
 */
export function spansBreak(breaks, anchorDate, endDate) {
  if (!Array.isArray(breaks) || !breaks.length) return false;
  return breaks.some((b) => { const d = String(b); return d > String(anchorDate) && d <= String(endDate); });
}

/**
 * The reaction for one public moment.
 *
 * `bars` and `benchBars` are ascending [{ date, close }]. The benchmark is matched BY DATE rather
 * than by index: the two series can differ in length or miss a session, and aligning by position
 * would silently compare different days.
 *
 * Returns null when there is no valid anchor at all, so a caller can distinguish "no reaction data"
 * from "the anchor exists but no horizon has completed yet".
 */
export function computeReaction({ publicTime, bars, benchBars = null, breaks = [], usable = true } = {}) {
  // A series the continuity scan calls unusable (sub-penny quotes, too many breaks) produces no
  // percentages at all — every number from it would be quote granularity, not return.
  if (!usable) return null;
  const i = anchorIndex(publicTime, bars);
  if (i == null) return null;

  const anchor = bars[i];
  const anchorClose = Number(anchor.close);
  if (!(anchorClose > 0)) return null;

  const benchByDate = benchBars instanceof Map
    ? benchBars
    : new Map((benchBars || []).map((b) => [String(b.date), Number(b.close)]));
  const benchAnchor = benchByDate.get(String(anchor.date));

  const horizons = {};
  let any = false;
  for (const h of HORIZONS) {
    const j = i + h;
    // INCOMPLETE WINDOWS ARE NULL. Never the partial return under a longer label.
    if (j >= bars.length) { horizons[h] = null; continue; }
    const end = bars[j];
    if (spansBreak(breaks, anchor.date, end.date)) { horizons[h] = null; continue; }

    const ret = pct(anchorClose, Number(end.close));
    if (ret == null) { horizons[h] = null; continue; }

    // Benchmark-relative: the arithmetic difference of the two simple returns over the SAME two
    // calendar dates. Null when either benchmark close is missing — a relative number computed
    // against a guessed benchmark is worse than no relative number.
    let rel = null;
    const benchEnd = benchByDate.get(String(end.date));
    if (benchAnchor > 0 && Number.isFinite(benchEnd)) {
      const benchRet = pct(benchAnchor, benchEnd);
      if (benchRet != null) rel = ret - benchRet;
    }
    horizons[h] = { return: round1(ret), relative: round1(rel), endDate: String(end.date) };
    any = true;
  }

  return {
    anchorDate: String(anchor.date),
    anchorClose: Math.round(anchorClose * 10000) / 10000,
    // Says WHY the anchor is where it is, so the convention is auditable from the payload alone.
    anchorBasis: hasClockTime(publicTime) ? 'last_close_before_filing_time' : 'last_close_before_filing_date',
    benchmark: BENCHMARK,
    horizons,
    // True when at least one horizon completed. The UI shows the section only then.
    hasAny: any,
  };
}

/**
 * One reaction per public anchor, for a list of evidence.
 *
 * Grouped markers share a bar and therefore almost always share an anchor; computing per item and
 * keying on the anchor means a group can render ONE reaction path rather than several contradictory
 * ones, while the individual evidence items stay intact.
 */
export function reactionKey(reaction) {
  return reaction ? `${reaction.anchorDate}` : null;
}
