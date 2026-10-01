/**
 * THE AUTHORITATIVE SEC XBRL FACT-SELECTION LAYER.
 *
 * Everything that decides WHICH SEC fact answers a question lives here, so there is one rule per question
 * rather than one per caller. Before this existed there were two, and they disagreed:
 *
 *   /api/financials   dedupeByEnd kept the LAST entry in array order for a period end, and read EPS from
 *                     EarningsPerShareDiluted.
 *   lib/sec-earnings  kept the EARLIEST-FILED entry for a period end, and read EPS from
 *                     EarningsPerShareBasic.
 *
 * Both are defensible rules. Having both means the statements tab and the earnings history could print
 * different EPS for the same quarter, with nothing anywhere saying which was the product's answer.
 *
 * ── ⚠️ THE FIVE WAYS A WRONG FACT GETS SELECTED, AND WHERE EACH IS STOPPED ───
 *
 * 1. STALE TAG. A company changes concepts and the old series stays in the data forever. Apple reports
 *    `Revenues` through 2018 and `RevenueFromContractWithCustomerExcludingAssessedTax` after it; "first
 *    tag present wins" reads 2018 revenue as current, confidently, for good. → resolveChain picks by
 *    LATEST PERIOD END, never by position.
 *
 * 2. YTD READ AS A QUARTER. Income and cash-flow facts are reported cumulatively from the fiscal year
 *    start, so the same concept carries 3-, 6-, 9- and 12-month spans with the same `end`. Taking "the
 *    fact ending on this date" yields Q2 = six months of revenue. → every duration fact is validated
 *    against the span its caller asked for, and a span that is not ~3 months is refused for a quarter
 *    rather than silently accepted.
 *
 * 3. ANNUAL MIXED WITH QUARTERLY. A 12-month fact and a 3-month fact both legitimately end on the fiscal
 *    year end. → same validation; the window decides, not the date.
 *
 * 4. CALENDAR QUARTER ASSUMED TO BE FISCAL QUARTER. Apple's fiscal Q3 2026 ends 2026-06-27. Code that
 *    treats a CY2026Q2 frame label as "the three months to 30 June" is wrong about the period by weeks
 *    and about the fiscal label by one quarter. → the frame label is never used as a period; start and
 *    end come off the fact itself, and fiscal labels are derived from the end date and the company's own
 *    fiscal-year-end month.
 *
 * 5. AN OLDER FILING OVERWRITING A NEWER ONE. → within a frame, SEC has already chosen one fact per
 *    entity; across frames, a fact is only ever written for the period it describes, so a later frame
 *    cannot overwrite an earlier period's value. The store keys on (ticker, concept, period_end).
 */
import { CONCEPTS, DURATION, INSTANT, PE_EPS_BASIS } from './xbrl-concepts.mjs';

