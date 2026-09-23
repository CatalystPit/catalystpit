// PIT CONSENSUS V3 — EVIDENCE SETUPS.
//
// ── WHAT WAS WRONG WITH V2.1 AS A PRODUCT ──────────────────────────────────
//
// V2.1 is defensible arithmetic and a bad product. It answers "how do the four disclosure families
// line up?" and prints POSITIVE ALIGNMENT or BALANCED CONFLICT. A trader reading that learns the
// shape of a vote, not a reason to look. "Market Diverging" does not say what price did;
// "Institutions Positive" does not say that 448 managers hold it against 433 the quarter before.
//
// V3 keeps every V2.1 computation and asks a different question on top of it:
//
//     WHY IS THIS COMPANY WORTH INVESTIGATING RIGHT NOW?
//
// ── WHAT A SETUP IS, AND IS NOT ─────────────────────────────────────────────
//
// A setup is a NAMED, DETERMINISTIC PATTERN across canonical evidence. It is not a score, not a
// ranking of companies against each other, and not a claim about future price. Every qualification
// below is a boolean over facts the engine already computed; there is no weighting to tune and no
// number to inflate.
//
// ⚠️ NOT EVERY TICKER GETS A SETUP. This is the point. The V2.1 board showed 60 rows because 60
// candidates could be calculated — 17% of them a single weak institutional breadth record and
// nothing else. A board that answers "what deserves investigation" has to be willing to be short.
//
// ── WHAT THE DATA ACTUALLY SUPPORTS ─────────────────────────────────────────
//
// Measured in production before these archetypes were written (research/consensus-v3-capability-
// census.md). Two measurements shaped every rule here:
//
//   · Institutional evidence is present on 98% of tickers. It is BACKGROUND. Counting it as one of
//     "N independent families" inflates every count, so meaningful support is judged on the
//     engine's own materiality and quality, never on a family tally.
//   · Catalyst direction is `unknown` on 84% of 8-K records. A catalyst establishes WHEN, rarely
//     WHICH WAY. So catalysts trigger "why now" and the disclosure families supply direction —
//     which is the opposite of how a naive design would wire it.
//
// Two proposed archetypes were DROPPED for lack of data, not for lack of merit:
//   INSTITUTIONAL SHIFT     13F unusualness reads `insufficient_history` everywhere measured
//                           (breadth unusualness needs 4+ quarters); zero production examples.
//   FRESH EVIDENCE REVERSAL would need point-in-time snapshots of yesterday's evidence picture,
//                           which we deliberately do not fabricate from today's data.

import { FAMILY, freshness } from '../evidence/model.mjs';
import { CONSENSUS_STATE, MARKET } from './synthesis.mjs';
import { JOIN, MEANINGFUL_SIGNIFICANCE, EXCEPTIONAL_SIGNIFICANCE } from './evidence-model.mjs';

// ⚠️ BUMPED FOR V3.5. The materialization key is built from this, so leaving it unchanged would
// have let boards classified by the V3 archetype cascade keep serving as current after a
// methodology change that altered qualification, direction, the dead zone and ranking — the exact
// failure the versioned-key design exists to prevent.
export const SETUP_VERSION = 'consensus_v38a_setup';

