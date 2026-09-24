// IS THIS SCHEDULE 13D FILING WORTH SHOWING? — pure, so it can be tested against real filings.
//
// ── ⚠️ AN INITIAL 13D AND AN AMENDMENT ARE NOT THE SAME EVENT ───────────────
//
// Measured over 8 days of EDGAR: 17 initial Schedule 13Ds and 70 amendments. If every 13D/A became
// a catalyst, four out of five "13D events" on the board would be an investor re-filing a cover
// page because a number moved a tenth of a point. That is the failure this file exists to prevent.
//
//   initial 13D   the position itself is the news — somebody crossed 5% and is not passive
//   13D/A         the news is the CHANGE, and there may not be one
//
// ── ⚠️ AND AN AMENDMENT IS ONLY MEANINGFUL AGAINST WHAT IT AMENDS ───────────
//
// A stake "increasing from 7.1% to 9.8%" is a claim about two filings. If we do not hold the
// earlier one — because ingestion started last week, or the filer's name changed — then we do not
// know, and we say so by producing nothing rather than by inventing a baseline. Fail closed.

/**
 * ⚠️ HOW MUCH MOVEMENT IS A CHANGE.
 *
 * A percentage point is the unit the filings themselves are reported in, and sub-point drift is
 * usually the denominator moving (buybacks, option exercises) rather than the holder doing
 * anything. One full point is a decision.
 */
export const MATERIAL_DELTA_PCT = 1.0;

/** The reporting threshold itself. Crossing it downward ends the obligation and is news. */
export const REPORTING_THRESHOLD_PCT = 5.0;

/**
 * Decide whether a filing becomes canonical evidence, and with what factual context.
 *
 * @param {object} f      the filing row: { isAmendment, pctOfClass, item4Codes[], filerName }
 * @param {object|null} prior the most recent earlier filing by the same filer on the same issuer,
 *                            or null when we do not hold one
 * @returns {{promote:boolean, reason:string, materiality:number, context:string|null,
 *            deltaPct:number|null}}
 */
export function schedule13dSignificance(f, prior = null) {
  const pct = numOrNull(f?.pctOfClass);
  const codes = Array.isArray(f?.item4Codes) ? f.item4Codes.filter(Boolean) : [];

  // ── INITIAL 13D ────────────────────────────────────────────────────────────
  //
  // The filing itself is the event: a holder crossed the threshold and did not qualify as passive.
  // The percentage sets how strong a record it is, and an unparsed percentage lowers it rather
  // than disqualifying it — the filing is still a fact even when its cover page is not readable.
  if (!f?.isAmendment) {
    return {
      promote: true,
      reason: pct != null && pct >= REPORTING_THRESHOLD_PCT ? 'initial_above_threshold' : 'initial',
      materiality: pct != null && pct >= REPORTING_THRESHOLD_PCT ? 0.75 : 0.60,
      // ⚠️ ONLY WHEN THE NUMBER SUPPORTS IT. No percentage, no claim about the threshold.
      context: pct != null && pct >= REPORTING_THRESHOLD_PCT
        ? { text: `newly reported holder above ${REPORTING_THRESHOLD_PCT}%`, pct: round2(pct) }
        : null,
      deltaPct: null,
    };
  }

  // ── AMENDMENTS ─────────────────────────────────────────────────────────────
  const priorPct = numOrNull(prior?.pctOfClass);
  const delta = pct != null && priorPct != null ? round1(pct - priorPct) : null;

  // ⚠️ A DISCLOSURE OUTRANKS ARITHMETIC. An amendment whose Item 4 states a completed act — an
  // agreement signed, a director appointed, a proposal made — is the news regardless of whether
  // the percentage moved, and it is the one case where we can say what the filing is ABOUT.
  if (codes.length) {
    return {
      promote: true, reason: 'item4_disclosure', materiality: 0.80,
      context: describeDelta(priorPct, pct, delta), deltaPct: delta,
    };
  }

  // ⚠️ NO PRIOR FILING MEANS NO COMPARISON, AND NO COMPARISON MEANS NO EVENT. The alternative is
  // reporting every amendment we happen to see first as though it were a change.
  if (delta == null) {
    return { promote: false, reason: prior ? 'no_percentage' : 'no_prior_filing', materiality: 0, context: null, deltaPct: null };
  }

  // Crossing back below the reporting threshold ends the filer's obligation — a real, bounded fact.
  if (priorPct >= REPORTING_THRESHOLD_PCT && pct < REPORTING_THRESHOLD_PCT) {
    return {
      promote: true, reason: 'below_threshold', materiality: 0.72,
      context: describeDelta(priorPct, pct, delta), deltaPct: delta,
    };
  }

  if (Math.abs(delta) >= MATERIAL_DELTA_PCT) {
    return {
      promote: true,
      reason: delta > 0 ? 'stake_increase' : 'stake_decrease',
      // A decrease by a control-intent holder is as informative as an increase; neither is scored
      // higher than the other, and neither is given a direction. See resolve.js.
      materiality: 0.70,
      context: describeDelta(priorPct, pct, delta), deltaPct: delta,
    };
  }

  // ⚠️ THE COMMON CASE. Routine re-filing with no meaningful change: kept in the table, kept out
  // of the evidence engine. Populating a board with these would be inventing significance.
  return { promote: false, reason: 'no_material_change', materiality: 0, context: null, deltaPct: delta };
}

/**
 * "stake increased from 7.1% to 9.8%" — stated only when BOTH numbers come from filings we hold.
 *
 * ⚠️ THE SHAPE IS `{ text, ... }`, NOT A BARE STRING. Every other context in the engine comes from
 * history.mjs and carries a `text` field plus its own evidence; rank.mjs reads `context.unusual` and
 * `context.gapDays`, and model.mjs compares `context.text` against the summary. A plain string here
 * would render as nothing and silently lose the comparison — caught in a live trace, not in review.
 *
 * ⚠️ NO RARITY CLAIMS. Never "largest ever", never "first time", because neither is provable from
 * a pair of filings, and history.mjs refuses the same class of claim for the same reason.
 */
export function describeDelta(priorPct, pct, delta) {
  if (priorPct == null || pct == null || delta == null || delta === 0) return null;
  const verb = delta > 0 ? 'increased' : 'reduced';
  return {
    text: `stake ${verb} from ${fmt(priorPct)}% to ${fmt(pct)}%`,
    priorPct: round2(priorPct), pct: round2(pct), deltaPct: delta,
  };
}

const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round1 = (n) => Math.round(n * 10) / 10;
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(round2(n)));
const round2 = (n) => Math.round(n * 100) / 100;
