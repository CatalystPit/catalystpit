// PIT CONSENSUS — EVIDENCE SYNTHESIS. PURE: no database, no network, no clock of its own.
//
// ── WHAT CHANGED, AND WHY ───────────────────────────────────────────────────
//
// V1 already refused a single 0-100 score, which was right. But it still published three outputs
// that carried more authority than the evidence supports:
//
//   "Bullish Lean"    a directional verdict, produced by summing E_f = D·S·F·Q across families
//   "Alignment 73%"   a percentage implying agreement was measured on a validated scale
//   "Confidence High" a word every reader hears as "likely to be right"
//
// The arithmetic was honest about its own construction and still wrong to publish. Summing four
// families into one signed number is a weighting claim — that a $2M insider purchase and a
// quarterly 13F shift belong on the same axis, in the same units, and cancel. Experiment 002 tested
// exactly that premise and found institutional evidence added +0.43% over insider-alone at t=0.82.
// That is not a basis for summing, and nothing since has changed it.
//
// So the aggregate is gone. What remains is what the evidence can actually support:
//
//   EACH FAMILY KEEPS ITS OWN STATE AND ITS OWN FACTS.
//   WHERE FAMILIES POINT THE SAME WAY, SAY SO.
//   WHERE THEY DISAGREE, NAME THE DISAGREEMENT INSTEAD OF AVERAGING IT AWAY.
//
// ── WHY THIS IS NOT A SCORE IN DISGUISE ─────────────────────────────────────
//
// Nothing here multiplies, weights or ranks a family against another. A family reads UP, DOWN or
// MIXED from ITS OWN state vocabulary, and the synthesis only counts and names. "Two families point
// up, one points down, and here is which" is a fact about the evidence. "Bullish Lean, 73%" is a
// claim about the future wearing a fact's clothing.
//
// A reader who disagrees with one family can discount it and keep the rest, which is impossible
// once the families have been summed.

export const SYNTHESIS_VERSION = 'consensus_v2_synthesis';

/**
 * Presentation order. Deliberately NOT precedence — nothing here ranks families, and the order is
 * chosen so the slowest-moving structural evidence reads first and the fastest-moving last.
 */
export const SYNTHESIS_FAMILIES = Object.freeze([
  'structure', 'institutions', 'insiders', 'congress', 'catalysts',
]);

/** How each family's own state vocabulary reads directionally. Categorical, never numeric. */
const UP = new Set(['bullish', 'accumulating', 'positive', 'cluster-buy', 'higher-highs-and-lows']);
const DOWN = new Set(['bearish', 'distributing', 'negative', 'cluster-sale', 'lower-highs-and-lows']);
// Explicitly neither. A routine 10b5-1 sale is a scheduled disposal and reading it as bearish
// evidence is the single most common way insider data is misused.
const NEUTRAL = new Set(['mixed', 'routine-sale', 'no-clear-sequence']);

/** 'up' | 'down' | 'mixed' | null (not active). */
export function familyLean(f) {
  if (!f || !f.active) return null;
  const s = String(f.state || '');
  if (UP.has(s)) return 'up';
  if (DOWN.has(s)) return 'down';
  if (NEUTRAL.has(s)) return 'mixed';
  return 'mixed';
}

const LABEL = {
  structure: 'Market structure',
  institutions: 'Institutions',
  insiders: 'Insiders',
  congress: 'Congress',
  catalysts: 'Catalysts',
};
export const familyLabel = (k) => LABEL[k] || k;

// ── NORMALISED STATE AND TREND ──────────────────────────────────────────────
//
// Every surface must agree on what a family is SAYING, even where it renders a family-specific word
// for it. "Accumulating" and "Positive" are the same normalised state; "Fresh" and "New cluster"
// are both NEW. Without this, two consumers can render the same evidence differently and neither is
// wrong — which is exactly how the board came to call GOLD accumulation while the ticker page
// called it a conflict.
//
// STATE AND TREND ARE INDEPENDENT. "Positive but weakening" and "negative but strengthening" are
// both real and both useful, so they are never collapsed into one axis.
export const FAMILY_STATE = Object.freeze({
  POSITIVE: 'POSITIVE', NEGATIVE: 'NEGATIVE', MIXED: 'MIXED', INACTIVE: 'INACTIVE',
});