// ── THE ARCHETYPES ──────────────────────────────────────────────────────────
// ⚠️ THE HEADLINE DESCRIBES EVIDENCE, NOT PRICE.
//
// V3.5 made PRICE_DIVERGENCE and PRICE_CONFIRMATION primary identities, which quietly turned
// Consensus into an intraday product: the headline answered "what is price doing?" — Pit Scan's
// question — instead of "what public evidence is worth investigating?". The price concepts are
// still computed and still shown, as a SECONDARY market line. They are no longer what the card is.
export const SETUP = Object.freeze({
  UNUSUAL_INSIDER_ACTIVITY: 'UNUSUAL_INSIDER_ACTIVITY',
  CROSS_SOURCE_CONFLICT: 'CROSS_SOURCE_CONFLICT',
  CROSS_SOURCE_ALIGNMENT: 'CROSS_SOURCE_ALIGNMENT',
  FRESH_MATERIAL_CATALYST: 'FRESH_MATERIAL_CATALYST',
  INSTITUTIONAL_CHANGE: 'INSTITUTIONAL_CHANGE',
  CONGRESS_ACTIVITY: 'CONGRESS_ACTIVITY',
  EVIDENCE_BUILDING: 'EVIDENCE_BUILDING',
  SINGLE_SOURCE_SIGNIFICANCE: 'SINGLE_SOURCE_SIGNIFICANCE',
  NO_ACTIVE_SETUP: 'NO_ACTIVE_SETUP',
  // Retained so existing consumers and stored rows do not break on an unknown key. No longer
  // produced as a PRIMARY identity — see marketState() for where price now lives.
  FRESH_CATALYST_SUPPORTED: 'FRESH_CATALYST_SUPPORTED',
  FRESH_CATALYST_CONTESTED: 'FRESH_CATALYST_CONTESTED',
  FRESH_CATALYST: 'FRESH_CATALYST',
  PRICE_DIVERGENCE: 'PRICE_DIVERGENCE',
  PRICE_CONFIRMATION: 'PRICE_CONFIRMATION',
  SINGLE_SOURCE: 'SINGLE_SOURCE',
});

export const SETUP_LABEL = Object.freeze({
  UNUSUAL_INSIDER_ACTIVITY: 'Unusual insider activity',
  CROSS_SOURCE_CONFLICT: 'Cross-source conflict',
  CROSS_SOURCE_ALIGNMENT: 'Cross-source alignment',
  FRESH_MATERIAL_CATALYST: 'Fresh material catalyst',
  INSTITUTIONAL_CHANGE: 'Institutional change',
  CONGRESS_ACTIVITY: 'Congress activity',
  EVIDENCE_BUILDING: 'Evidence building',
  SINGLE_SOURCE_SIGNIFICANCE: 'Single-source significance',
  NO_ACTIVE_SETUP: 'No active setup',
  FRESH_CATALYST_SUPPORTED: 'Fresh material catalyst',
  FRESH_CATALYST_CONTESTED: 'Fresh material catalyst',
  FRESH_CATALYST: 'Fresh catalyst',
  PRICE_DIVERGENCE: 'Price diverging from evidence',
  PRICE_CONFIRMATION: 'Price confirming evidence',
  SINGLE_SOURCE: 'Single-source evidence',
});

// ── WHAT MAKES A CATALYST "FRESH" ───────────────────────────────────────────
//
// The engine's own freshness tiers, measured on publicTime: `today` (24h) or `recent` (7d). Not a
// new threshold — the same one What Changed and the Watchlist digest read. An 8-K from three weeks
// ago is real and still available on the ticker page; it is not why you should look today.
const FRESH_TIERS = new Set(['today', 'recent']);

/** Material 8-K evidence that became public recently. `facts.material` is the engine's own flag. */
export function freshCatalysts(evidence, { now = Date.now() } = {}) {
  return (evidence || []).filter((e) => e.family === FAMILY.CATALYST
    && e.facts?.material === true
    && FRESH_TIERS.has(freshness(e, { now })));
}

/** Evidence carrying a historical-context claim history.mjs was willing to make. */
export function unusualEvidence(evidence, family = null) {
  return (evidence || []).filter((e) => (!family || e.family === family)
    && (e.context?.unusual === true
      || e.context?.boundedByCoverage === true
      || typeof e.context?.gapDays === 'number'));
}

// ── WHEN IS EVIDENCE MEANINGFUL ENOUGH TO SUPPORT OR CONTEST? ───────────────
//
// Reuses the V2.1 state rather than re-deriving anything. These are the states in which the
// disclosure evidence actually points somewhere.
const LEANING = new Set([
  CONSENSUS_STATE.POSITIVE_ALIGNMENT, CONSENSUS_STATE.NEGATIVE_ALIGNMENT,
  CONSENSUS_STATE.POSITIVE_LEAN_WITH_CONFLICT, CONSENSUS_STATE.NEGATIVE_LEAN_WITH_CONFLICT,
]);
const CONTESTED = new Set([
  CONSENSUS_STATE.BALANCED_CONFLICT,
  CONSENSUS_STATE.POSITIVE_LEAN_WITH_CONFLICT, CONSENSUS_STATE.NEGATIVE_LEAN_WITH_CONFLICT,
]);

