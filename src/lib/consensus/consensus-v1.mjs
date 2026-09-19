// PIT CONSENSUS V1 — a structured reading of public evidence. NOT a forecast.
//
// The question this answers, exactly:
//
//   "What does the currently available public evidence say, how much do the independent evidence
//    families agree, and how much evidence do we actually have?"
//
// Three separate outputs, deliberately not collapsed into one number:
//
//   DIRECTION    Bullish Lean / Bearish Lean / Mixed
//   ALIGNMENT    how strongly the ACTIVE families agree — shown only when 2+ are active
//   CONFIDENCE   Low / Medium / High — coverage and evidence sufficiency, NOT predicted accuracy
//
// There is no "Consensus Score: 73". The previous system produced one by averaging three sub-scores
// and multiplying by 1.6 or 2.4, and no part of that number could be explained to the person reading
// it. A single number also implies a precision the underlying evidence does not have: four filings
// and a quarterly institutional snapshot cannot support two significant figures.
//
// PURE. No database, no network, no clock — `now` is always passed in. Everything here is a function
// of its arguments, so the whole methodology is testable without fixtures and a historical snapshot
// can be recomputed exactly.
//
// ── WHY E_f = D · S · F · Q ─────────────────────────────────────────────────
//
// Four independent things decide what a family's evidence is worth, and multiplying them means any
// one of them being absent collapses the contribution — which is the correct behaviour. Stale
// evidence (F→0) should not count merely because it was once strong. Low-quality evidence (Q→0)
// should not count merely because it is recent. The product is bounded in [-1, +1] by construction
// because D is in [-1,+1] and S, F, Q are each in [0,1].
//
// ⚠️ NO GLOBAL FAMILY WEIGHTS IN V1. No 40/30/20/10. Any such split would be a claim about which
// evidence predicts better, and we have not established that — Experiment 002 found institutional
// evidence added +0.43% over insider-alone at t=0.82, which is not a basis for weighting anything.
// Families are equal until evidence says otherwise, and that evidence does not exist yet.

export const METHODOLOGY_VERSION = 'consensus_v1';

/** The four independent evidence families. Order is presentation order, not precedence. */
export const FAMILIES = Object.freeze(['insiders', 'institutions', 'congress', 'catalysts']);

// ── VERSIONED CONSTANTS ──────────────────────────────────────────────────────
//
// Every constant that shapes an output lives here, together, so the methodology can be read in one
// place and changed as a version rather than drifting. These are chosen to be defensible and
// legible, NOT fitted: none of them has been tuned against subsequent returns, and doing so would
// turn an evidence reading into an unvalidated forecast.
export const CONSTANTS = Object.freeze({
  version: METHODOLOGY_VERSION,

  // Freshness half-lives, in days. Evidence decays as exp(-ln2 · age / halfLife).
  // Chosen to match how long each kind of evidence stays INFORMATIVE, which differs enormously:
  // a Form 4 purchase says something about the next few weeks; a headline says something about the
  // next few hours.
  halfLifeDays: Object.freeze({
    insiders: 30,       // weeks
    congress: 30,       // weeks, measured from DISCLOSURE
    catalysts: 2,       // hours to a few days
    institutions: null, // not decayed by age — see institutionsFreshness()
  }),

  // How long a family will look back for usable evidence. Past this, the family is INACTIVE rather
  // than weakly positive: absence of evidence is not evidence.
  activationWindowDays: Object.freeze({
    insiders: 90,
    congress: 90,
    catalysts: 14,
    institutions: 400,  // one 13F vintage plus filing lag; superseded by the next quarter
  }),

  // Evidence-mass sufficiency. Confidence saturates when the total |E| across active families
  // reaches this. 2.0 means roughly "two families contributing near-full-strength evidence" is
  // enough mass to stop being the limiting factor — after which coverage and quality decide.
  tau: 2.0,

  // Direction thresholds on Dir = sign(sumE) · alignment. Below the lean threshold the families do
  // not agree enough to call a direction, and it is reported as Mixed.
  directionThresholds: Object.freeze({
    lean: 0.30,         // |Dir| at or above this reads as a lean
    // ⚠️ A DIRECTION ALSO REQUIRES ENOUGH EVIDENCE TO NAME ONE.
    //
    // Alignment measures agreement, not magnitude, so three families that are all barely negative
    // agree perfectly and produce alignment 1.0. Found on live data: AAPL read "Bearish Lean,
    // alignment 100%" on E values of -0.006, -0.062 and -0.085 — total mass 0.153 out of a possible
    // 4.0. The agreement was real and the evidence was nearly nothing, and the headline said the
    // first part while only Confidence said the second.
    //
    // 0.30 is roughly one family at moderate strength. Below it we decline to name a direction
    // rather than dressing up noise; alignment and confidence are still reported, so the reader
    // sees that the families agree and that there is very little to agree about.
    minMass: 0.30,
  }),

  // Confidence category boundaries on C ∈ [0,1].
  confidenceThresholds: Object.freeze({
    medium: 0.25,
    high: 0.55,
  }),

  // THE CONFLICT RULE. Without it, three bullish families at +0.5 and two bearish at -0.7 net
  // positive and would read "Bullish Lean" — hiding a genuine disagreement behind arithmetic.
  conflict: Object.freeze({
    // Opposing mass must be at least this fraction of the dominant side.
    ratio: 0.60,
    // …and at least one family on EACH side must carry this much on its own, so two trivial
    // opposing signals cannot manufacture a conflict label.
    minFamilyMagnitude: 0.25,
  }),
});

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = (n) => (typeof n === 'number' && Number.isFinite(n));

