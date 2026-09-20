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
 * The conflict worth a reader's attention: opposing DISCLOSURE evidence that is material relative to
 * what it opposes. Returns [] when the minority side is outweighed by more than 5:1 — that evidence
 * is still reported, as minor contrary evidence, just not as a contest.
 *
 * Defined below evidenceContributions/MINOR_CONTRARY_SHARE in reading order; hoisting applies.
 */
export function meaningfulConflict(families) {
  const c = evidenceContributions(families);
  if (!c.posMass || !c.negMass) return [];
  if (c.minorityShare < MINOR_CONTRARY_SHARE) return [];
  return describeConflicts([...c.positive, ...c.negative]);
}

/**
 * The whole reading.
 *
 * `families` is every family that was EVALUATED, active or not. Inactive ones are carried through
 * deliberately: "Congress: no disclosures in window" is information, and silently dropping the row
 * would let a reader assume it was checked and agreed.
 */
/**
 * THE CANONICAL CONSENSUS OBJECT. Every surface renders from this and nothing recomputes it.
 *
 * Snapshot-ready by design (version, calculatedAt, family states and trends, state, confidence,
 * coverage), so durable state-transition tracking can be added later without changing the shape.
 * That tracking is deliberately NOT built here: applying today's model to yesterday's data would
 * fabricate history, and doing it correctly needs point-in-time snapshots.
 */
export function canonicalConsensus(families, { now = Date.now() } = {}) {
  const evaluated = Array.isArray(families) ? families : [];
  const c = evidenceContributions(evaluated);
  const state = consensusState(evaluated);
  const structure = evaluated.find((f) => f.family === 'structure') || null;
  const market = marketConfirmation(structure, state);

  const share = c.minorityShare;
  const minorityFamilies = c.dominant === 'positive' ? c.negative : c.positive;
  const hasOpposition = c.posMass > 0 && c.negMass > 0;

  return {
    version: SYNTHESIS_VERSION,
    calculatedAt: new Date(now).toISOString(),
    state,
    stateLabel: consensusStateLabel(state),
    why: explainState(evaluated, state),

    // COVERAGE — how much of the disclosure picture exists at all.
    coverage: {
      active: c.active.length,
      total: DISCLOSURE_FAMILIES.length,
      activeFamilies: c.active.map((f) => f.family),
      inactiveFamilies: c.disclosure.filter((f) => !f.active)
        .map((f) => ({ family: f.family, reason: f.inactiveReason ?? null })),
    },
    // CONFIDENCE — how well supported the interpretation is. Not a price probability.
    confidence: confidenceOf(evaluated, state),

    // WHAT IS DRIVING THE VIEW, and what opposes it.
    drivers: (c.dominant === 'positive' ? c.positive : c.negative).map(normaliseFamily),
    opposition: hasOpposition && share >= MINOR_CONTRARY_SHARE ? minorityFamilies.map(normaliseFamily) : [],
    minorContrary: hasOpposition && share < MINOR_CONTRARY_SHARE ? minorityFamilies.map(normaliseFamily) : [],
    mixedFamilies: c.mixed.map(normaliseFamily),

    // MARKET — a separate layer, never a disclosure vote.
    market: {
      confirmation: market,
      text: marketText(market),
      structure: structure ? normaliseFamily(structure) : null,
    },

    // Every family, normalised, for the detail view.
    families: evaluated.map(normaliseFamily),

    // Internal diagnostics. NOT for display: minorityShare is the number the states are cut from,
    // and exposing it would re-introduce the false precision this product keeps removing.
    diagnostics: {
      positiveMass: Math.round(c.posMass * 1000) / 1000,
      negativeMass: Math.round(c.negMass * 1000) / 1000,
      minorityShare: Math.round(share * 1000) / 1000,
      directionalFamilies: c.directionalCount,
    },
  };
}

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
    BALANCED_CONFLICT: 'conflicting',
    POSITIVE_LEAN_WITH_CONFLICT: 'conflicting',
    NEGATIVE_LEAN_WITH_CONFLICT: 'conflicting',
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
    // KEY CONFLICT IS ELEVATED, NOT LISTED. describeConflicts() fires on ANY opposing family, which
    // on the live board printed a full-width red conflict box for AMRZ — positive 0.887 against
    // negative 0.002. Opposition has to be meaningful (>= MINOR_CONTRARY_SHARE of directional
    // evidence) before the reader is told two sides disagree, and it has to be DISCLOSURE evidence:
    // price disagreeing with filings is market divergence, which has its own layer.
    conflicts: meaningfulConflict(evaluated),
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
  POSITIVE_LEAN_WITH_CONFLICT: 'POSITIVE_LEAN_WITH_CONFLICT',
  NEGATIVE_LEAN_WITH_CONFLICT: 'NEGATIVE_LEAN_WITH_CONFLICT',
  BALANCED_CONFLICT: 'BALANCED_CONFLICT',
  MIXED: 'MIXED',
  SINGLE_SOURCE: 'SINGLE_SOURCE',
  NO_EVIDENCE: 'NO_EVIDENCE',
});

