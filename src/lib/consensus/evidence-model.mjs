// PIT CONSENSUS V3.5 — TWO SYSTEMS, THEN A JOIN.
//
// ── THE ARCHITECTURE PROBLEM THIS FIXES ─────────────────────────────────────
//
// V3 let market structure sit too close to evidence identity, called +0.8% "diverging", and — the
// real defect — allowed SETUP ARCHETYPES to decide which evidence was allowed into the system at
// all. Measured in production: INTC's CEO bought $10.0M, the first officer open-market purchase in
// 236 days, V2.1 POSITIVE_ALIGNMENT at High confidence with price confirming — and the board never
// showed it, because candidate generation counted insider FILINGS in a 30-day window while the
// evidence engine reads 45. A window mismatch hid the strongest insider signal on the board.
//
// So the order of operations is now explicit and one-directional:
//
//     FAMILY SIGNIFICANCE -> QUALIFICATION -> SYNTHESIS -> REACTION -> JOIN -> PRIORITY -> LABEL
//
// Labels are OUTPUTS. They can never gate inputs again.
//
// ── TWO OBJECTS, NEVER ONE ──────────────────────────────────────────────────
//
//   LAYER A  PUBLIC EVIDENCE   what was disclosed, by whom, when it became public
//   LAYER B  MARKET REACTION   what price did afterwards
//   LAYER C  THE JOIN          what price is doing RELATIVE to the evidence
//
// A and B never share an aggregate. Price is not a fifth disclosure family, and folding it in would
// make Pit Scan circular — that board exists to compare disclosure evidence AGAINST price.
//
// ⚠️ NOTHING HERE IS A PREDICTION, A SCORE SHOWN TO A USER, OR A RATING. `researchPriority` is a
// sort key and must never be rendered. There is no 0-100 number and no "224 confluence".

import { FAMILY, freshness } from '../evidence/model.mjs';

export const MODEL_VERSION = 'consensus_v35';

// ════════════════════════════════════════════════════════════════════════════
// LAYER A — FAMILY SIGNIFICANCE
// ════════════════════════════════════════════════════════════════════════════
//
// Not all active family observations are equivalent, and V3 treated them as if they were. A single
// $1,001-$15,000 congressional purchase and eleven insiders buying $2.6M both read as "one active
// family". Significance is what separates them.
//
// Significance is [0,1] and describes HOW NOTABLE this observation is for this company — never how
// the stock will perform. It is used for qualification and ranking; it never changes direction, and
// it never overrides the engine's own materiality or quality.

/**
 * Nonlinear dollar scaling.
 *
 * $100M is not ten times as interesting as $10M — both are unambiguously large, and a linear scale
 * would let one mega-cap transaction dominate a board of genuine signals. Log scaling compresses
 * the top end while still separating $50K from $5M, which is the range that actually discriminates.
 */
export function dollarWeight(usdValue, { floor = 25_000, ceiling = 50_000_000 } = {}) {
  const v = Number(usdValue);
  if (!Number.isFinite(v) || v <= floor) return 0;
  const lo = Math.log10(floor);
  const hi = Math.log10(ceiling);
  return Math.min(1, Math.max(0, (Math.log10(Math.min(v, ceiling)) - lo) / (hi - lo)));
}

/** Historical rarity, only where history.mjs was willing to make the claim. */
const rarity = (ev) => (ev?.context?.unusual === true || ev?.context?.boundedByCoverage === true
  || typeof ev?.context?.gapDays === 'number' ? 1 : 0);

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * INSIDERS. What makes a Form 4 notable is WHO acted, WHETHER IT WAS DISCRETIONARY, HOW MUCH, and
 * whether it is unusual for this company.
 *
 * ⚠️ WORDING DISCIPLINE, encoded here as a comment because it binds every consumer: meaningful
 * non-10b5-1 selling counts as negative ACTIVITY. It must never be described as insiders knowing
 * the stock will fall. The engine already refuses to emit routine grants, tax withholding, option
 * exercises and 10b5-1 sales, so anything reaching here is already discretionary.
 */
