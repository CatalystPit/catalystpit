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

  // A STATE, NOT A SCALE. Four words, each of which a reader can check against the rows above it.
  let agreement;
  if (!active.length) agreement = 'no-evidence';
  else if (up.length && down.length) agreement = 'conflicting';
  else if (active.length === 1) agreement = 'single-family';
  else if ((up.length >= 2 && !down.length) || (down.length >= 2 && !up.length)) agreement = 'aligned';
  else agreement = 'no-clear-agreement';

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
    conflicts: describeConflicts(active),
    // Deliberately absent: any aggregate direction, percentage, score or confidence. If something
    // downstream wants one, that is a request to reintroduce the defect, not a missing feature.
  };
}

const AGREEMENT_TEXT = {
  aligned: 'Evidence families agree',
  conflicting: 'Evidence families disagree',
  'no-clear-agreement': 'No clear agreement',
  'single-family': 'Only one family has current evidence',
  'no-evidence': 'No current evidence',
};
export const agreementLabel = (a) => AGREEMENT_TEXT[a] || 'No clear agreement';