const DAY = 86_400_000;
export const spanDays = (start, end) => {
  const a = Date.parse(`${String(start).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(end).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / DAY : NaN;
};

/**
 * Is this duration a single fiscal quarter?
 *
 * ⚠️ THE WINDOW IS WIDE ON PURPOSE AND STILL NARROW ENOUGH TO EXCLUDE A HALF-YEAR. A 52/53-week filer's
 * quarters are 91 days, occasionally 98 for the 14-week quarter that absorbs the 53rd week. A calendar
 * filer's Q1 is 90 days, Q2 91. The shortest real half-year is 181 days, so an upper bound of 100 cannot
 * admit one. Anything outside this range is refused rather than rounded into place.
 */
export const isQuarterSpan = (d) => Number.isFinite(d) && d >= 80 && d <= 100;

/**
 * Is this duration a single fiscal year?
 *
 * 52 weeks is 364 days, 53 weeks is 371, a calendar year 365 or 366. A 9-month YTD is at most 279, so the
 * lower bound of 340 cannot admit one.
 */
export const isAnnualSpan = (d) => Number.isFinite(d) && d >= 340 && d <= 380;

/**
 * The fiscal year and quarter a period end belongs to, from the company's own fiscal-year-end month.
 *
 * ⚠️ DERIVED FROM THE END DATE, NEVER FROM XBRL'S `fy`/`fp`. Those fields are FILING-relative: a 10-K
 * tags its two comparative prior years with the FILING's fiscal year, so three different years carry the
 * same `fy` and the oldest is indistinguishable from the newest by that field alone. The end date plus
 * the fiscal-year-end month is filing-independent and cannot be confused by a comparative.
 */
export function fiscalOf(end, fyeMonth) {
  const y = +String(end).slice(0, 4);
  const m = +String(end).slice(5, 7);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return { fy: null, q: null };
  const fye = Number.isFinite(fyeMonth) && fyeMonth >= 1 && fyeMonth <= 12 ? fyeMonth : 12;
  // ⚠️ A PERIOD ENDING WITHIN A FEW DAYS OF THE FYE MONTH BOUNDARY BELONGS TO THE EARLIER YEAR. Apple's
  // FY2026 ends 2026-09-26, which is month 9 — equal to the FYE month, so `m <= fye` keeps it in FY2026.
  const fy = m <= fye ? y : y + 1;
  const startM = (fye % 12) + 1;
  const q = Math.floor((((m - startM) + 12) % 12) / 3) + 1;
  return { fy, q };
}

export const fiscalLabel = (end, fyeMonth) => {
  const { fy, q } = fiscalOf(end, fyeMonth);
  return fy ? `Q${q} FY${fy}` : null;
};

/**
 * Pick the winning candidate from a concept's fallback chain.
 *
 * `candidates` is [{ tag, fact }] where fact carries { end, val, ... }. Returns the winner or null.
 *
 * ⚠️ THE LATEST PERIOD END WINS, AND POSITION IN THE CHAIN ONLY BREAKS A TIE. This is the whole defence
 * against the stale-tag class of bug, and it is the single most important line in this module. Ordering by
 * preference would make Apple's revenue permanently 2018's.
 */
export function resolveChain(candidates) {
  let best = null;
  let bestIdx = Infinity;
  for (const c of candidates) {
    if (!c || !c.fact || c.fact.val == null || !c.fact.end) continue;
    const idx = Number.isFinite(c.chainIndex) ? c.chainIndex : 0;
    if (!best) { best = c; bestIdx = idx; continue; }
    if (c.fact.end > best.fact.end) { best = c; bestIdx = idx; continue; }
    // A genuine tie on period end: the earlier chain entry is the more standard concept.
    if (c.fact.end === best.fact.end && idx < bestIdx) { best = c; bestIdx = idx; }
  }
  return best;
}

/**
 * Validate one duration fact against the period shape a caller asked for.
 *
 * @returns { ok: true, days } | { ok: false, reason, days }
 */
export function validateDuration(fact, want /* 'quarter' | 'annual' */) {
  if (!fact?.start || !fact?.end) return { ok: false, reason: 'missing-period-bounds', days: NaN };
  const d = spanDays(fact.start, fact.end);
  if (!Number.isFinite(d) || d <= 0) return { ok: false, reason: 'unparseable-period', days: d };
  if (want === 'quarter') {
    if (isQuarterSpan(d)) return { ok: true, days: d };
    // Naming the YTD case explicitly, because it is the one a reader will be looking for.
    const reason = isAnnualSpan(d) ? 'annual-span-offered-for-quarter'
      : d > 100 ? 'ytd-or-multi-quarter-span' : 'span-too-short';
    return { ok: false, reason, days: d };
  }
  if (want === 'annual') {
    if (isAnnualSpan(d)) return { ok: true, days: d };
    return { ok: false, reason: d < 340 ? 'partial-year-span' : 'span-too-long', days: d };
  }
  return { ok: false, reason: 'unknown-period-request', days: d };
}

/** Validate an instant fact: it must have an end and no span. */
export function validateInstant(fact) {
  if (!fact?.end) return { ok: false, reason: 'missing-end' };
  // ⚠️ A `start` ON AN INSTANT FACT MEANS IT IS NOT AN INSTANT FACT. The frames endpoint separates them
  // by URL (…Q2 vs …Q2I), so this should never fire — which is exactly why it is worth asserting rather
  // than assuming. A duration fact read as a balance-sheet snapshot would be silently wrong.
  if (fact.start) return { ok: false, reason: 'duration-fact-in-instant-position' };
  return { ok: true };
}

/**
 * THE TTM ENGINE.
 *
 * Sum four consecutive fiscal quarters, or refuse.
 *
 * ── ⚠️ WHAT IT REFUSES, AND WHY EACH REFUSAL MATTERS ─────────────────────────
 *
 *   fewer than four quarters   A three-quarter sum presented as TTM understates by about a quarter and
 *                              looks entirely plausible. There is no honest way to fill the gap.
 *   a non-quarter span         Catches a YTD fact that reached this far.
 *   overlapping periods        Two facts covering the same weeks double-count. Happens when a company
 *                              restates and both the original and restated quarter survive upstream.
 *   a gap between quarters     A missing quarter between two present ones is not a TTM, it is three
 *                              quarters and a hole. Tolerance is a few days because fiscal quarters abut
 *                              without being contiguous to the day.
 *   total span not ~a year     The final arithmetic check: four quarters that are each individually
 *                              valid but together span 15 months are not a trailing twelve months.
 *
 * ⚠️ AND PER-SHARE FACTS ARE SUMMED, NOT AVERAGED. EPS for four quarters adds to EPS for the year —
 * the share count differences across quarters are a real and accepted imprecision in every published
 * TTM EPS, and averaging would be wrong by a factor of four.
 *
 * @returns {{ ok: true, value, periods, startDate, endDate, spanDays }} | {{ ok: false, reason, have }}
 */
export function computeTtm(facts) {
  const usable = (facts || [])
    .filter((f) => f && f.val != null && f.start && f.end)
    .map((f) => ({ ...f, days: spanDays(f.start, f.end) }))
    .filter((f) => isQuarterSpan(f.days))
    .sort((a, b) => String(b.end).localeCompare(String(a.end)));

  if (usable.length < 4) return { ok: false, reason: 'insufficient-quarters', have: usable.length };

  // Deduplicate on period end BEFORE taking four: a restated quarter must not occupy two of the slots.
  const byEnd = new Map();
  for (const f of usable) if (!byEnd.has(f.end)) byEnd.set(f.end, f);
  const picked = [...byEnd.values()].slice(0, 4);
  if (picked.length < 4) return { ok: false, reason: 'insufficient-distinct-quarters', have: picked.length };

  // Oldest first, so adjacency reads naturally.
  const chron = picked.slice().reverse();
  for (let i = 1; i < chron.length; i++) {
    const prevEnd = Date.parse(`${chron[i - 1].end}T00:00:00Z`);
    const thisStart = Date.parse(`${chron[i].start}T00:00:00Z`);
    const gap = (thisStart - prevEnd) / DAY;
    // A quarter normally starts the day after the previous one ends: gap of 1. Allow a few days of slack
    // for 52/53-week calendars, and refuse anything that overlaps or skips.
    if (gap < 0) return { ok: false, reason: 'overlapping-quarters', have: 4 };
    if (gap > 7) return { ok: false, reason: 'gap-between-quarters', have: 4 };
  }

  const total = spanDays(chron[0].start, chron[chron.length - 1].end);
  if (!(total >= 350 && total <= 380)) return { ok: false, reason: 'total-span-not-one-year', have: 4, spanDays: total };

  const value = chron.reduce((s, f) => s + Number(f.val), 0);
  return {
    ok: true,
    value,
    periods: chron.map((f) => ({ start: f.start, end: f.end, val: Number(f.val), accn: f.accn ?? null, tag: f.tag ?? null })),
    startDate: chron[0].start,
    endDate: chron[chron.length - 1].end,
    spanDays: total,
  };
}

/**
 * MARKET CAPITALISATION — licensed price × SEC share count, or nothing.
 *
 * ── ⚠️ THE TSM ERROR THIS EXISTS TO PREVENT ──────────────────────────────────
 *
 * An earlier version of this derivation reported TSM as worth $11.8 TRILLION, roughly twice the largest
 * company that has ever existed. The arithmetic was perfect. The inputs described different instruments:
 * dei:EntityCommonStockSharesOutstanding is the registrant's ORDINARY share count, while the US-listed
 * line is an American Depositary Share representing some multiple of them — five, for TSM. Ordinary
 * shares × ADS price overstates by exactly the depositary ratio, and that ratio appears nowhere in SEC
 * data, so there is no correction available, only a refusal.
 *
 * A foreign private issuer files 20-F or 40-F instead of 10-K/10-Q. That is the signal, and it is a
 * WHITELIST on the domestic forms rather than a blacklist on the foreign ones: an issuer filing neither
 * is an unknown shape, and an unknown shape does not get a number.
 *
 * ⚠️ THE SHARE COUNT MUST ALSO BE FRESH AND SPLIT-CONSISTENT. A cover-page count from eighteen months ago
 * multiplied by today's price is wrong by every buyback and issuance since, and if a split happened in
 * between it is wrong by the split factor — in the direction that makes a company look enormous. Both are
 * refused rather than adjusted, because adjusting requires a split history this function does not have.
 *
 * @returns {{ ok: true, value, inputs }} | {{ ok: false, reason }}
 */
export function computeMarketCap({ price, priceDate, shares, sharesAsOf, filesDomestic, filesForeign, maxShareAgeDays = 400 }) {
  const p = Number(price);
  const s = Number(shares);
  if (!Number.isFinite(p) || p <= 0) return { ok: false, reason: 'no-licensed-price' };
  if (!Number.isFinite(s) || s <= 0) return { ok: false, reason: 'no-share-count' };
  if (filesForeign) return { ok: false, reason: 'foreign-private-issuer-ads-ratio-unknown' };
  if (!filesDomestic) return { ok: false, reason: 'filer-type-not-established' };

  if (sharesAsOf && priceDate) {
    const age = spanDays(sharesAsOf, priceDate);
    if (Number.isFinite(age) && age > maxShareAgeDays) {
      return { ok: false, reason: 'share-count-stale', ageDays: Math.round(age) };
    }
    // A share count dated AFTER the price is a data problem, not a fresher number.
    if (Number.isFinite(age) && age < -7) return { ok: false, reason: 'share-count-after-price' };
  }

  return {
    ok: true,
    value: p * s,
    inputs: { price: p, priceDate: priceDate ?? null, shares: s, sharesAsOf: sharesAsOf ?? null },
  };
}

/**
 * PRICE / EARNINGS — only on a stated basis, with a positive denominator.
 *
 * ⚠️ THE BASIS IS NAMED IN THE RESULT, not assumed by the reader. The product publishes P/E on trailing
 * twelve-month DILUTED EPS (see PE_EPS_BASIS); the field travels with the number so a surface cannot
 * present a quarterly figure as an annual multiple.
 *
 * ⚠️ AND A NEGATIVE OR ZERO DENOMINATOR HAS NO P/E. A loss-making company's "P/E" of −14 is not a
 * valuation, it is a division that happened. Finance convention is to show nothing, and showing nothing
 * is also what stops it being sorted against real multiples in a screener.
 */
export function computePe({ price, epsTtm, basis = PE_EPS_BASIS }) {
  // ⚠️ ABSENCE IS TESTED BEFORE COERCION, because Number(null) is 0 and 0 is finite. Without this an
  // ABSENT TTM EPS fell through to the `e <= 0` branch and was reported as 'non-positive-eps' — so a
  // company with no computable TTM looked like a loss-making one, and the two need completely different
  // follow-up. The same trap bit computeFreeCashFlow; null is what a database column returns.
  const present = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  if (!present(price)) return { ok: false, reason: 'no-licensed-price' };
  if (!present(epsTtm)) return { ok: false, reason: 'no-ttm-eps' };
  const p = Number(price);
  const e = Number(epsTtm);
  if (p <= 0) return { ok: false, reason: 'no-licensed-price' };
  if (e <= 0) return { ok: false, reason: 'non-positive-eps' };
  const value = p / e;
  // A P/E in the thousands is arithmetically fine and almost always a cent-level EPS artefact. It is
  // published rather than hidden — but capped reporting would be a lie, so the caller gets the number and
  // the inputs and can decide.
  return { ok: true, value, basis, inputs: { price: p, epsTtm: e } };
}

/**
 * FREE CASH FLOW — operating cash flow minus capital expenditures, both required.
 *
 * ⚠️ AN ABSENT CAPEX IS NOT A ZERO CAPEX. Capex has no single standard XBRL tag, so a missing fact is
 * common and means "we could not identify it", not "the company spent nothing". Treating it as 0 would
 * publish free cash flow equal to operating cash flow for every filer using an unrecognised tag — a
 * number that is too high, plausible, and wrong in the flattering direction.
 */
export function computeFreeCashFlow({ operatingCashFlow, capex }) {
  // ⚠️ Number(null) IS 0, AND 0 IS FINITE. The first version of this guard used Number.isFinite alone, so
  // an ABSENT capex passed it as zero and free cash flow came out equal to operating cash flow — exactly
  // the flattering, plausible, wrong number the comment above says must not be published. The absence has
  // to be tested before the coercion. Number(undefined) is NaN and would have been caught; null is the
  // one that slips through, and null is what a database column returns.
  const present = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  if (!present(operatingCashFlow)) return { ok: false, reason: 'no-operating-cash-flow' };
  if (!present(capex)) return { ok: false, reason: 'no-capex-fact' };
  const o = Number(operatingCashFlow);
  const c = Number(capex);
  // Capex is reported as a positive outflow in the cash-flow statement; subtract its magnitude.
  return { ok: true, value: o - Math.abs(c), inputs: { operatingCashFlow: o, capex: Math.abs(c) } };
}

/**
 * The fiscal-year-end month implied by a set of annual period ends.
 *
 * ⚠️ MODAL, NOT LATEST. A company that changed its fiscal year has ends in two different months, and the
 * most recent one is not necessarily the one most of its history is on. The mode is the stable answer,
 * and a tie resolves to the later month so a recent change eventually wins as it accumulates.
 */
export function detectFiscalYearEndMonth(annualEnds) {
  const counts = new Map();
  for (const e of annualEnds || []) {
    const m = +String(e).slice(5, 7);
    if (m >= 1 && m <= 12) counts.set(m, (counts.get(m) || 0) + 1);
  }
  if (!counts.size) return 12;
  let bestM = 12, bestN = -1;
  for (const [m, n] of counts) if (n > bestN || (n === bestN && m > bestM)) { bestM = m; bestN = n; }
  return bestM;
}

/**
 * DERIVE THE MISSING FOURTH QUARTER: Q4 = FY − (Q1 + Q2 + Q3).
 *
 * ── ⚠️ WHY THIS IS NOT OPTIONAL, AND WHY IT WAS DISCOVERED BY RUNNING THE PIPELINE ──
 *
 * A 10-K reports the FULL YEAR. It does not contain a discrete three-month fact for the fourth quarter,
 * because the fourth quarter has no 10-Q. So the frames data for ANY company is permanently missing one
 * quarter in four, and a TTM engine fed only quarterly frames therefore refuses every single ticker with
 * 'insufficient-quarters'. Measured on the first validation run: Apple had exactly three revenue quarters
 * — Dec, Mar, Jun — and no September, forever.
 *
 * This is not a gap that more requests can fill. It has to be derived, and the derivation is simple
 * arithmetic that is only valid when the periods line up EXACTLY:
 *
 *   the annual fact's span must be a real fiscal year
 *   the three quarters must each be a real quarter
 *   they must be contiguous with each other
 *   the first quarter must start on the annual period's start
 *   the third must end BEFORE the annual period's end, leaving a quarter-sized hole
 *
 * If any of that fails the quarter is NOT derived. A derivation that does not line up is a different
 * number dressed as a quarter, and the whole point of this layer is to refuse those.
 *
 * ⚠️ FOR EPS THE RESULT IS AN APPROXIMATION AND IS LABELLED ONE. Annual EPS is not exactly the sum of
 * quarterly EPS, because the diluted share count differs each quarter. The difference is cents and every
 * published TTM EPS in the industry carries it; what matters is that the row says `derived: true` and
 * carries the annual filing's accession, so the lineage is honest about where the number came from.
 *
 * @returns the derived fact, or null
 */
export function deriveFourthQuarter({ annual, quarters }) {
  if (!annual?.start || !annual?.end || annual.val == null) return null;
  if (!isAnnualSpan(spanDays(annual.start, annual.end))) return null;

  const qs = (quarters || [])
    .filter((q) => q && q.start && q.end && q.val != null && isQuarterSpan(spanDays(q.start, q.end)))
    .filter((q) => q.start >= annual.start && q.end <= annual.end)
    .sort((a, b) => String(a.end).localeCompare(String(b.end)));

  // Exactly three, inside the year. Four means the year is complete and nothing needs deriving.
  if (qs.length !== 3) return null;

  // The first reported quarter must begin where the fiscal year begins — a few days of slack for
  // 52/53-week calendars, and no more.
  const leadGap = spanDays(annual.start, qs[0].start);
  if (!(Number.isFinite(leadGap) && leadGap >= 0 && leadGap <= 7)) return null;

  // The three must abut each other.
  for (let i = 1; i < 3; i++) {
    const gap = spanDays(qs[i - 1].end, qs[i].start);
    if (!(Number.isFinite(gap) && gap >= 0 && gap <= 7)) return null;
  }

  // And the hole they leave must itself be a quarter.
  const tailStart = qs[2].end;
  const tail = spanDays(tailStart, annual.end);
  if (!isQuarterSpan(tail)) return null;

  const sum = qs.reduce((s, q) => s + Number(q.val), 0);
  const start = new Date(Date.parse(`${String(tailStart).slice(0, 10)}T00:00:00Z`) + DAY)
    .toISOString().slice(0, 10);

  return {
    start,
    end: annual.end,
    val: Number(annual.val) - sum,
    accn: annual.accn ?? null,
    tag: annual.tag ?? null,
    derived: true,
    derivedFrom: { annual: { start: annual.start, end: annual.end, val: Number(annual.val), accn: annual.accn ?? null },
      quarters: qs.map((q) => ({ end: q.end, val: Number(q.val) })) },
  };
}

export { CONCEPTS, DURATION, INSTANT };