function insiderSignificance(ev) {
  const f = ev.facts || {};
  const value = dollarWeight(f.totalValue);
  const officer = f.officer === true ? 0.30 : 0;
  // Independent actors are the strongest insider signal: one buyer can be idiosyncratic, six
  // buying separately is a pattern.
  const actors = Number(f.buyers ?? f.sellers ?? 0);
  const cluster = actors >= 5 ? 0.2 : actors >= 3 ? 0.12 : actors >= 2 ? 0.06 : 0;
  const clusterType = ev.type === 'insider_cluster_buy' ? 0.1 : 0;

  // ⚠️ RARITY IS A MULTIPLIER, NOT A FREE PASS. "First purchase in 312 days" is true of a $9,000
  // odd-lot as often as a $25M cluster, and crediting both equally made every tiny isolated
  // transaction "unusual". Rarity now scales with the substance it is describing, so it amplifies a
  // real act and adds almost nothing to a trivial one.
  const substance = clamp01(0.30 * value + officer + cluster + clusterType);
  const rare = rarity(ev) ? 0.35 * substance : 0;

  return clamp01(substance + rare);
}

/**
 * INSTITUTIONS. Significance comes from CHANGE, never from level.
 *
 * "1,237 managers hold this" is not a signal — nearly every listed company has institutional
 * holders, and 13F evidence is present on 98% of the board. What can be notable is the size of the
 * change relative to the base, persistence across quarters, and genuine rarity.
 *
 * ⚠️ AND IT IS CAPPED. A 13F describes positions as they stood at a quarter end disclosed weeks
 * later. It must never be able to outrank a filing that became public yesterday purely because its
 * raw numbers are large, so institutional significance is bounded well below the other families.
 */
