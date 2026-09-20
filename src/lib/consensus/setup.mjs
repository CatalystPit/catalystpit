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

export const SETUP_VERSION = 'consensus_v3_setup';

// ── THE ARCHETYPES ──────────────────────────────────────────────────────────
export const SETUP = Object.freeze({
  FRESH_CATALYST_SUPPORTED: 'FRESH_CATALYST_SUPPORTED',
  FRESH_CATALYST_CONTESTED: 'FRESH_CATALYST_CONTESTED',
  FRESH_CATALYST: 'FRESH_CATALYST',
  PRICE_DIVERGENCE: 'PRICE_DIVERGENCE',
  PRICE_CONFIRMATION: 'PRICE_CONFIRMATION',
  UNUSUAL_INSIDER_ACTIVITY: 'UNUSUAL_INSIDER_ACTIVITY',
  CROSS_SOURCE_CONFLICT: 'CROSS_SOURCE_CONFLICT',
  EVIDENCE_BUILDING: 'EVIDENCE_BUILDING',
  NO_ACTIVE_SETUP: 'NO_ACTIVE_SETUP',
});

export const SETUP_LABEL = Object.freeze({
  FRESH_CATALYST_SUPPORTED: 'Fresh catalyst, evidence supports',
  FRESH_CATALYST_CONTESTED: 'Fresh catalyst, evidence contests',
  FRESH_CATALYST: 'Fresh catalyst',
  PRICE_DIVERGENCE: 'Price diverging from evidence',
  PRICE_CONFIRMATION: 'Price confirming evidence',
  UNUSUAL_INSIDER_ACTIVITY: 'Unusual insider activity',
  CROSS_SOURCE_CONFLICT: 'Cross-source conflict',
  EVIDENCE_BUILDING: 'Evidence building',
  NO_ACTIVE_SETUP: 'No active setup',
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

// ── QUALIFICATION ───────────────────────────────────────────────────────────

/**
 * Does this company have an active setup, and which one is PRIMARY?
 *
 * Precedence is most-specific-first and fully deterministic: a ticker satisfying several patterns
 * always resolves to the same primary, and the others are reported as secondary rather than
 * plastered across the card as five badges.
 *
 * @param {object} input
 * @param {object} input.canonical  the V2.1 canonical consensus (states, drivers, market, coverage)
 * @param {Array}  input.evidence   canonical evidence_v1 records for this ticker
 * @param {object} [input.reaction] market reaction anchored to the driving event's publicTime
 */
export function classifySetup({ canonical, evidence, now = Date.now() } = {}) {
  const state = canonical?.state;
  const market = canonical?.market?.confirmation;
  const fresh = freshCatalysts(evidence, { now });
  const corroborating = corroboratingFamilies(canonical);
  const unusualInsider = unusualEvidence(evidence, FAMILY.INSIDER);
  const unusualAny = unusualEvidence(evidence);

  const reasons = [];
  const secondary = [];

  // Nothing to say at all. NO_EVIDENCE is the engine's own verdict, not an absence of data.
  if (!state || state === CONSENSUS_STATE.NO_EVIDENCE) {
    return { setup: SETUP.NO_ACTIVE_SETUP, reasons: ['No disclosure family holds qualifying evidence'], secondary: [] };
  }

  // ── 1. A FRESH MATERIAL CATALYST IS THE STRONGEST "WHY NOW" ───────────────
  //
  // Something material became public in the last week. That is a reason to look today regardless of
  // what the slower families say, so it outranks every other pattern.
  if (fresh.length) {
    reasons.push(`Material company filing became public ${fresh.length > 1 ? `(${fresh.length} filings) ` : ''}within the last 7 days`);
    if (market === MARKET.DIVERGING) secondary.push(SETUP.PRICE_DIVERGENCE);
    if (market === MARKET.CONFIRMING) secondary.push(SETUP.PRICE_CONFIRMATION);
    if (unusualInsider.length) secondary.push(SETUP.UNUSUAL_INSIDER_ACTIVITY);

    // Contested beats supported: an unresolved disagreement is the more urgent research question.
    if (isContested(state) && canonical?.opposition?.length) {
      reasons.push('Independent disclosure evidence points against the prevailing reading');
      return { setup: SETUP.FRESH_CATALYST_CONTESTED, reasons, secondary };
    }
    if (hasLean(state) && corroborating.length >= 1) {
      reasons.push('Independent disclosure evidence points the same way');
      return { setup: SETUP.FRESH_CATALYST_SUPPORTED, reasons, secondary };
    }

    // ── A DIRECTIONAL FILING WITH CORROBORATION ───────────────────────────
    //
    // Found by inspecting GOLD, which the first version of these rules dropped: a negative auditor
    // change filed one day ago alongside $7.0M of insider selling two days ago. V2.1 reads MIXED
    // there because the total directional mass falls just under its floor — and that is V2.1
    // answering its OWN question correctly ("can I name an overall direction?").
    //
    // This asks a narrower one: does a filing that itself carries a direction have an independent
    // family pointing the same way? That is a real research question whether or not the aggregate
    // crosses a threshold, and it does not override V2.1 — the row still reports MIXED as its
    // direction, because that remains the honest summary of the whole picture.
    const directional = fresh.filter((c) => c.direction === 'positive' || c.direction === 'negative');
    if (directional.length) {
      const way = directional[0].direction;
      // Read the agreeing families from the EVIDENCE RECORDS, not from canonical.drivers. For a
      // MIXED state — which is exactly the case this rule exists to catch — drivers and opposition
      // are deliberately empty, so matching against them would always find nothing.
      const agreeing = [...new Set((evidence || [])
        .filter((e) => e.family !== FAMILY.CATALYST && e.family !== FAMILY.INSTITUTION
          && e.direction === way)
        .map((e) => e.family))];
      if (agreeing.length) {
        reasons.push(`The filing itself reads ${way}, and ${agreeing.join(' and ')} evidence points the same way`);
        return { setup: SETUP.FRESH_CATALYST_SUPPORTED, reasons, secondary };
      }
    }
    // ⚠️ A FRESH FILING ALONE IS NOT A SETUP. Measured market-wide, material 8-Ks are filed
    // constantly — selecting on them put 75 bare catalysts on the board in one pass, which is the
    // "what our database can calculate" failure in a new costume. A catalyst establishes WHEN;
    // without a disclosure family resolving a direction there is no question to investigate, and
    // the filing is still one click away on the ticker page.
    return { setup: SETUP.FRESH_CATALYST, reasons, secondary };
  }

  // ── 2. PRICE DISAGREEING WITH MEANINGFUL EVIDENCE ─────────────────────────
  //
  // Requires BOTH a real evidence lean and a supported market reading. Divergence against a mixed
  // or single-source picture is not divergence, it is noise with a label.
  if (market === MARKET.DIVERGING && hasLean(state) && corroborating.length >= 1) {  // eslint-disable-line
    reasons.push('Disclosure evidence has a clear direction and price is moving against it');
    if (unusualInsider.length) secondary.push(SETUP.UNUSUAL_INSIDER_ACTIVITY);
    return { setup: SETUP.PRICE_DIVERGENCE, reasons, secondary };
  }

  // ── 3. HISTORICALLY UNUSUAL INSIDER BEHAVIOUR ─────────────────────────────
  //
  // Scarce by construction — 13% of the board carries any historical claim at all — which is
  // exactly what makes it worth a place. Placed above confirmation because "the CEO did something
  // he has not done in our whole history" is a better reason to look than "price agrees".
  if (unusualInsider.length) {
    reasons.push(unusualInsider[0].context?.text || 'Historically unusual insider activity');
    if (market === MARKET.CONFIRMING) secondary.push(SETUP.PRICE_CONFIRMATION);
    if (market === MARKET.DIVERGING) secondary.push(SETUP.PRICE_DIVERGENCE);
    return { setup: SETUP.UNUSUAL_INSIDER_ACTIVITY, reasons, secondary };
  }

  // ── 4. A GENUINE STANDOFF ─────────────────────────────────────────────────
  // Both sides must carry non-institutional weight. A "conflict" where one side is only the 13F
  // breadth record — present on 98% of tickers — is not a cross-source disagreement worth a card.
  if (state === CONSENSUS_STATE.BALANCED_CONFLICT
    && nonInstitutional(canonical?.drivers).length >= 1
    && nonInstitutional(canonical?.opposition).length >= 1) {
    reasons.push('Independent sources point in opposite directions with comparable weight');
    return { setup: SETUP.CROSS_SOURCE_CONFLICT, reasons, secondary };
  }

  // ── 5. PRICE AGREEING WITH MEANINGFUL EVIDENCE ────────────────────────────
  // ⚠️ THE HIGHEST BAR ON THE BOARD. "Price agrees with the evidence" is the least actionable thing
  // we can say — it is the absence of a question. It earns a card only when two or more independent
  // non-institutional families agree, which is genuinely uncommon.
  if (market === MARKET.CONFIRMING && hasLean(state) && corroborating.length >= 2) {
    reasons.push('Two or more independent disclosure families agree and price is moving with them');
    return { setup: SETUP.PRICE_CONFIRMATION, reasons, secondary };
  }

  // ── 6. EVIDENCE ACCUMULATING WITHOUT A TRIGGER ────────────────────────────
  //
  // No fresh catalyst and no price story, but two or more independent non-institutional families
  // point the same way. The reason to look is the accumulation itself.
  // Accumulation is only a setup if it is still accumulating. Without a fresh catalyst, at least
  // one disclosure record must itself have become public recently — otherwise this is a description
  // of a company's standing position, which the ticker page already covers.
  if (hasLean(state) && corroborating.length >= 2 && recentDisclosure(evidence, now)) {
    reasons.push('Multiple independent disclosure families point the same way without a fresh trigger');
    if (unusualAny.length) secondary.push(SETUP.UNUSUAL_INSIDER_ACTIVITY);
    return { setup: SETUP.EVIDENCE_BUILDING, reasons, secondary };
  }

  // ── 7. WE HAVE DATA. THAT IS NOT THE SAME AS SOMETHING TO LOOK AT. ────────
  return { setup: SETUP.NO_ACTIVE_SETUP, reasons: ['No fresh catalyst, unusual evidence or price disagreement'], secondary: [] };
}

/** Does this ticker belong on the active board? */
const INACTIVE = new Set([SETUP.NO_ACTIVE_SETUP, SETUP.FRESH_CATALYST]);
export const isActive = (setup) => !INACTIVE.has(setup);

// ── DIRECTION ───────────────────────────────────────────────────────────────
//
// Kept as a SECONDARY concept per §15. It summarises where the disclosure evidence leans; it is not
// the reason the ticker is here, and it never describes price.
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
  FRESH_CATALYST_CONTESTED: 0,
  FRESH_CATALYST_SUPPORTED: 1,
  FRESH_CATALYST: 2,
  PRICE_DIVERGENCE: 3,
  UNUSUAL_INSIDER_ACTIVITY: 4,
  CROSS_SOURCE_CONFLICT: 5,
  PRICE_CONFIRMATION: 6,
  EVIDENCE_BUILDING: 7,
  NO_ACTIVE_SETUP: 99,
});
const CONF_RANK = { High: 0, Medium: 1, Low: 2 };