/** POSITIVE | NEGATIVE | MIXED | INACTIVE — the canonical state, whatever word the UI shows. */
export function familyState(f) {
  const lean = familyLean(f);
  if (lean === null) return FAMILY_STATE.INACTIVE;
  if (lean === 'up') return FAMILY_STATE.POSITIVE;
  if (lean === 'down') return FAMILY_STATE.NEGATIVE;
  return FAMILY_STATE.MIXED;
}

// Only movement that the family's own trend vocabulary actually asserts is mapped to a change.
// Everything else is STABLE rather than invented: "single actor" and "accumulating" describe the
// evidence, not a change in it, and reading them as momentum would manufacture a trend.
const TREND_NORM = Object.freeze({
  'new-cluster': 'NEW', fresh: 'NEW',
  strengthening: 'STRENGTHENING',
  weakening: 'WEAKENING', fading: 'WEAKENING',
  stable: 'STABLE', accumulating: 'STABLE', distributing: 'STABLE',
  'multiple-actors': 'STABLE', 'single-actor': 'STABLE',
});

/** NEW | STRENGTHENING | WEAKENING | STABLE, or null when the family asserts no trend. */
export function familyTrend(f) {
  if (!f || !f.active) return null;
  const raw = String(f.trend || '');
  if (!raw) return null;
  if (TREND_NORM[raw]) return TREND_NORM[raw];
  // Structure carries weekly-<state>; that is a reading, not a change.
  return 'STABLE';
}

/** The canonical per-family view every consumer renders from. */
export function normaliseFamily(f) {
  return {
    family: f.family,
    label: familyLabel(f.family),
    active: !!f.active,
    state: familyState(f),
    trend: familyTrend(f),
    // The family's own vocabulary, kept for UI ("Accumulating", "Single actor", "Fresh").
    descriptor: f.active ? (f.state ?? null) : null,
    descriptorTrend: f.active ? (f.trend ?? null) : null,
    inactiveReason: f.active ? null : (f.inactiveReason ?? null),
    evidenceCount: f.evidenceCount ?? 0,
    reasons: Array.isArray(f.reasons) ? f.reasons : [],
    refs: Array.isArray(f.refs) ? f.refs : [],
    dates: f.dates || {},
  };
}

/**
 * Name the disagreements, in plain language, from the families themselves.
 *
 * Returns at most a handful — the point is to surface the tension a reader should weigh, not to
 * enumerate every pairing. The strongest opposition is the one between the families that are most
 * clearly stated, which here means active families with the most supporting records behind them.
 */
export function describeConflicts(families) {
  const up = families.filter((f) => familyLean(f) === 'up');
  const down = families.filter((f) => familyLean(f) === 'down');
  if (!up.length || !down.length) return [];

  const byEvidence = (a, b) => (b.evidenceCount || 0) - (a.evidenceCount || 0);
  const topUp = [...up].sort(byEvidence);
  const topDown = [...down].sort(byEvidence);

  const side = (list) => list.map((f) => familyLabel(f.family)).join(' and ');
  return [{
    positive: topUp.map((f) => f.family),
    negative: topDown.map((f) => f.family),
    text: `${side(topUp)} point${topUp.length === 1 ? 's' : ''} one way while `
      + `${side(topDown)} point${topDown.length === 1 ? 's' : ''} the other`,
  }];
}

/**
 * The whole reading.
 *
 * `families` is every family that was EVALUATED, active or not. Inactive ones are carried through
 * deliberately: "Congress: no disclosures in window" is information, and silently dropping the row
 * would let a reader assume it was checked and agreed.
 */