/**
 * Exponential decay to a freshness multiplier in [0,1].
 *
 * Returns 1 for age 0 and halves every `halfLifeDays`. A negative age (evidence dated in the
 * future) is clamped to 0 rather than producing F > 1 — a clock skew or a bad filing date must not
 * make evidence count for more than it can.
 */
export function decayFreshness(ageDays, halfLifeDays) {
  if (!finite(ageDays) || !finite(halfLifeDays) || halfLifeDays <= 0) return 0;
  const age = Math.max(0, ageDays);
  return clamp(Math.pow(0.5, age / halfLifeDays), 0, 1);
}

/**
 * 13F FRESHNESS IS NOT AGE-DECAYED, AND THAT IS DELIBERATE.
 *
 * A 13F becoming public yesterday does not make the holdings one day old — they describe a position
 * as of a quarter end up to ~135 days earlier. Decaying by the FILING date would overstate them;
 * decaying by the QUARTER END would fade out the only institutional evidence that exists, right up
 * until the next vintage replaces it wholesale.
 *
 * So the current public vintage stays fully active until superseded, and the quarter age is carried
 * separately as metadata the UI must display. The honesty lives in the label — "as of quarter ended
 * Mar 31, disclosed May 15" — not in a decay curve that would imply a precision 13F does not have.
 */
export function institutionsFreshness({ quarterEndAgeDays, supersededByNewerVintage = false } = {}) {
  if (supersededByNewerVintage) return 0;
  if (!finite(quarterEndAgeDays) || quarterEndAgeDays < 0) return 0;
  // Beyond the activation window the vintage is stale enough that nothing has filed in over a year;
  // that is a data problem, not evidence.
  if (quarterEndAgeDays > CONSTANTS.activationWindowDays.institutions) return 0;
  return 1;
}

/**
 * One family's contribution: E_f = D · S · F · Q, bounded [-1, +1].
 *
 * Returns an INACTIVE record when there is no usable evidence. The distinction matters more than
 * almost anything else here:
 *
 *   E_f = 0        evidence was evaluated and cancelled out — buys and sells offset, genuinely mixed
 *   inactive       no usable evidence existed to evaluate
 *
 * Collapsing the second into the first would let silence vote. A ticker no insider has touched would
 * dilute the alignment of the families that DO have something to say, and confidence would rise
 * with the number of families that found nothing.
 */