// ── DISCLOSURE FAMILIES ONLY ────────────────────────────────────────────────
//
// Market structure is PRICE, not disclosure. A Form 4, a 13F, a congressional filing and an 8-K are
// things somebody was legally required to publish; a higher high is not. Counting price as a fifth
// disclosure vote also made Pit Scan circular, because that board exists to compare disclosure
// evidence AGAINST price. Structure gets its own confirmation layer below.
export const DISCLOSURE_FAMILIES = Object.freeze(['insiders', 'institutions', 'congress', 'catalysts']);

// ── WHEN IS OPPOSITION MEANINGFUL? ──────────────────────────────────────────
//
// V2 answered this categorically: any opposing family at all meant CONFLICT. Measured on the live
// board that produced 41 conflicts in 60 rows, including AMRZ at positive 0.887 against negative
// 0.002 — a ratio of 0.003 reported as a contest. Magnitude was being discarded at the last step,
// after the engine had spent four factors computing it.
//
// The question is inherently RELATIVE: opposition matters in proportion to what it opposes. So the
// test is the minority side's SHARE of total directional evidence.
//
//   < 15%   outweighed by more than 5:1. Real, and reported as MINOR CONTRARY EVIDENCE, but calling
//           it a conflict would misrepresent the evidence.
//   15-40%  material and clearly outweighed — between 1.5:1 and 5.7:1. A lean, with conflict named.
//   >= 40%  within 1.5:1. Neither side dominates. A genuine contest.
//
// ⚠️ THESE ARE NOT TUNED TO THE BOARD. They were fixed against the four worked cases in the
// specification before any distribution was measured, and they reproduce all four. Choosing
// boundaries to make a distribution look balanced would make the state meaningless.
export const MINOR_CONTRARY_SHARE = 0.15;
export const BALANCED_SHARE = 0.40;

/** Directional evidence below this in total is too little to name a direction from. Reuses the
 *  engine's own "roughly one family at moderate strength" anchor rather than inventing one. */
export const MIN_DIRECTIONAL_MASS = 0.30;

const contribution = (f) => (Number.isFinite(f?.E) ? Math.abs(f.E) : 0);

/**
 * The contribution-aware reading of the four disclosure families.
 *
 * Returns everything the states and the copy are derived from, so a caller never recomputes any of
 * it and no two surfaces can disagree.
 */
export function evidenceContributions(families) {
  const disclosure = (Array.isArray(families) ? families : [])
    .filter((f) => f && DISCLOSURE_FAMILIES.includes(f.family));
  const active = disclosure.filter((f) => f.active);

  // A family that is ACTIVE but internally mixed carries evidence and is not opposition. It counts
  // toward coverage and confidence, never toward either directional side.
  const positive = active.filter((f) => familyLean(f) === 'up');
  const negative = active.filter((f) => familyLean(f) === 'down');
  const mixed = active.filter((f) => familyLean(f) === 'mixed');

  const posMass = positive.reduce((s, f) => s + contribution(f), 0);
  const negMass = negative.reduce((s, f) => s + contribution(f), 0);
  const total = posMass + negMass;
  const minority = Math.min(posMass, negMass);
  const minorityShare = total > 0 ? minority / total : 0;

  return {
    disclosure, active, positive, negative, mixed,
    posMass, negMass, directionalMass: total, minorityShare,
    dominant: posMass === negMass ? null : (posMass > negMass ? 'positive' : 'negative'),
    // Directional families only — a mixed family cannot be single-source evidence FOR anything.
    directionalCount: positive.length + negative.length,
  };
}

/**
 * THE CANONICAL HEADLINE — contribution-aware, over disclosure families only.
 *
 * Still not a score: nothing is ranked, and the output is one of eight named states a reader can
 * check against the rows beneath it. What changed from V2 is that the magnitudes the engine already
 * computed are no longer thrown away at the final step.
 */