export const hasLean = (state) => LEANING.has(state);
export const isContested = (state) => CONTESTED.has(state);

/**
 * Independent DISCLOSURE families that actually point somewhere, excluding institutions unless
 * institutions are the only thing speaking.
 *
 * ⚠️ WHY INSTITUTIONS ARE DISCOUNTED. 13F breadth exists for 98% of tickers, so counting it as an
 * independent corroborating family makes "two families agree" nearly universal and therefore
 * meaningless. It is still shown, still contributes to V2.1, and still provides context — it just
 * cannot by itself make a company interesting.
 */
/** Families in a list that are not the near-universal institutional record. */
export function nonInstitutional(list) {
  return (list || []).filter((f) => f.family !== 'institutions');
}

/**
 * Did any DISCLOSURE record (not the standing 13F breadth reading) become public in the last 7
 * days? Used to separate evidence that is still developing from a company's standing position.
 */
export function recentDisclosure(evidence, now = Date.now()) {
  return (evidence || []).some((e) => e.family !== FAMILY.INSTITUTION
    && FRESH_30.has(freshness(e, { now })));
}
// today|recent only — 7 days. The 'active' tier runs to 30-45 days per family, which is long
// enough that almost any company with an insider record would qualify as 'still developing'.
const FRESH_30 = new Set(['today', 'recent']);

export function corroboratingFamilies(canonical) {
  const dirs = [...(canonical?.drivers || []), ...(canonical?.opposition || [])];
  return dirs.filter((f) => f.family !== 'institutions').map((f) => f.family);
}

// ── QUALIFICATION (V3.5) ────────────────────────────────────────────────────
//
// ⚠️ LABELS ARE OUTPUTS, NOT GATES. In V3 the setup archetypes decided which evidence was allowed
// into the system, and that hid real situations: INTC's CEO bought $10.0M — the first officer
// open-market purchase in 236 days, at High confidence with price confirming — and the board never
// showed it. Qualification now asks only whether MATERIAL EVIDENCE exists; the label is chosen
// afterwards from the join.

/**
 * Does this company warrant research at all?
 *
 * Any ONE of these is sufficient. They are deliberately independent so that a single exceptional
 * family can qualify a ticker with no second family present, and so that missing families never
 * penalise one.
 */