function institutionSignificance(ev) {
  const f = ev.facts || {};
  const from = Number(f.breadthFrom);
  const to = Number(f.breadthTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return 0;

  // Proportional change, because +44 managers on a base of 434 is meaningful and +44 on 2,596
  // is noise.
  const ratio = Math.abs(to - from) / from;
  const change = clamp01(ratio / 0.25);          // 25% breadth change saturates
  const persistence = /consecutive quarters/i.test(ev.context?.text || '') ? 0.25 : 0;
  const unusual = f.unusual === true ? 0.3 : 0;
  // THE CAP. Stale quarterly disclosure cannot dominate fresh material evidence.
  return Math.min(0.55, clamp01(0.45 * change + persistence + unusual));
}

/**
 * CONGRESS. A single $1,001-$15,000 transaction is not a strong signal, whatever the disclosure
 * lag; several members moving the same way, or a large disclosed range, can be.
 */
const AMOUNT_FLOOR = [
  [/\$5,000,001|\$25,000,001|\$50,000,001/, 1.0],
  [/\$1,000,001/, 0.8],
  [/\$500,001/, 0.6],
  [/\$250,001/, 0.45],
  [/\$100,001/, 0.35],
  [/\$50,001/, 0.25],
  [/\$15,001/, 0.15],
];
export function congressAmountWeight(range) {
  const s = String(range || '');
  for (const [re, w] of AMOUNT_FLOOR) if (re.test(s)) return w;
  return 0.05;                                   // $1,001-$15,000 — real, but not a strong signal
}

function congressSignificance(ev) {
  const f = ev.facts || {};
  const members = Number(f.members) || 1;
  const amountW = congressAmountWeight(f.amountRange);

  // ⚠️ ROUTINE DISCLOSURE IS NOT A SIGNAL. Mega-cap names attract constant small, mixed
  // congressional trading; treating each disclosure as meaningful gave those tickers strong
  // direction and confidence built on nothing. A congressional family earns weight when several
  // members move together, when the disclosed size is real, or when it is historically unusual for
  // THIS ticker — not merely because a filing exists.
  const multi = members >= 3 ? 0.42 : members === 2 ? 0.18 : 0;
  const amount = 0.30 * amountW;
  const unusual = 0.30 * rarity(ev);

  // A lone small disclosure with no rarity claim cannot reach meaningful on its own.
  const lone = members < 2 && amountW < 0.35 && !rarity(ev);
  if (lone) return clamp01(0.5 * (amount + 0.02));

  return clamp01(amount + multi + unusual);
}

/**
 * CATALYSTS. Significance follows the engine's materiality, which is derived from the 8-K item
 * codes — a published SEC taxonomy, not our interpretation.
 *
 * ⚠️ GENERIC EVENTS ARE DEMOTED, NOT RELABELLED. Item 8.01 ("Other Events") genuinely carries no
 * further classification, and measured in production it is the single most common catalyst type.
 * Inventing a specific description for it would be fabrication, so instead it earns less
 * significance — which stops "Other material event" from flooding the board while keeping the
 * filing visible and verifiable on the ticker page.
 */
function catalystSignificance(ev) {
  const f = ev.facts || {};
  if (f.material !== true) return 0.05;

  // ⚠️ MATERIALITY IS NOT SIGNIFICANCE. Using the engine's materiality directly scored a routine
  // officer change at 0.588 and a material agreement at 0.735 — measured, 84% of catalyst records
  // cleared the meaningful bar and half cleared the exceptional one. But 8-Ks are filed constantly:
  // "this filing type is material" says nothing about whether this company is worth looking at
  // today. So significance is the materiality ABOVE the routine baseline, rescaled.
  //
  //   materiality 0.45 (other events)      -> 0.00
  //   materiality 0.60 (officer change)    -> 0.20
  //   materiality 0.75 (material agreement)-> 0.50
  //   materiality 0.85 (auditor change)    -> 0.73
  //   materiality 1.00 (non-reliance)      -> 1.00
  const base = Number.isFinite(ev.materiality) ? ev.materiality : 0.5;
  const above = clamp01((base - 0.55) / 0.45);
  // Item 8.01 carries no classification at all and is demoted further — see the header note.
  const generic = ev.type === 'sec_8k_other' ? 0.3 : 1;
  return clamp01(above * generic);
}

// ════════════════════════════════════════════════════════════════════════════
// §7 — A GENERIC CATALYST MUST NOT ACTIVATE DIRECTION
// ════════════════════════════════════════════════════════════════════════════
//
// "Other material event" carries no classification at all, and a filing we cannot classify cannot
// tell us which way it points. Guessing would be fabrication, so those records contribute facts and
// freshness but never a direction — which is also what stopped INM reading "alignment" above a
// sentence describing a conflict.
const UNCLASSIFIED_CATALYST = new Set(['sec_8k_other']);

/** May this catalyst record contribute a DIRECTION to the evidence lean? */
export function catalystDirectional(ev) {
  if (ev?.family !== FAMILY.CATALYST) return true;
  if (UNCLASSIFIED_CATALYST.has(ev.type)) return false;
  if (ev.facts?.material !== true) return false;
  // The engine itself declines to assign a direction to most 8-Ks; respect that rather than
  // inventing one from materiality.
  return ev.direction === 'positive' || ev.direction === 'negative';
}

const SIGNIFICANCE = {
  [FAMILY.INSIDER]: insiderSignificance,
  [FAMILY.INSTITUTION]: institutionSignificance,
  [FAMILY.CONGRESS]: congressSignificance,
  [FAMILY.CATALYST]: catalystSignificance,
};

/** How notable is this single canonical record for this company? [0,1]. */
export function familySignificance(ev) {
  const fn = SIGNIFICANCE[ev?.family];
  if (!fn) return 0;
  const s = fn(ev);
  // Quality discounts significance — self-reported congressional ranges are not SEC filings — but
  // never flips or creates it.
  const q = Number.isFinite(ev.quality) ? ev.quality : 1;
  return clamp01(s * (0.6 + 0.4 * q));
}

/** The most significant record per family, with its significance. */
export function significantByFamily(evidence, { now = Date.now() } = {}) {
  const best = new Map();
  for (const ev of evidence || []) {
    if (!SIGNIFICANCE[ev.family]) continue;
    const s = familySignificance(ev);
    const cur = best.get(ev.family);
    if (!cur || s > cur.significance) {
      best.set(ev.family, { family: ev.family, significance: s, evidence: ev, tier: freshness(ev, { now }) });
    }
  }
  return [...best.values()].sort((a, b) => b.significance - a.significance);
}

// ── SIGNIFICANCE THRESHOLDS ─────────────────────────────────────────────────
//
// Chosen against the measured production distribution, deliberately conservative.
//
//   MEANINGFUL  a family observation worth putting in front of a reader at all
//   EXCEPTIONAL enough on its own to justify researching the company with no second family —
//               the INTC case: one CEO buying $10.0M after 236 quiet days
export const MEANINGFUL_SIGNIFICANCE = 0.35;
// Raised from 0.60. That bar let 31 of 57 board rows survive the age gate as "exceptional", some
// 41 days old — an exception carrying more than half the board is not an exception, it is the rule
// with extra steps. At 0.70 it means what it says: a very large officer open-market purchase, a
// real multi-buyer cluster, or an equivalently rare act.
export const EXCEPTIONAL_SIGNIFICANCE = 0.70;

// ════════════════════════════════════════════════════════════════════════════
// LAYER A — SYNTHESIS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Evidence lean and alignment over ACTIVE families only.
 *
 *   M = Σ|E_f|        total directional evidence mass
 *   L = ΣE_f / M      lean, [-1,1]
 *   A = |L|           alignment, [0,1]
 *
 * ⚠️ MISSING IS NOT ZERO. An inactive family contributes nothing to either sum, so silence can
 * never dilute alignment. That is the single most important property here: a company with two
 * strongly agreeing families and two silent ones is ALIGNED, not half-aligned.
 *
 * E_f comes from the canonical engine (D x S x F x Q) and is not recomputed.
 */
export const DISCLOSURE_ONLY = Object.freeze(['insiders', 'institutions', 'congress', 'catalysts']);

export function evidenceSynthesis(families) {
  // ⚠️ PRICE IS NOT A FIFTH DISCLOSURE FAMILY — ENFORCED HERE, NOT ASSUMED.
  //
  // The caller passes the board's five families, which include market structure. Letting that into
  // the sum put price inside Layer A and produced exactly the contradiction this architecture
  // exists to prevent: AMRZ, whose disclosure evidence is unanimously positive, read MIXED with
  // price "confirming" a lean that price itself had created. The filter is a guard, not a
  // convenience — Pit Scan compares disclosure evidence AGAINST price, and that comparison is
  // circular the moment price is on both sides.
  const disclosure = (families || []).filter((f) => DISCLOSURE_ONLY.includes(f?.family));
  const active = disclosure.filter((f) => f?.active && Number.isFinite(f.E));
  const directional = active.filter((f) => f.E !== 0);

  const M = directional.reduce((s, f) => s + Math.abs(f.E), 0);
  const sum = directional.reduce((s, f) => s + f.E, 0);
  const L = M > 0 ? sum / M : 0;
  const n = directional.length;

  return {
    M: Math.round(M * 1000) / 1000,
    L: Math.round(L * 1000) / 1000,
    // Alignment is only meaningful across two or more independent directional families. With one,
    // a family agrees with itself by definition and |L| is always exactly 1.
    A: n >= 2 ? Math.round(Math.abs(L) * 1000) / 1000 : null,
    n,
    activeCount: active.length,
    // Internal disagreement. Only defined where alignment is.
    chi: n >= 2 ? Math.round((1 - Math.abs(L)) * 1000) / 1000 : null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// LAYER B — MARKET REACTION
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠️ THE DEAD ZONE IS THE POINT OF THIS SECTION.
//
// Measured across 195 real post-publicTime reactions on the live board: the MEDIAN absolute
// 1-session move is 1.60%, p25 is 0.60%, p75 is 3.10%. So V3 calling a +0.8% move "diverging" was
// labelling the 25th-to-50th percentile of ordinary daily noise as a market opinion.
//
// A reaction must clear the floor on BOTH the absolute move and the SPY-relative move. Requiring
// both matters: +3% on a +3% market day is the market moving, not a response to the filing.
//
// At 2.0% roughly 40% of observations survive, which is a conservative cut that still leaves a
// populated board. Below 1.5% more than half survive and the word stops meaning anything.
// Raised from 2.0. At 2.0 a 2.1% relative move became an "important divergence" on the strength of
// crossing an arbitrary line, and the board filled with moves nobody would call a reaction. Against
// the measured distribution (median |1-session| 1.60%, p75 3.10%) a 3.5% relative requirement keeps
// roughly the top quartile — moves that are actually distinguishable from a normal day.
export const REACTION_FLOOR_PCT = 3.5;
export const REACTION_SATURATION_PCT = 8.0;

/**
 * Normalise a canonical reaction into R ∈ [-1,1], with an explicit dead zone.
 *
 * Structured so a volatility-aware floor (ATR or realised vol) can replace the fixed percentage
 * later without changing any caller: the floor is resolved through `floorPct`.
 */
export function normalizeReaction(reaction, { floorPct = REACTION_FLOOR_PCT, saturationPct = REACTION_SATURATION_PCT } = {}) {
  const h = reaction?.horizons || {};
  const one = h['1'] ?? h[1] ?? null;
  const five = h['5'] ?? h[5] ?? null;

  const abs = Number.isFinite(one?.return) ? one.return : null;
  const rel = Number.isFinite(one?.relative) ? one.relative : null;

  if (abs === null) {
    // NOT MEASURED is not NO REACTION. An unelapsed or unavailable window is unknown.
    return { R: null, R_eff: 0, meaningful: false, reason: 'not-measured', abs: null, rel: null, five: five?.return ?? null };
  }

  // BOTH gates. A move that is large only because the whole market moved is not a response.
  const clearsAbs = Math.abs(abs) >= floorPct;
  const clearsRel = rel === null ? false : Math.abs(rel) >= floorPct;
  const meaningful = clearsAbs && clearsRel;

  // Scale on the SPY-relative move when we have it: that is the part attributable to the company.
  const basis = rel === null ? abs : rel;
  const R = Math.max(-1, Math.min(1, basis / saturationPct));

  return {
    R: Math.round(R * 1000) / 1000,
    // ⚠️ R_eff IS ZERO INSIDE THE DEAD ZONE. Every downstream consumer reads R_eff, so no caller
    // can accidentally treat noise as a signal.
    R_eff: meaningful ? Math.round(R * 1000) / 1000 : 0,
    meaningful,
    reason: meaningful ? 'meaningful' : (!clearsAbs ? 'below-absolute-floor' : 'below-relative-floor'),
    abs: Math.round(abs * 100) / 100,
    rel: rel === null ? null : Math.round(rel * 100) / 100,
    five: Number.isFinite(five?.return) ? Math.round(five.return * 100) / 100 : null,
    floorPct,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// LAYER C — THE JOIN
// ════════════════════════════════════════════════════════════════════════════

export const JOIN = Object.freeze({
  PRICE_CONFIRMING: 'PRICE_CONFIRMING',
  PRICE_DIVERGING: 'PRICE_DIVERGING',
  EVIDENCE_BUILDING: 'EVIDENCE_BUILDING',
  SOURCES_CONFLICT: 'SOURCES_CONFLICT',
  NO_REACTION: 'NO_REACTION',
  INSUFFICIENT: 'INSUFFICIENT',
});

/** Two independent families disagreeing with comparable weight dominates the reading. */
export const CONFLICT_CHI = 0.45;

/**
 * What is price doing RELATIVE to the evidence?
 *
 * ⚠️ RESPECTS THE DEAD ZONE ABSOLUTELY. With R_eff = 0 the answer is never confirming and never
 * diverging — it is "no meaningful price response", which is a real and useful state rather than a
 * failure to classify.
 */
export function joinEvidenceMarket({ synthesis, reaction, significantFamilies = [] } = {}) {
  const { L, A, n, chi } = synthesis || {};
  const R = reaction?.R_eff ?? 0;
  const meaningfulFamilies = significantFamilies.filter((f) => f.significance >= MEANINGFUL_SIGNIFICANCE);

  const zero = { state: JOIN.INSUFFICIENT, T: 0, K_conf: 0, chi: chi ?? null };
  if (!n || !meaningfulFamilies.length) return zero;

  // ── GENUINE CROSS-SOURCE CONFLICT DOMINATES ──────────────────────────────
  //
  // Two meaningful independent families strongly opposing each other is the research question,
  // whatever price is doing. Flattening that into "slightly negative" because the arithmetic
  // barely leans would discard exactly the information the reader needs.
  if (n >= 2 && chi !== null && chi >= CONFLICT_CHI && meaningfulFamilies.length >= 2) {
    return { state: JOIN.SOURCES_CONFLICT, T: 0, K_conf: 0, chi };
  }

  if (!R) {
    return {
      state: n >= 1 ? JOIN.EVIDENCE_BUILDING : JOIN.NO_REACTION,
      T: 0, K_conf: 0, chi: chi ?? null,
      note: reaction?.reason === 'not-measured' ? 'not-measured' : 'below-floor',
    };
  }

  const lean = Number.isFinite(L) ? L : 0;
  const align = A ?? Math.abs(lean);
  const opposes = lean * R < 0;
  const magnitude = Math.round(align * Math.abs(lean) * Math.abs(R) * 1000) / 1000;

  return opposes
    ? { state: JOIN.PRICE_DIVERGING, T: magnitude, K_conf: 0, chi: chi ?? null }
    : { state: JOIN.PRICE_CONFIRMING, T: 0, K_conf: magnitude, chi: chi ?? null };
}

// ════════════════════════════════════════════════════════════════════════════
// RESEARCH PRIORITY — AN INTERNAL SORT KEY, NEVER DISPLAYED
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠️ P IS NOT A SCORE. It is never serialised to a user-facing field, never rendered, and carries
// no units. It exists so the board can be ordered by "most worth investigating now" instead of
// alphabetically. If it ever appears on screen, that is the 0-100 confluence score returning.
//
// The weights below start from the brief's suggestion and were then checked against real output.
// Divergence leads because price disagreeing with meaningful evidence is the least widely available
// observation; a fresh classified catalyst is the strongest "why now"; exceptional single-family
// significance is what rescues the INTC case.
// ⚠️ REWEIGHTED SO EVIDENCE LEADS. Under the previous weights, divergence and confirmation carried
// 55% of the ranking, so a company was promoted mainly for how its price behaved — which is Pit
// Scan's question, and it meant extraordinary evidence on a flat tape ranked near the bottom.
// Price is now a small tiebreak between comparable evidence cases; it can never carry a weak one.
export const WEIGHTS = Object.freeze({
  significance: 0.35,      // historically unusual, high-quality evidence
  breadth: 0.25,           // multiple independent meaningful families
  freshCatalyst: 0.20,     // a classified material filing
  conflict: 0.12,          // a genuine standoff worth investigating
  reaction: 0.08,          // secondary: price agreeing or disagreeing
});

// ════════════════════════════════════════════════════════════════════════════
// §1 — WHAT BELONGS ON THE *DEFAULT* BOARD
// ════════════════════════════════════════════════════════════════════════════
//
// Consensus is a research desk, not a filing archive. A 45-day-old ordinary insider filing is real
// evidence and stays in the record, on the ticker page and in any lookback view — it simply is not
// a reason to look at a company TODAY, and letting it sit on the default board pushed genuinely
// current situations down the page.
//
// Two gates, both measured on publicTime:
//
//   ordinary evidence   <= 5 trading days (7 calendar)
//   fresh catalysts     <= 72 hours
//
// ⚠️ WITH ONE EXCEPTION, AND ONLY ONE. Evidence the engine has certified as EXCEPTIONAL — a very
// large officer open-market purchase, a real cluster, a first-in-years act — survives the age gate,
// because "the CEO did something he has not done in three years" does not stop being worth knowing
// on day six. It still decays hard in ranking; it just is not silently dropped.
export const CURRENT_BOARD_DAYS = 7;
export const FRESH_CATALYST_HOURS = 72;

/**
 * Is this company a CURRENT research situation?
 *
 * @returns {{current: boolean, why: string, newestAgeMs: number|null}}
 */
export function isCurrent({ significantFamilies = [], freshCatalystAgeMs = null, now = Date.now() } = {}) {
  const meaningful = significantFamilies.filter((f) => f.significance >= MEANINGFUL_SIGNIFICANCE);
  if (!meaningful.length) return { current: false, why: 'no-meaningful-evidence', newestAgeMs: null };

  const ageOf = (f) => {
    const t = Date.parse(f.evidence?.publicTime);
    return Number.isFinite(t) ? now - t : Infinity;
  };
  const newestAgeMs = Math.min(...meaningful.map(ageOf));

  // A genuinely fresh catalyst is its own reason, on a tighter clock.
  if (Number.isFinite(freshCatalystAgeMs) && freshCatalystAgeMs <= FRESH_CATALYST_HOURS * 3_600_000) {
    return { current: true, why: 'fresh-catalyst', newestAgeMs };
  }
  if (newestAgeMs <= CURRENT_BOARD_DAYS * 86_400_000) {
    return { current: true, why: 'recent-evidence', newestAgeMs };
  }
  // THE EXCEPTION.
  const exceptional = meaningful.find((f) => f.significance >= EXCEPTIONAL_SIGNIFICANCE);
  if (exceptional) return { current: true, why: 'exceptional-evidence', newestAgeMs };

  return { current: false, why: 'stale', newestAgeMs };
}

// ════════════════════════════════════════════════════════════════════════════
// §6 — CONFIDENCE REFLECTS QUALITY AND FRESHNESS, NOT FAMILY COUNT
// ════════════════════════════════════════════════════════════════════════════
//
// "3 of 4 families" was producing High confidence on month-old evidence. Coverage is one input and
// the weakest one: a missing family is missing evidence, never contradicting evidence, and four
// stale families are not more trustworthy than one fresh strong one.
export const STALE_CONFIDENCE_DAYS = 14;   // ~10 trading days

export function evidenceConfidence({ significantFamilies = [], synthesis = null, newestAgeMs = null } = {}) {
  const meaningful = significantFamilies.filter((f) => f.significance >= MEANINGFUL_SIGNIFICANCE);
  if (!meaningful.length) return 'Low';

  const top = meaningful[0].significance;
  const exceptional = top >= EXCEPTIONAL_SIGNIFICANCE;
  // Independence excludes the near-universal institutional record.
  const independent = meaningful.filter((f) => f.family !== FAMILY.INSTITUTION).length;
  // ⚠️ THE QUALITY OF THE STRONGEST EVIDENCE, NOT THE AVERAGE. Congressional records are inherently
  // 0.6 (self-reported, banded, lagged), so averaging meant ADDING congressional corroboration to a
  // 0.95-quality Form 4 lowered confidence — punishing a company for having more evidence.
  const quality = Number.isFinite(meaningful[0].evidence?.quality) ? meaningful[0].evidence.quality : 0.5;
  const mass = Number.isFinite(synthesis?.M) ? synthesis.M : 0;
  const ageDays = Number.isFinite(newestAgeMs) ? newestAgeMs / 86_400_000 : Infinity;

  // ⚠️ AGE CAPS CONFIDENCE. Past ~10 trading days the only thing that still justifies confidence is
  // that the evidence itself was exceptional.
  if (ageDays > STALE_CONFIDENCE_DAYS && !exceptional) return 'Low';

  const strong = top >= 0.6 && quality >= 0.8 && mass >= 0.6;
  const moderate = top >= 0.45 && quality >= 0.65 && mass >= 0.3;

  if (strong && independent >= 2 && ageDays <= 7) return 'High';
  if (strong || (moderate && independent >= 2)) return 'Medium';
  return 'Low';
}

// ── DECAY ───────────────────────────────────────────────────────────────────
//
// The board surfaces what is worth investigating NOW. Without decay a company stays near the top
// for a week because something happened once. This controls BOARD PRIORITY ONLY — the evidence
// record itself is never deleted or hidden, and the ticker page is unchanged.
// Tightened: full weight for 48h, then falling to a hard floor by day 5 rather than day 7, so an
// ordinary older case cannot sit near the top of a board meant to show current situations.
export const DECAY_FULL_HOURS = 48;
export const DECAY_FLOOR_HOURS = 120;
export const DECAY_FLOOR = 0.12;
/** Historically unusual evidence decays to here rather than to DECAY_FLOOR. */
export const EXCEPTIONAL_DECAY_FLOOR = 0.65;

/** 1.0 for the first 48h, then falling to a floor of 0.25 by day 7. */
export function freshnessDecay(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return DECAY_FLOOR;
  const hours = ageMs / 3_600_000;
  if (hours <= DECAY_FULL_HOURS) return 1;
  if (hours >= DECAY_FLOOR_HOURS) return DECAY_FLOOR;
  const t = (hours - DECAY_FULL_HOURS) / (DECAY_FLOOR_HOURS - DECAY_FULL_HOURS);
  return Math.round((1 - t * (1 - DECAY_FLOOR)) * 1000) / 1000;
}

const CONF_H = { High: 1, Medium: 0.75, Low: 0.5 };

/**
 * The internal ordering value.
 *
 * @returns {number} unitless, unbounded-ish, for sorting only.
 */
export function researchPriority({ join, synthesis, significantFamilies = [], confidence = 'Low',
  freshCatalyst = false, youngestEvidenceAgeMs = null, stillDeveloping = false } = {}) {
  const H = CONF_H[confidence] ?? 0.5;
  const meaningful = significantFamilies.filter((f) => f.significance >= MEANINGFUL_SIGNIFICANCE);
  const top = significantFamilies[0]?.significance ?? 0;
  const exceptional = top >= EXCEPTIONAL_SIGNIFICANCE ? top : 0;

  // A. Historically unusual, high-quality evidence LEADS — §7A.
  //
  // Measured: with significance scaled linearly, INTC ranked 27th of 48 despite carrying the single
  // most unusual insider record on the board (a CEO buying $10.0M, the first officer open-market
  // purchase in 236 days). Multi-family conflicts out-ranked it by stacking breadth and conflict
  // terms. An observation the engine has certified as EXCEPTIONAL gets the full weight of this
  // term, so genuine rarity competes with breadth instead of losing to it.
  const significance = exceptional ? 1 : top;
  // B. Independent corroboration, excluding the near-universal institutional record.
  const independent = meaningful.filter((f) => f.family !== FAMILY.INSTITUTION).length;
  const breadth = Math.min(1, independent / 2);
  // C. A fresh classified catalyst.
  const cat = freshCatalyst ? 1 : 0;
  // D. A genuine standoff.
  const conflict = join?.state === JOIN.SOURCES_CONFLICT ? (synthesis?.chi ?? 0) : 0;
  // E. Price, secondary only.
  const reaction = Math.min(1, (join?.T || 0) + (join?.K_conf || 0));

  const base = WEIGHTS.significance * significance
    + WEIGHTS.breadth * breadth
    + WEIGHTS.freshCatalyst * cat
    + WEIGHTS.conflict * conflict
    + WEIGHTS.reaction * reaction;

  // Something still arriving keeps its priority; a lone old event decays. Exceptional significance
  // raises the floor, because a genuinely rare act stays research-worthy longer than an ordinary
  // one — without it INTC's $10.0M CEO purchase decayed out of sight at 37 days old.
  const raw = stillDeveloping ? 1 : freshnessDecay(youngestEvidenceAgeMs);
  const decay = exceptional ? Math.max(raw, EXCEPTIONAL_DECAY_FLOOR) : raw;

  return Math.round(H * base * decay * 10000) / 10000;
}