export function synthesise(families, { now = Date.now() } = {}) {
  const evaluated = Array.isArray(families) ? families : [];
  const active = evaluated.filter((f) => f && f.active);

  const up = active.filter((f) => familyLean(f) === 'up').map((f) => f.family);
  const down = active.filter((f) => familyLean(f) === 'down').map((f) => f.family);
  const mixed = active.filter((f) => familyLean(f) === 'mixed').map((f) => f.family);
  const inactive = evaluated.filter((f) => f && !f.active).map((f) => f.family);

  // A STATE, NOT A SCALE — and it comes from consensusState(), the SAME function the market-wide
  // board headlines with. The two surfaces cannot drift apart because there is only one rule.
  const state = consensusState(evaluated);
  const AS_AGREEMENT = {
    NO_EVIDENCE: 'no-evidence',
    CONFLICT: 'conflicting',
    SINGLE_SOURCE: 'single-family',
    POSITIVE_ALIGNMENT: 'aligned',
    NEGATIVE_ALIGNMENT: 'aligned',
    MIXED: 'no-clear-agreement',
  };
  const agreement = AS_AGREEMENT[state];

  return {
    version: SYNTHESIS_VERSION,
    calculatedAt: new Date(now).toISOString(),
    families: evaluated,
    activeCount: active.length,
    evaluatedCount: evaluated.length,
    pointingUp: up,
    pointingDown: down,
    pointingMixed: mixed,
    inactiveFamilies: inactive,
    agreement,
    // The canonical headline, identical to the board's.
    state,
    conflicts: describeConflicts(active),
    // Deliberately absent: any aggregate direction, percentage, score or confidence. If something
    // downstream wants one, that is a request to reintroduce the defect, not a missing feature.
  };
}

// ── THE ONE HEADLINE EVERY SURFACE USES ─────────────────────────────────────
//
// THIS IS THE FIX FOR THE GOLD CONTRADICTION, and it is worth stating exactly.
//
// Two different things were both calling themselves the consensus. computeConsensus() is
// ARITHMETIC: it sums E_f and reports a lean. synthesise() COUNTS STATES: it reports which families
// point which way. On GOLD they disagreed — institutions' magnitude outweighed congress and
// catalysts, and neither dissenter individually cleared the conflict threshold, so the arithmetic
// said "Bullish Lean" while the state count said "families disagree". Both were internally correct
// and the product was incoherent.
//
// The user-facing headline is now ALWAYS the state count, on every surface. One family with a large
// number cannot outvote two families pointing the other way, because votes are not magnitudes.
//
// The arithmetic aggregate is retained for Pit Scan's divergence board, which needs a signed,
// comparable value to set against price. It is no longer shown to anyone.
export const CONSENSUS_STATE = Object.freeze({
  POSITIVE_ALIGNMENT: 'POSITIVE_ALIGNMENT',
  NEGATIVE_ALIGNMENT: 'NEGATIVE_ALIGNMENT',
  CONFLICT: 'CONFLICT',
  MIXED: 'MIXED',
  SINGLE_SOURCE: 'SINGLE_SOURCE',
  NO_EVIDENCE: 'NO_EVIDENCE',
});

/**
 * The canonical headline, from family STATES alone.
 *
 * `families` is every evaluated family, active or not. Inactive families are excluded from the
 * counts entirely — a family with nothing to say is not a vote for neutrality.
 */
export function consensusState(families) {
  const active = (Array.isArray(families) ? families : []).filter((f) => f && f.active);
  if (!active.length) return CONSENSUS_STATE.NO_EVIDENCE;

  const up = active.filter((f) => familyLean(f) === 'up').length;
  const down = active.filter((f) => familyLean(f) === 'down').length;

  // One family agrees with itself by definition. That is single-source, never alignment.
  if (active.length === 1) return CONSENSUS_STATE.SINGLE_SOURCE;
  if (up && down) return CONSENSUS_STATE.CONFLICT;
  if (up >= 2 && !down) return CONSENSUS_STATE.POSITIVE_ALIGNMENT;
  if (down >= 2 && !up) return CONSENSUS_STATE.NEGATIVE_ALIGNMENT;
  return CONSENSUS_STATE.MIXED;
}

const STATE_TEXT = {
  POSITIVE_ALIGNMENT: 'Positive alignment',
  NEGATIVE_ALIGNMENT: 'Negative alignment',
  CONFLICT: 'Evidence families disagree',
  MIXED: 'No clear agreement',
  SINGLE_SOURCE: 'Single-source evidence',
  NO_EVIDENCE: 'No current evidence',
};
export const consensusStateLabel = (s) => STATE_TEXT[s] || STATE_TEXT.MIXED;

const AGREEMENT_TEXT = {
  aligned: 'Evidence families agree',
  conflicting: 'Evidence families disagree',
  'no-clear-agreement': 'No clear agreement',
  'single-family': 'Only one family has current evidence',
  'no-evidence': 'No current evidence',
};
export const agreementLabel = (a) => AGREEMENT_TEXT[a] || 'No clear agreement';