export function qualifies({ significantFamilies = [], freshCatalyst = false, reaction = null, synthesis = null } = {}) {
  const meaningful = significantFamilies.filter((f) => f.significance >= MEANINGFUL_SIGNIFICANCE);
  const exceptional = significantFamilies.filter((f) => f.significance >= EXCEPTIONAL_SIGNIFICANCE);

  // ⚠️ INSTITUTIONS CANNOT QUALIFY A TICKER. 13F breadth is present for 98% of companies and scores
  // meaningfully often, so counting it as "a meaningful family" let a fresh 8-K plus the standing
  // institutional record qualify almost everything — 121 of 150 candidates in one measured pass.
  // Institutions still contribute to synthesis, still appear on the card, and still provide
  // context; they simply cannot be the reason a company is on the board.
  const qualifying = meaningful.filter((f) => f.family !== FAMILY.INSTITUTION);
  // ⚠️ AND A FILING ALONE IS NEVER EXCEPTIONAL. The exceptional path exists for a genuinely rare
  // act — a CEO buying after 236 quiet days. An 8-K is a scheduled obligation that thousands of
  // companies meet every week; it qualifies a ticker only alongside other evidence, which is what
  // the fresh-catalyst-with-evidence branch below is for.
  const exceptionalQualifying = exceptional.filter((f) => f.family !== FAMILY.INSTITUTION
    && f.family !== FAMILY.CATALYST);

  if (exceptionalQualifying.length) return { ok: true, why: 'exceptional-single-family' };

  // ⚠️ HISTORICAL RARITY QUALIFIES ON ITS OWN. ALK carries "First officer open-market purchase in
  // our 1-year history" at significance 0.584 — meaningful, but just under the exceptional bar —
  // and with no second family it had no way onto the board at all. Company-specific rarity is the
  // most valuable thing the evidence engine produces; a claim history.mjs was willing to make is a
  // reason to look even when only one family is speaking.
  const unusualQualifying = qualifying.filter((f) => f.evidence?.context?.unusual === true
    || f.evidence?.context?.boundedByCoverage === true
    || typeof f.evidence?.context?.gapDays === 'number');
  if (unusualQualifying.length) return { ok: true, why: 'historically-unusual-evidence' };
  // Two meaningful families where at least one is a disclosure other than 13F.
  if (qualifying.length >= 1 && meaningful.length >= 2) return { ok: true, why: 'multiple-meaningful-families' };
  // ⚠️ A CATALYST CANNOT CORROBORATE ITSELF. The supporting family must be something other than the
  // filing that triggered the question, or "fresh 8-K + that same 8-K" would qualify everything.
  const corroborating = qualifying.filter((f) => f.family !== FAMILY.CATALYST);
  if (freshCatalyst && corroborating.length >= 1) return { ok: true, why: 'fresh-catalyst-with-evidence' };
  // ⚠️ THERE IS DELIBERATELY NO PRICE PATH HERE.
  //
  // V3.5 qualified a ticker when a meaningful price move accompanied one meaningful family. That
  // made price a route INTO Consensus, which is Pit Scan's job, and it meant a company with
  // extraordinary public evidence and a flat tape could be admitted only if something else fired.
  // Price is context on the card; it can never be the reason a company is on the board, and its
  // absence can never remove one.
  void reaction;
  return { ok: false, why: 'no-material-evidence' };
}

/**
 * The human-readable label, derived from the join.
 *
 * Precedence is deterministic and most-specific-first. A ticker satisfying several patterns always
 * resolves to the same primary; the rest become secondary rather than a row of badges.
 */