export function setupOrderKey(row) {
  const s = row?.setup;
  return {
    rank: SETUP_RANK[s?.setup] ?? 99,
    // Freshest driving event first within an archetype.
    age: Number.isFinite(s?.whyNowAgeMs) ? s.whyNowAgeMs : Number.MAX_SAFE_INTEGER,
    unusual: s?.unusualCount ? 0 : 1,
    confidence: CONF_RANK[row?.canonical?.confidence] ?? 3,
    families: -(row?.canonical?.coverage?.active ?? 0),
    ticker: row?.ticker || '',
  };
}

const ORDER_TERMS = ['rank', 'age', 'unusual', 'confidence', 'families'];

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
  { key: 'all', label: 'All setups' },
  { key: 'catalyst', label: 'Fresh catalysts', setups: [SETUP.FRESH_CATALYST_SUPPORTED, SETUP.FRESH_CATALYST_CONTESTED] },
  { key: 'divergence', label: 'Price divergence', setups: [SETUP.PRICE_DIVERGENCE] },
  { key: 'confirmation', label: 'Price confirmation', setups: [SETUP.PRICE_CONFIRMATION] },
  { key: 'insider', label: 'Unusual insider', setups: [SETUP.UNUSUAL_INSIDER_ACTIVITY] },
  { key: 'conflict', label: 'Cross-source conflict', setups: [SETUP.CROSS_SOURCE_CONFLICT, SETUP.FRESH_CATALYST_CONTESTED] },
  { key: 'building', label: 'Evidence building', setups: [SETUP.EVIDENCE_BUILDING] },
  { key: 'positive', label: 'Positive', direction: 'POSITIVE' },
  { key: 'negative', label: 'Negative', direction: 'NEGATIVE' },
]);

export function filterSetups(rows, key = 'all') {
  const list = rows || [];
  if (!key || key === 'all') return list;
  const f = SETUP_FILTERS.find((x) => x.key === key);
  if (!f) return list;
  if (f.direction) return list.filter((r) => r.setup?.direction === f.direction);
  return list.filter((r) => f.setups.includes(r.setup?.setup));
}