export function consensusState(families) {
  const c = evidenceContributions(families);
  if (!c.active.length) return CONSENSUS_STATE.NO_EVIDENCE;

  // Active families exist but none carries a direction — genuinely ambiguous, not a contest.
  if (!c.directionalCount) return CONSENSUS_STATE.MIXED;

  // One directional family agrees with itself by definition. Never alignment.
  if (c.directionalCount === 1) return CONSENSUS_STATE.SINGLE_SOURCE;

  // Too little directional evidence to name a direction, however well it agrees.
  if (c.directionalMass < MIN_DIRECTIONAL_MASS) return CONSENSUS_STATE.MIXED;

  const oneSided = !c.posMass || !c.negMass;
  if (oneSided) {
    return c.posMass ? CONSENSUS_STATE.POSITIVE_ALIGNMENT : CONSENSUS_STATE.NEGATIVE_ALIGNMENT;
  }

  if (c.minorityShare >= BALANCED_SHARE) return CONSENSUS_STATE.BALANCED_CONFLICT;
  if (c.minorityShare >= MINOR_CONTRARY_SHARE) {
    return c.dominant === 'positive'
      ? CONSENSUS_STATE.POSITIVE_LEAN_WITH_CONFLICT
      : CONSENSUS_STATE.NEGATIVE_LEAN_WITH_CONFLICT;
  }
  // Minor contrary evidence. The state is alignment; the contrary family is still surfaced.
  return c.dominant === 'positive'
    ? CONSENSUS_STATE.POSITIVE_ALIGNMENT
    : CONSENSUS_STATE.NEGATIVE_ALIGNMENT;
}

const STATE_TEXT = {
  POSITIVE_ALIGNMENT: 'Positive alignment',
  NEGATIVE_ALIGNMENT: 'Negative alignment',
  POSITIVE_LEAN_WITH_CONFLICT: 'Positive lean, with conflict',
  NEGATIVE_LEAN_WITH_CONFLICT: 'Negative lean, with conflict',
  BALANCED_CONFLICT: 'Balanced conflict',
  MIXED: 'Mixed / ambiguous',
  SINGLE_SOURCE: 'Single-source evidence',
  NO_EVIDENCE: 'No current evidence',
};
export const consensusStateLabel = (s) => STATE_TEXT[s] || STATE_TEXT.MIXED;

/** Which states carry a directional lean at all. Market structure can only confirm a direction. */
const LEANING = {
  POSITIVE_ALIGNMENT: 'positive', POSITIVE_LEAN_WITH_CONFLICT: 'positive',
  NEGATIVE_ALIGNMENT: 'negative', NEGATIVE_LEAN_WITH_CONFLICT: 'negative',
};

export const MARKET = Object.freeze({
  CONFIRMING: 'CONFIRMING', DIVERGING: 'DIVERGING', MIXED: 'MIXED', UNAVAILABLE: 'UNAVAILABLE',
});

/**
 * MARKET CONFIRMATION — a separate layer, never a disclosure vote.
 *
 * Price either agrees with what the disclosure evidence says, disagrees with it, or cannot speak to
 * it. It never contributes to the evidence state itself.
 *
 * ⚠️ CONFIRMATION REQUIRES SOMETHING TO CONFIRM. When the disclosure evidence has no directional
 * lean — balanced conflict, mixed, single-source, nothing — price cannot be "confirming" it, and
 * saying so would invent agreement. That reads MIXED.
 */
export function marketConfirmation(structureFamily, state) {
  if (!structureFamily || !structureFamily.active) return MARKET.UNAVAILABLE;
  const lean = LEANING[state];
  if (!lean) return MARKET.MIXED;
  const s = familyLean(structureFamily);
  if (s === 'mixed') return MARKET.MIXED;
  if (!s) return MARKET.UNAVAILABLE;
  return (s === 'up' ? 'positive' : 'negative') === lean ? MARKET.CONFIRMING : MARKET.DIVERGING;
}

const MARKET_TEXT = {
  CONFIRMING: 'Price structure is consistent with the disclosure evidence.',
  DIVERGING: 'Price structure is not confirming the disclosure evidence.',
  MIXED: 'Price structure does not speak to this evidence.',
  UNAVAILABLE: 'Price structure unavailable.',
};
export const marketText = (m) => MARKET_TEXT[m] || MARKET_TEXT.UNAVAILABLE;

/**
 * COVERAGE AND CONFIDENCE ARE DIFFERENT QUESTIONS.
 *
 * Coverage: how many independent disclosure families currently hold qualifying evidence.
 * Confidence: how strongly the evidence we DO have supports the interpretation.
 *
 * Missing evidence is not contradictory evidence, so an inactive family lowers coverage without
 * being counted as disagreement. Three strong, high-quality, aligned families can therefore reach
 * HIGH while the fourth is silent — which the old coverage-fraction confidence could not express.
 *
 * Confidence is REDUCED by genuine cross-family conflict, because a contested reading is less
 * supported than an uncontested one. It is never a probability about price.
 */