export function labelFor({ join, significantFamilies = [], freshCatalyst = false, freshCatalystEvidence = null, synthesis = null } = {}) {
  const secondary = [];
  const reasons = [];
  const meaningful = significantFamilies.filter((f) => f.significance >= MEANINGFUL_SIGNIFICANCE);
  const top = (fam) => significantFamilies.find((f) => f.family === fam);
  const exceptional = (fam) => {
    const f = top(fam);
    return f && f.significance >= EXCEPTIONAL_SIGNIFICANCE ? f : null;
  };
  const insiderExceptional = exceptional(FAMILY.INSIDER);
  const unusual = (f) => Boolean(f?.evidence?.context?.unusual || f?.evidence?.context?.boundedByCoverage
    || typeof f?.evidence?.context?.gapDays === 'number');

  // Price findings are recorded as SECONDARY characteristics, never as the identity.
  if (join?.state === JOIN.PRICE_DIVERGING) secondary.push('MARKET_DIVERGING');
  if (join?.state === JOIN.PRICE_CONFIRMING) secondary.push('MARKET_CONFIRMING');

  // ── 1. HISTORICALLY UNUSUAL INSIDER ACTIVITY ─────────────────────────────
  // The rarest and most specific thing we can say about a company, and the reason INTC must be
  // able to rank prominently on a completely flat tape.
  if (insiderExceptional) {
    reasons.push(insiderExceptional.evidence?.context?.text
      || insiderExceptional.evidence?.summary || 'Exceptional insider activity');
    return { setup: SETUP.UNUSUAL_INSIDER_ACTIVITY, reasons, secondary };
  }

  // ⚠️ MEANINGFUL OPPOSITION IS A CONFLICT, WHATEVER ELSE IS TRUE. This runs before the catalyst
  // branch because a fresh filing does not resolve a disagreement — TELA shipped labelled "Fresh
  // material catalyst" above a sentence describing insider buying against a delisting notice.
  const dirOfEv = (f) => f.evidence?.direction;
  const posM = meaningful.filter((f) => dirOfEv(f) === 'positive');
  const negM = meaningful.filter((f) => dirOfEv(f) === 'negative');
  if (posM.length && negM.length) {
    reasons.push('Meaningful evidence points in both directions');
    return { setup: SETUP.CROSS_SOURCE_CONFLICT, reasons, secondary };
  }

  // ── 2. INDEPENDENT SOURCES GENUINELY DISAGREE ────────────────────────────
  if (join?.state === JOIN.SOURCES_CONFLICT) {
    reasons.push('Independent sources disagree with comparable weight');
    return { setup: SETUP.CROSS_SOURCE_CONFLICT, reasons, secondary };
  }

  // ── 3. A FRESH MATERIAL CATALYST ─────────────────────────────────────────
  const corroborating = meaningful.filter((f) => f.family !== FAMILY.CATALYST
    && f.family !== FAMILY.INSTITUTION);
  if (freshCatalyst && corroborating.length >= 1) {
    reasons.push(`${freshCatalystEvidence?.summary || 'A material filing'} became public recently`);
    return { setup: SETUP.FRESH_MATERIAL_CATALYST, reasons, secondary };
  }

  // ── 4. INDEPENDENT SOURCES AGREE ─────────────────────────────────────────
  //
  // ⚠️ ALIGNMENT MEANS THEY ACTUALLY AGREE. A high |L| alone is not enough: INM shipped as
  // "cross-source alignment" with institutions positive and a delisting catalyst negative, because
  // one side simply outweighed the other. If a MEANINGFUL family points the other way, that is a
  // conflict, whatever the arithmetic says.
  if (meaningful.length >= 2 && Number.isFinite(synthesis?.A) && synthesis.A >= 0.6) {
    reasons.push('Multiple independent sources point the same way');
    return { setup: SETUP.CROSS_SOURCE_ALIGNMENT, reasons, secondary };
  }

  // ── 5. A SINGLE FAMILY THAT IS UNUSUAL ON ITS OWN ────────────────────────
  const instTop = top(FAMILY.INSTITUTION);
  if (instTop && instTop.significance >= MEANINGFUL_SIGNIFICANCE && unusual(instTop)
    && corroborating.length === 0) {
    reasons.push(instTop.evidence?.context?.text || 'Meaningful institutional change');
    return { setup: SETUP.INSTITUTIONAL_CHANGE, reasons, secondary };
  }
  const conTop = top(FAMILY.CONGRESS);
  if (conTop && conTop.significance >= MEANINGFUL_SIGNIFICANCE && meaningful.length === 1) {
    reasons.push(conTop.evidence?.context?.text || conTop.evidence?.summary || 'Congressional disclosure activity');
    return { setup: SETUP.CONGRESS_ACTIVITY, reasons, secondary };
  }

  // ── 6. EVIDENCE ACCUMULATING ─────────────────────────────────────────────
  if (meaningful.length >= 2) {
    reasons.push('Multiple independent families carry meaningful evidence');
    return { setup: SETUP.EVIDENCE_BUILDING, reasons, secondary };
  }
  if (meaningful.length === 1) {
    reasons.push(meaningful[0].evidence?.context?.text
      || `${meaningful[0].family} evidence is meaningful on its own`);
    return { setup: SETUP.SINGLE_SOURCE_SIGNIFICANCE, reasons, secondary };
  }

  return { setup: SETUP.NO_ACTIVE_SETUP, reasons: ['No material evidence currently'], secondary: [] };
}

/**
 * THE SECONDARY MARKET LINE.
 *
 * Price is context. It is never forced into "confirming" or "diverging": inside the dead zone, or
 * with no recent public event to measure from, the honest answer is that there is no meaningful
 * reaction — which is a real state, not a missing one.
 */