export function familyValue({ family, direction, strength, freshness, quality, evidenceCount = 0, state = null, trend = null, reasons = [], refs = [], dates = {} } = {}) {
  const inactive = (reason) => ({
    family, active: false, inactiveReason: reason,
    D: null, S: null, F: null, Q: null, E: null,
    state: state ?? 'no-evidence', trend: null, evidenceCount: 0, reasons: [], refs: [], dates,
  });

  if (!FAMILIES.includes(family)) return inactive('unknown-family');
  if (!finite(evidenceCount) || evidenceCount <= 0) return inactive('no-evidence');
  if (!finite(direction) || !finite(strength) || !finite(freshness) || !finite(quality)) return inactive('incomplete-inputs');

  const D = clamp(direction, -1, 1);
  const S = clamp(strength, 0, 1);
  const F = clamp(freshness, 0, 1);
  const Q = clamp(quality, 0, 1);

  // Evidence that has fully decayed, or that we cannot trust at all, is not weak evidence — it is
  // no evidence. Keeping it active at E≈0 would inflate the active-family count, and therefore
  // confidence, on the strength of something that contributes nothing.
  if (F <= 0 || Q <= 0 || S <= 0) return inactive(F <= 0 ? 'stale' : Q <= 0 ? 'unusable-quality' : 'no-strength');

  const E = clamp(D * S * F * Q, -1, 1);
  return {
    family, active: true, inactiveReason: null,
    D, S, F, Q, E,
    state, trend, evidenceCount,
    reasons: Array.isArray(reasons) ? reasons.slice(0, 6) : [],
    refs: Array.isArray(refs) ? refs.slice(0, 20) : [],
    dates: dates || {},
  };
}

/**
 * THE CONFLICT TEST — run before a direction label is chosen, not after.
 *
 * Arithmetic net hides disagreement: +0.5, +0.5, +0.5 against -0.7, -0.7 nets positive, and calling
 * that "Bullish Lean" would be a worse answer than "Mixed", because the reader would never learn
 * that two families disagree strongly.
 *
 * Both conditions are required. The ratio catches balanced opposition; the per-family magnitude
 * stops two negligible opposing signals from being dressed up as a conflict.
 */
export function detectConflict(activeValues) {
  const pos = activeValues.filter((v) => v.E > 0);
  const neg = activeValues.filter((v) => v.E < 0);
  if (!pos.length || !neg.length) return { conflict: false, ratio: 0, posMass: 0, negMass: 0 };

  const posMass = pos.reduce((s, v) => s + v.E, 0);
  const negMass = neg.reduce((s, v) => s + Math.abs(v.E), 0);
  const ratio = Math.min(posMass, negMass) / Math.max(posMass, negMass);

  const strongestPos = Math.max(...pos.map((v) => v.E));
  const strongestNeg = Math.max(...neg.map((v) => Math.abs(v.E)));
  const bothSidesSubstantial = strongestPos >= CONSTANTS.conflict.minFamilyMagnitude
    && strongestNeg >= CONSTANTS.conflict.minFamilyMagnitude;

  return {
    conflict: ratio >= CONSTANTS.conflict.ratio && bothSidesSubstantial,
    ratio, posMass, negMass,
  };
}

/** Confidence C ∈ [0,1] — coverage × evidence mass × quality. */
export function computeConfidence(activeValues) {
  if (!activeValues.length) return 0;
  const coverage = activeValues.length / FAMILIES.length;
  const mass = activeValues.reduce((s, v) => s + Math.abs(v.E), 0);
  // ⚠️ S, F and Q already shaped each E. Re-multiplying all three here would punish the same
  // weakness twice and drive confidence toward zero for evidence that is merely ordinary. Only
  // QUALITY returns, because "how much do we trust the source" is a different question from "how
  // much does this evidence say", and it is the one that belongs in a confidence statement.
  const qbar = activeValues.reduce((s, v) => s + v.Q, 0) / activeValues.length;
  return clamp(coverage * Math.min(1, mass / CONSTANTS.tau) * qbar, 0, 1);
}