export function confidenceOf(families, state) {
  const c = evidenceContributions(families);
  if (!c.active.length || !c.directionalCount) return 'Low';
  if (c.directionalCount === 1) return 'Low';           // single-source is never better than Low

  const qbar = c.active.reduce((s, f) => s + (Number.isFinite(f.Q) ? f.Q : 0), 0) / c.active.length;
  const dominantMass = Math.max(c.posMass, c.negMass);

  // Two or more directional families, substantial dominant evidence, trustworthy sources.
  const strong = dominantMass >= 0.60 && qbar >= 0.75;
  const moderate = dominantMass >= 0.30 && qbar >= 0.60;

  if (state === CONSENSUS_STATE.BALANCED_CONFLICT) return moderate ? 'Medium' : 'Low';
  if (c.directionalCount >= 3 && strong) return 'High';
  if (strong) return 'Medium';
  return moderate ? 'Medium' : 'Low';
}

/**
 * The deterministic WHY — assembled from the families, never written to fit the conclusion.
 *
 * Answers "why did Catalyst Pit assign this state", not "why will the stock move".
 */
export function explainState(families, state) {
  const c = evidenceContributions(families);
  const names = (list) => list.map((f) => familyLabel(f.family)).join(' and ');
  const dom = c.dominant === 'positive' ? c.positive : c.negative;
  const opp = c.dominant === 'positive' ? c.negative : c.positive;
  const dir = c.dominant === 'positive' ? 'positive' : 'negative';

  switch (state) {
    case CONSENSUS_STATE.NO_EVIDENCE:
      return 'No disclosure family currently holds qualifying evidence.';
    case CONSENSUS_STATE.SINGLE_SOURCE:
      return `Only ${names([...c.positive, ...c.negative])} currently carries directional evidence, `
        + 'so there is no independent corroboration.';
    case CONSENSUS_STATE.MIXED:
      return c.directionalCount
        ? 'The directional evidence available is too slight to name a direction.'
        : `${names(c.mixed) || 'The active families'} carry evidence, but none of it is directional.`;
    case CONSENSUS_STATE.BALANCED_CONFLICT:
      return `${names(c.positive)} point positive while ${names(c.negative)} point negative, `
        + 'and neither side clearly outweighs the other.';
    case CONSENSUS_STATE.POSITIVE_LEAN_WITH_CONFLICT:
    case CONSENSUS_STATE.NEGATIVE_LEAN_WITH_CONFLICT:
      return `${names(dom)} outweigh opposing evidence from ${names(opp)}, `
        + `so the reading leans ${dir} with that conflict unresolved.`;
    default:
      return opp.length
        ? `${names(dom)} align ${dir}, with only minor contrary evidence from ${names(opp)}.`
        : `${names(dom)} align ${dir} with no opposing disclosure evidence.`;
  }
}

// ── THE BOARD'S DISCOVERY FILTERS ───────────────────────────────────────────
//
// Defined HERE, beside the states, rather than in the client component — a filter list that lives
// next to the UI drifts from the state vocabulary silently, and the failure mode is a state that no
// filter can reach, so those rows are invisible on every view except "All". Every state below must
// appear in exactly one state-based filter, which verify-consensus-board.mjs asserts.
//
// ⚠️ NOT RANKINGS. These narrow the board to a kind of evidence situation. None of them is "best",
// and "Market diverging" is a research prompt — price disagreeing with disclosure — not a call.
export const BOARD_FILTERS = Object.freeze([
  { key: 'all', label: 'All', states: null },
  { key: 'positive', label: 'Positive alignment', states: ['POSITIVE_ALIGNMENT'] },
  { key: 'negative', label: 'Negative alignment', states: ['NEGATIVE_ALIGNMENT'] },
  { key: 'lean', label: 'Lean with conflict', states: ['POSITIVE_LEAN_WITH_CONFLICT', 'NEGATIVE_LEAN_WITH_CONFLICT'] },
  { key: 'balanced', label: 'Balanced conflict', states: ['BALANCED_CONFLICT'] },
  { key: 'diverging', label: 'Market diverging', states: null, market: MARKET.DIVERGING },
  { key: 'thin', label: 'Mixed / single-source', states: ['MIXED', 'SINGLE_SOURCE', 'NO_EVIDENCE'] },
]);

const AGREEMENT_TEXT = {
  aligned: 'Evidence families agree',
  conflicting: 'Evidence families disagree',
  'no-clear-agreement': 'No clear agreement',
  'single-family': 'Only one family has current evidence',
  'no-evidence': 'No current evidence',
};
export const agreementLabel = (a) => AGREEMENT_TEXT[a] || 'No clear agreement';