export const MARKET_STATE = Object.freeze({
  CONFIRMING: 'CONFIRMING', DIVERGING: 'DIVERGING',
  NO_REACTION: 'NO_REACTION', NOT_MEASURED: 'NOT_MEASURED', MIXED: 'MIXED',
});
export const MARKET_STATE_LABEL = Object.freeze({
  CONFIRMING: 'Confirming', DIVERGING: 'Diverging',
  NO_REACTION: 'No meaningful reaction', NOT_MEASURED: 'Not measured', MIXED: 'Mixed',
});
export function marketState({ join, reaction, direction = null, setup = null } = {}) {
  if (!reaction || reaction.reason === 'not-measured') return MARKET_STATE.NOT_MEASURED;
  if (!reaction.meaningful) return MARKET_STATE.NO_REACTION;

  // ⚠️ PRICE CANNOT CONFIRM A THESIS THAT DOES NOT EXIST. An officer change plus insider selling
  // plus a rising tape was reading "confirming" — confirming WHAT? Without a coherent directional
  // reading there is nothing for price to agree with, and a conflict is not resolved by the tape.
  const incoherent = direction === 'MIXED' || setup === SETUP.CROSS_SOURCE_CONFLICT;
  if (incoherent) return MARKET_STATE.MIXED;

  if (join?.state === JOIN.PRICE_CONFIRMING) return MARKET_STATE.CONFIRMING;
  if (join?.state === JOIN.PRICE_DIVERGING) return MARKET_STATE.DIVERGING;
  return MARKET_STATE.MIXED;
}

/** Does this ticker belong on the active board? */
const INACTIVE = new Set([SETUP.NO_ACTIVE_SETUP, SETUP.FRESH_CATALYST]);
export const isActive = (setup) => !INACTIVE.has(setup);

// ── DIRECTION ───────────────────────────────────────────────────────────────
//
// Kept as a SECONDARY concept per §15. It summarises where the disclosure evidence leans; it is not
// the reason the ticker is here, and it never describes price.
/**
 * ⚠️ DIRECTION COMES FROM LAYER A, NOT FROM THE V2.1 STATE.
 *
 * Measured live: TNON reported POSITIVE while its evidence lean L was -0.455, because direction was
 * read from V2.1's canonical state while every other number on the card came from the V3.5
 * synthesis. Those are two different family universes and they can disagree. One lean, one
 * direction, one sentence — the V2.1 state stays on the row as secondary metadata.
 *
 * The deadband exists because a lean of 0.05 is not a direction.
 */
export const DIRECTION_DEADBAND = 0.2;
export function leanDirection(synthesis) {
  const L = synthesis?.L;
  if (!Number.isFinite(L) || !synthesis?.n) return 'MIXED';
  if (L >= DIRECTION_DEADBAND) return 'POSITIVE';
  if (L <= -DIRECTION_DEADBAND) return 'NEGATIVE';
  return 'MIXED';
}

/** Retained for consumers that still read the V2.1 state directly. */
export function setupDirection(canonical) {
  switch (canonical?.state) {
    case CONSENSUS_STATE.POSITIVE_ALIGNMENT:
    case CONSENSUS_STATE.POSITIVE_LEAN_WITH_CONFLICT:
      return 'POSITIVE';
    case CONSENSUS_STATE.NEGATIVE_ALIGNMENT:
    case CONSENSUS_STATE.NEGATIVE_LEAN_WITH_CONFLICT:
      return 'NEGATIVE';
    default:
      return 'MIXED';
  }
}

// ── ORDERING ────────────────────────────────────────────────────────────────
//
// "Most relevant to investigate now", NOT "best stock". Every term is an observable property of
// evidence. There is no visible number and nothing here is derived from returns.
const SETUP_RANK = Object.freeze({
  UNUSUAL_INSIDER_ACTIVITY: 0,
  CROSS_SOURCE_ALIGNMENT: 1,
  CROSS_SOURCE_CONFLICT: 2,
  FRESH_MATERIAL_CATALYST: 3,
  INSTITUTIONAL_CHANGE: 4,
  CONGRESS_ACTIVITY: 5,
  EVIDENCE_BUILDING: 6,
  SINGLE_SOURCE_SIGNIFICANCE: 7,
  // Legacy keys, ranked where their evidence meaning falls rather than by their price name.
  FRESH_CATALYST_SUPPORTED: 3, FRESH_CATALYST_CONTESTED: 2, FRESH_CATALYST: 8,
  PRICE_DIVERGENCE: 6, PRICE_CONFIRMATION: 7, SINGLE_SOURCE: 7,
  NO_ACTIVE_SETUP: 99,
});
const CONF_RANK = { High: 0, Medium: 1, Low: 2 };