export const confidenceLabel = (c) =>
  (c >= CONSTANTS.confidenceThresholds.high ? 'High'
    : c >= CONSTANTS.confidenceThresholds.medium ? 'Medium' : 'Low');

/**
 * The whole reading, from the family values.
 *
 * `values` is every family that was evaluated, active or not — the inactive ones are carried through
 * to the result so the UI can say which families had nothing rather than silently omitting them,
 * and so a stored snapshot records what was looked at, not only what was found.
 */
export function computeConsensus(values, { now = Date.now() } = {}) {
  const evaluated = Array.isArray(values) ? values : [];
  const active = evaluated.filter((v) => v && v.active && finite(v.E));

  const base = {
    version: METHODOLOGY_VERSION,
    calculatedAt: new Date(now).toISOString(),
    families: evaluated,
    activeCount: active.length,
    sumE: 0,
    mass: 0,
    directionValue: 0,
    direction: 'insufficient-evidence',
    directionLabel: 'Insufficient evidence',
    alignment: null,
    alignmentState: 'none',
    conflict: null,
    confidenceRaw: 0,
    confidence: 'Low',
  };

  if (!active.length) return base;

  const sumE = active.reduce((s, v) => s + v.E, 0);
  const mass = active.reduce((s, v) => s + Math.abs(v.E), 0);
  const confidenceRaw = computeConfidence(active);
  const confidence = confidenceLabel(confidenceRaw);

  // ── ONE ACTIVE FAMILY: NOT 100% ALIGNMENT ──────────────────────────────────
  // A single family agrees with itself by definition. Printing "Alignment 100%" would be the most
  // misleading number on the page — maximum apparent agreement from minimum evidence — so the
  // alignment slot carries a state instead, and direction still reports what the one family says.
  if (active.length < 2) {
    const only = active[0];
    const dirValue = Math.sign(only.E) * Math.abs(only.E);
    return {
      ...base,
      sumE, mass,
      directionValue: dirValue,
      direction: labelDirection(dirValue, false, mass),
      directionLabel: labelText(labelDirection(dirValue, false, mass)),
      alignment: null,
      alignmentState: 'single-source',
      conflict: { conflict: false, ratio: 0, posMass: Math.max(0, sumE), negMass: Math.max(0, -sumE) },
      confidenceRaw, confidence,
    };
  }

  const alignment = mass > 0 ? Math.abs(sumE) / mass : 0;
  const conflict = detectConflict(active);
  const directionValue = Math.sign(sumE) * alignment;
  const direction = labelDirection(directionValue, conflict.conflict, mass);

  return {
    ...base,
    sumE, mass,
    directionValue,
    direction,
    directionLabel: labelText(direction),
    alignment,
    alignmentState: 'computed',
    conflict,
    confidenceRaw, confidence,
  };
}

function labelDirection(directionValue, isConflicted, mass) {
  // A detected conflict overrides the arithmetic sign. This is the rule that stops a net-positive
  // number from being reported as agreement when the families plainly disagree.
  if (isConflicted) return 'mixed-high-conflict';
  if (!finite(directionValue)) return 'mixed';
  // Not enough evidence to name a direction, however well the little there is agrees.
  if (finite(mass) && mass < CONSTANTS.directionThresholds.minMass) return 'mixed';
  if (directionValue >= CONSTANTS.directionThresholds.lean) return 'bullish-lean';
  if (directionValue <= -CONSTANTS.directionThresholds.lean) return 'bearish-lean';
  return 'mixed';
}

const LABELS = {
  'bullish-lean': 'Bullish Lean',
  'bearish-lean': 'Bearish Lean',
  'mixed': 'Mixed',
  'mixed-high-conflict': 'Mixed / High Conflict',
  'insufficient-evidence': 'Insufficient evidence',
};
export const labelText = (d) => LABELS[d] || 'Mixed';