/** Ordering is by the INTERNAL research priority. It is a sort key and is never displayed. */
export function setupOrderKey(row) {
  const s = row?.setup;
  return {
    // Higher priority sorts first, so it is negated.
    priority: -(row?.priority ?? 0),
    rank: SETUP_RANK[s?.setup] ?? 99,
    // Freshest driving event first within an archetype.
    age: Number.isFinite(s?.whyNowAgeMs) ? s.whyNowAgeMs : Number.MAX_SAFE_INTEGER,
    unusual: s?.unusualCount ? 0 : 1,
    confidence: CONF_RANK[row?.canonical?.confidence] ?? 3,
    families: -(row?.canonical?.coverage?.active ?? 0),
    ticker: row?.ticker || '',
  };
}

const ORDER_TERMS = ['priority', 'rank', 'age', 'unusual', 'confidence', 'families'];

export function orderSetups(rows) {
  return [...(rows || [])].sort((a, b) => {
    const ka = setupOrderKey(a), kb = setupOrderKey(b);
    for (const t of ORDER_TERMS) if (ka[t] !== kb[t]) return ka[t] - kb[t];
    return String(ka.ticker).localeCompare(String(kb.ticker));
  });
}

// ── BOARD FILTERS ───────────────────────────────────────────────────────────
//
// Every filter maps to an archetype that genuinely occurs in production. An archetype with no
// current examples does not get a decorative filter.
export const SETUP_FILTERS = Object.freeze([
  { key: 'all', label: 'All' },
  // ⚠️ THESE FILTER ON THE DIRECTION THE CARDS ALREADY SHOW — filterSetups' existing `direction`
  // predicate reads setup.direction, the same canonical value the card headline renders. No second
  // classification, no new scoring: a row is in Positive here precisely because its card says
  // Positive, so the pill can never disagree with what it filters to.
  { key: 'positive', label: 'Positive', direction: 'POSITIVE' },
  { key: 'negative', label: 'Negative', direction: 'NEGATIVE' },
  { key: 'insider', label: 'Unusual insiders', setups: [SETUP.UNUSUAL_INSIDER_ACTIVITY] },
  { key: 'catalyst', label: 'Fresh catalyst', setups: [SETUP.FRESH_MATERIAL_CATALYST, SETUP.FRESH_CATALYST_SUPPORTED, SETUP.FRESH_CATALYST_CONTESTED] },
  { key: 'alignment', label: 'Cross-source alignment', setups: [SETUP.CROSS_SOURCE_ALIGNMENT] },
  { key: 'conflict', label: 'Cross-source conflict', setups: [SETUP.CROSS_SOURCE_CONFLICT] },
  { key: 'institutions', label: 'Institutional change', setups: [SETUP.INSTITUTIONAL_CHANGE] },
  { key: 'congress', label: 'Congress activity', setups: [SETUP.CONGRESS_ACTIVITY] },
  { key: 'building', label: 'Evidence building', setups: [SETUP.EVIDENCE_BUILDING, SETUP.SINGLE_SOURCE_SIGNIFICANCE, SETUP.SINGLE_SOURCE] },
  // SECONDARY. Market reaction remains discoverable, but it is not how the board is organised.
  { key: 'confirming', label: 'Market confirming', market: 'CONFIRMING' },
  { key: 'diverging', label: 'Market diverging', market: 'DIVERGING' },
]);

export function filterSetups(rows, key = 'all') {
  const list = rows || [];
  if (!key || key === 'all') return list;
  const f = SETUP_FILTERS.find((x) => x.key === key);
  if (!f) return list;
  if (f.direction) return list.filter((r) => r.setup?.direction === f.direction);
  if (f.market) return list.filter((r) => r.setup?.marketState === f.market);
  return list.filter((r) => f.setups.includes(r.setup?.setup));
}
