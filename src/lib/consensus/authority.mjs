// WHO IS ALLOWED TO NAME A DIRECTION — AND WHO MAY ONLY AGREE WITH ONE.
//
// ⚠️ THE PROBLEM THIS SOLVES. V2 gives every active family an equal vote, so ANY dissenter drops
// the reading out of alignment. Measured on the live board, three of the five public rows read
// "Cross-source conflict" — and the dissenting votes were being cast by the weakest evidence we
// hold:
//
//   institutions   present on 98% of ALL tickers, and a full quarter stale. The engine already
//                  forbids it from QUALIFYING a ticker for exactly this reason (setup.mjs:186) —
//                  but it was still allowed to VETO a direction.
//   catalysts      direction is `unknown` on 84% of 8-K records. setup.mjs:33 says it outright:
//                  "a catalyst establishes WHEN, rarely WHICH WAY." A routine officer departure
//                  scores -0.2 and cancelled a real insider purchase.
//   structure      measured over 112,620 samples as "a coin flip about the window it is displayed
//                  over" (evidence.js:359). Already excluded from the aggregate; stays excluded.
//
// TELA on the live board: insiders bullish, institutions accumulating, one negative catalyst —
// published as "Cross-source conflict" while its own synthesis said chi=0.085 and A=0.915, which
// is near-total agreement. The row was always positive. The voting rule hid it.
//
// ⚠️ AUTHORITY IS EARNED PER READING, NOT ASSIGNED PER FAMILY. This is the part that matters, and
// it is why congress is a first-class family here rather than a footnote. The obvious design —
// rank the families once and forever — fails on the actual data:
//
//   congress disclosure lag, n=4,327 over the last year:
//     p25 20d · MEDIAN 30d · p75 112d · p90 116d · 70.8% within 45 days
//
// The MEAN is 83 days and it is a liar: a long tail of very late filings drags it far above the
// median. Reading the mean and concluding "politicians can never be timely" retires a family that
// is, seven times in ten, no staler than the insider data we trust most. So freshness is asked of
// each READING rather than assumed of the family, and a congress cluster disclosed three weeks ago
// leads the reading exactly as an insider cluster would.
//
// ⚠️ WHAT THIS IS NOT. It is not a weighting, and it does not make any family "worth more" than
// another. Experiment 002 measured the incremental information from adding institutional agreement
// at +0.43% (t=0.82, effective N≈18), and HANDOFF's "what must NOT be built" list forbids exactly
// the agreement bonus that would imply. Nothing here multiplies evidence by a fitted constant.
// It decides one thing only: whether a family is CURRENT AND SUBSTANTIAL ENOUGH to be the reason a
// direction is named, or whether it can only agree with a direction named by something else.

import { familyLean } from './synthesis.mjs';

export const AUTHORITY_VERSION = 'consensus_v4_authority';

/** What a family is permitted to do in this reading. */
export const AUTHORITY = Object.freeze({
  LEADING: 'leading',            // fresh + substantial + directional → may name the direction
  CORROBORATING: 'corroborating', // directional, but cannot name or veto one
  SILENT: 'silent',              // no direction to offer
});

/**
 * ⚠️ 0.35 IS FORTY-FIVE DAYS, NOT A NEW CONSTANT.
 *
 * The engine already decays insiders and congress with a 30-day half-life, so
 * 0.5^(45/30) = 0.354. Expressing the currency gate as a freshness floor therefore reuses the
 * decay that is already there instead of introducing a second, competing notion of "recent" that
 * could drift away from it. Forty-five days is also exactly the selection window the board already
 * uses (setup-board.js:47), and the window that covers 70.8% of congress disclosures.
 */
export const LEAD_FRESHNESS = 0.35;

/**
 * Below this a family's signed value is too small to be the REASON for anything. It is the engine's
 * own "roughly one family at moderate strength" anchor (MIN_DIRECTIONAL_MASS) divided across three
 * possible leaders — not a fitted number, and deliberately low: this gate exists to exclude noise,
 * not to rank.
 */
export const LEAD_MAGNITUDE = 0.10;

/**
 * A catalyst may lead ONLY when it actually points somewhere.
 *
 * Item 2.02 (results of operations) and 8.01 (other events) are both scored 0 in the engine's
 * ITEM_DIRECTION table, and 8.01 is the single most common catalyst type in production. Those
 * carry timing, not direction. Requiring a confident |D| keeps a catch-all filing from casting a
 * directional vote it was never able to justify.
 */
export const CATALYST_CONFIDENT_DIRECTION = 0.30;

/**
 * WHO MAY LEAD AT ALL, before any freshness or substance test.
 *
 * ⚠️ TWO PERMANENT EXCLUSIONS, BOTH ON MEASURED GROUNDS RATHER THAN PREFERENCE:
 *
 *   institutions  A 13F breadth count present on 98% of companies cannot be the reason one of them
 *                 is interesting. It is background, and background cannot lead OR veto. It still
 *                 counts fully as corroboration and toward coverage.
 *   structure     Price is barred from the evidence side by design (evidence.js:21) so Consensus
 *                 stays market-price independent, and its own accuracy note calls it a coin flip
 *                 over the window it is shown for.
 */
export const CAN_LEAD = Object.freeze({
  insiders: true,
  congress: true,      // ⚠️ a full first-class leader — see the lag distribution above
  catalysts: true,     // …but only with a confident direction
  institutions: false,
  structure: false,
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * What this family is permitted to do, and why — the `why` is reported so a card can explain a
 * demotion instead of silently dropping the family.
 */
export function familyAuthority(f) {
  const out = { family: f?.family ?? null, authority: AUTHORITY.SILENT, lean: null, reason: null };
  if (!f || !f.active) { out.reason = 'inactive'; return out; }

  const lean = familyLean(f);
  out.lean = lean;
  if (lean !== 'up' && lean !== 'down') { out.reason = 'no-direction'; return out; }

  // From here the family has a direction. The only question is whether it may NAME one.
  out.authority = AUTHORITY.CORROBORATING;

  if (!CAN_LEAD[f.family]) {
    out.reason = f.family === 'institutions' ? 'background-breadth' : 'not-a-leading-family';
    return out;
  }

  const F = num(f.F);
  if (F !== null && F < LEAD_FRESHNESS) { out.reason = 'not-current'; return out; }

  const E = num(f.E);
  if (E !== null && Math.abs(E) < LEAD_MAGNITUDE) { out.reason = 'too-small-to-lead'; return out; }

  if (f.family === 'catalysts') {
    const D = num(f.D);
    if (D === null || Math.abs(D) < CATALYST_CONFIDENT_DIRECTION) {
      out.reason = 'catalyst-direction-unknown';
      return out;
    }
  }

  out.authority = AUTHORITY.LEADING;
  out.reason = 'current-and-substantial';
  return out;
}

// ── MARKET STRUCTURE: NOT A VOTE, AN AXIS ──────────────────────────────────
//
// ⚠️ STRUCTURE MUST NOT NAME A DIRECTION, AND IT IS STILL THE MOST USEFUL THING ON THE CARD.
//
// Two measured facts pull in opposite directions and both have to be respected. Structure is "a
// coin flip about the window it is displayed over" (evidence.js:359, 112,620 samples), so letting
// it vote would import a coin flip into the reading. But Consensus is also deliberately
// price-independent on the evidence side (evidence.js:21) precisely SO price can be joined against
// it afterwards — that join is the whole point, and throwing structure away wastes it.
//
// So structure answers a different question from "which way". It answers "am I early or late",
// which is the question that decides whether a reading is worth anything:
//
//   EARLY       the evidence points somewhere and price has not gone there yet
//   CONFIRMING  price is already moving with the evidence
//   DIVERGING   price is moving AGAINST the evidence
//   EXTENDED    price has already made the move the evidence implies
//
// ⚠️ EARLY IS NOT A PREDICTION THAT IT WILL MOVE. It is the statement that the move has not
// happened, which is a fact about price and is checkable tomorrow. Three of the five public board
// rows currently carry marketState NO_REACTION and display it as a footnote; it belongs in the
// headline, because "the evidence is positive and nothing has happened yet" is the only state in
// which any of this is actionable at all.

export const PRICE_CONTEXT = Object.freeze({
  EARLY: 'EARLY',
  CONFIRMING: 'CONFIRMING',
  DIVERGING: 'DIVERGING',
  EXTENDED: 'EXTENDED',
  UNKNOWN: 'UNKNOWN',
});

export const PRICE_CONTEXT_LABEL = Object.freeze({
  EARLY: 'Price has not moved yet',
  CONFIRMING: 'Price moving with the evidence',
  DIVERGING: 'Price moving against the evidence',
  EXTENDED: 'Price has already made the move',
  UNKNOWN: 'Price context unavailable',
});

/**
 * ⚠️ REUSES THE ENGINE'S OWN DEAD ZONE. A 3.5% floor is not invented here — it is
 * REACTION_FLOOR_PCT, set because the median absolute 1-session move measured 1.60%, so anything
 * below it is ordinary noise being read as a market opinion.
 */
export const EXTENDED_REACTION = 1.0;   // R_eff is already normalised to the saturation band

/**
 * Where price sits relative to a directional reading.
 *
 * @param direction 'up' | 'down' from the evidence
 * @param structure the structure family (state: higher-highs-and-lows | lower-highs-and-lows | …)
 * @param reaction  the reaction layer ({ R_eff, meaningful }) — price since the evidence went public
 */
export function priceContext(direction, structure, reaction) {
  if (direction !== 'up' && direction !== 'down') return { context: PRICE_CONTEXT.UNKNOWN, label: PRICE_CONTEXT_LABEL.UNKNOWN, why: 'No direction to compare price against.' };

  const sign = direction === 'up' ? 1 : -1;
  const R = Number(reaction?.R_eff);
  const meaningful = reaction?.meaningful === true && Number.isFinite(R) && R !== 0;

  // The REACTION is the sharper instrument when it exists: it is anchored to the moment the
  // evidence became public, so it answers "has the market responded to THIS" rather than "what has
  // the market been doing lately".
  if (meaningful) {
    const withEvidence = Math.sign(R) === sign;
    if (!withEvidence) {
      return { context: PRICE_CONTEXT.DIVERGING, label: PRICE_CONTEXT_LABEL.DIVERGING,
        why: `Price moved ${R > 0 ? 'up' : 'down'} after the evidence became public, against a ${direction === 'up' ? 'positive' : 'negative'} reading.` };
    }
    if (Math.abs(R) >= EXTENDED_REACTION) {
      return { context: PRICE_CONTEXT.EXTENDED, label: PRICE_CONTEXT_LABEL.EXTENDED,
        why: 'Price has already made a full move in the direction the evidence points.' };
    }
    return { context: PRICE_CONTEXT.CONFIRMING, label: PRICE_CONTEXT_LABEL.CONFIRMING,
      why: 'Price is moving with the evidence, and has not yet made the full move.' };
  }

  // No meaningful reaction to the evidence itself. Fall back to the standing structure, which says
  // what price was doing regardless of the filing.
  const s = String(structure?.state || '');
  const up = s === 'higher-highs-and-lows';
  const down = s === 'lower-highs-and-lows';
  if (!up && !down) {
    return { context: PRICE_CONTEXT.EARLY, label: PRICE_CONTEXT_LABEL.EARLY,
      why: 'No meaningful price reaction, and no established trend either way.' };
  }
  const trendSign = up ? 1 : -1;
  if (trendSign === sign) {
    return { context: PRICE_CONTEXT.CONFIRMING, label: PRICE_CONTEXT_LABEL.CONFIRMING,
      why: `Price was already making ${up ? 'higher highs and lows' : 'lower highs and lows'} before this.` };
  }
  return { context: PRICE_CONTEXT.DIVERGING, label: PRICE_CONTEXT_LABEL.DIVERGING,
    why: `Price is making ${up ? 'higher' : 'lower'} highs and lows against a ${direction === 'up' ? 'positive' : 'negative'} reading.` };
}

/**
 * HOW MANY INDEPENDENT SOURCES AGREE — a gradient, not a gate.
 *
 * ⚠️ WHY THIS IS NOT A HARD 3-SOURCE RULE. Requiring three agreeing sources before naming a
 * direction sounds stricter and is, measured, catastrophic: on a 93-row board exactly ONE row
 * survives it. The cause is structural rather than a threshold that needs tuning — there are only
 * four evidence families, and most companies can never field three:
 *
 *     active evidence families per directional row:  1 fam 1 · 2 fams 11 · 3 fams 15 · 4 fams 1
 *
 * Congress exists on 315 tickers in window and catalysts on 966, so "three agreeing" demands three
 * PRESENT and unanimous. Gating on it would have taken the board from 28 directional rows to 1.
 *
 * So the count is reported as a tier instead. A reader still sees at a glance that three sources
 * agree on one name and one source speaks for another — which is the information the gate was
 * reaching for — without the other 27 being thrown away to express it.
 */
export const TIER = Object.freeze({
  STRONG: 'STRONG',   // 3+ agreeing — rare, and the reason the bubble view has something to size by
  CONFIRMED: 'CONFIRMED', // 2 agreeing — independent corroboration
  SINGLE: 'SINGLE',   // 1 source, labelled as such and never dressed up as agreement
});

export const TIER_LABEL = Object.freeze({
  STRONG: 'Strong',
  CONFIRMED: '',      // the plain reading word carries it; a qualifier here would be noise
  SINGLE: 'Single source',
});

export const tierFor = (agree) => (agree >= 3 ? TIER.STRONG : agree === 2 ? TIER.CONFIRMED : TIER.SINGLE);

/** The states this produces. Deliberately fewer than V2's eight, and each one is checkable. */
export const READING = Object.freeze({
  POSITIVE: 'POSITIVE',
  NEGATIVE: 'NEGATIVE',
  CONTESTED: 'CONTESTED',       // two LEADING families genuinely disagree — rare, and interesting
  INSUFFICIENT: 'INSUFFICIENT', // nothing current and substantial enough to name a direction
});

export const READING_LABEL = Object.freeze({
  POSITIVE: 'Positive',
  NEGATIVE: 'Negative',
  CONTESTED: 'Contested',
  INSUFFICIENT: 'Insufficient evidence',
});

/**
 * ⚠️ BELOW THIS A FAMILY IS NOT A SOURCE AND MUST NOT BE COUNTED AS ONE.
 *
 * The first cut of this counted every active directional family toward "N of M sources". Replayed
 * on the live board AGPU read "4 of 4 sources" while one of those four was a catalyst at
 * E = 0.013 — a number indistinguishable from zero, presented to a reader as a source in
 * agreement. That is the same false precision this codebase has already removed twice (the
 * "align 100%" on two internally-mixed families, and the 0.887-vs-0.002 "contest").
 *
 * A family below the floor is reported as present and below the noise floor. It is not counted as
 * agreeing, and it is not counted as opposing. Silence is not assent.
 */
export const NOISE_FLOOR = LEAD_MAGNITUDE;   // 0.10 — the same bar leading requires

/**
 * ⚠️ WHAT ONE FAMILY ALONE MUST CLEAR TO NAME A DIRECTION BY ITSELF.
 *
 * This is MIN_DIRECTIONAL_MASS, the engine's existing "too little directional evidence to name a
 * direction from" anchor — deliberately REUSED rather than re-chosen, so there is one definition of
 * "enough to name a direction" in the product instead of two that can drift apart.
 *
 * It applies only when nothing else agrees. A leader at 0.28 with a second source agreeing is two
 * sources; a leader at 0.28 alone is one moderate reading being published as a verdict. Measured on
 * the live board this is the difference between AIAI (insiders -0.160, nothing else agreeing →
 * withheld) and TELA (insiders +0.282 with institutions +0.360 agreeing → published).
 */
export const SOLO_LEAD_MIN = 0.30;

/**
 * ⚠️ STRUCTURE IS NOT A SOURCE AND MUST NEVER BE COUNTED AS ONE.
 *
 * Caught by replaying the first version of this on the live board: AGPU read "3 of 3 sources" and
 * PG read "3 of 3", and in both cases one of those three was `structure` — which is PRICE. The
 * entire evidence side is deliberately price-independent (evidence.js:21, "NOTHING HERE READS A
 * PRICE") precisely so price can be joined against it afterwards. Counting price as a source that
 * agrees with the evidence destroys that separation and inflates the count with the one input
 * measured as a coin flip over the window it is displayed for.
 *
 * Price gets its own axis — priceContext() — and no vote.
 */
const SOURCE_FAMILIES = Object.freeze(['insiders', 'congress', 'catalysts', 'institutions']);

/** Active, directional, above the noise floor, and actually evidence — the only countable sources. */
function countableSources(verdicts, families) {
  const byFamily = new Map((families || []).map((f) => [f?.family, f]));
  return verdicts.filter((v) => {
    if (v.authority === AUTHORITY.SILENT) return false;
    if (!SOURCE_FAMILIES.includes(v.family)) return false;
    const E = num(byFamily.get(v.family)?.E);
    return E !== null && Math.abs(E) >= NOISE_FLOOR;
  });
}

/**
 * THE READING.
 *
 * ⚠️ IT DESCRIBES THE EVIDENCE, IT DOES NOT FORECAST THE PRICE. "Positive" means the current,
 * substantial, disclosed evidence points one way — nothing here claims the stock will rise, and
 * the research does not support such a claim (experiment-002: max |t| 1.84 against a Bonferroni
 * requirement of 3.5). The word describes the filings, which is a fact we can stand behind.
 *
 * @returns { reading, label, direction, leading[], corroborating[], against[], agreement, why }
 */
export function authorityReading(families) {
  const list = (Array.isArray(families) ? families : []).filter(Boolean);
  const verdicts = list.map(familyAuthority);

  // ⚠️ THE NOISE FLOOR IS APPLIED BEFORE ANYTHING IS COUNTED. A family below it is neither a
  // supporter nor a dissenter — it is reported as present and too small to read.
  const countable = countableSources(verdicts, list);
  const countableSet = new Set(countable.map((v) => v.family));
  const belowFloor = verdicts
    .filter((v) => v.authority !== AUTHORITY.SILENT && !countableSet.has(v.family))
    .map((v) => v.family);

  const leading = countable.filter((v) => v.authority === AUTHORITY.LEADING);
  const corroborating = countable.filter((v) => v.authority === AUTHORITY.CORROBORATING);

  const out = {
    version: AUTHORITY_VERSION,
    reading: READING.INSUFFICIENT,
    label: READING_LABEL.INSUFFICIENT,
    direction: null,
    leading: leading.map((v) => v.family),
    corroborating: corroborating.map((v) => v.family),
    against: [],
    // "3 of 4 sources" — a COUNT, never a percentage. |ΣE|/Σ|E| reads 100% when two families are
    // internally mixed and merely fail to oppose; the route's own note calls that "arithmetically
    // correct and rhetorically false".
    agreement: { agree: 0, total: 0 },
    demoted: verdicts.filter((v) => v.authority === AUTHORITY.CORROBORATING)
      .map((v) => ({ family: v.family, reason: v.reason })),
    why: null,
  };

  if (!leading.length) {
    out.why = corroborating.length
      ? 'No current, substantial source names a direction on its own.'
      : 'No directional evidence.';
    return out;
  }

  const up = leading.filter((v) => v.lean === 'up');
  const down = leading.filter((v) => v.lean === 'down');

  // ⚠️ CONTESTED REQUIRES TWO LEADERS TO DISAGREE — not one leader and one piece of background.
  // That is the entire difference from V2, where a quarter-stale 13F breadth count could turn a
  // fresh insider cluster into "cross-source conflict".
  if (up.length && down.length) {
    out.reading = READING.CONTESTED;
    out.label = READING_LABEL.CONTESTED;
    out.against = [...up, ...down].map((v) => v.family);
    out.agreement = { agree: 0, total: leading.length + corroborating.length };
    out.why = `${up.map((v) => v.family).join(' and ')} and ${down.map((v) => v.family).join(' and ')} point opposite ways, both current and substantial.`;
    return out;
  }

  const dir = up.length ? 'up' : 'down';
  const withUs = corroborating.filter((v) => v.lean === dir);
  const againstUs = corroborating.filter((v) => v.lean && v.lean !== dir);
  const agree = leading.length + withUs.length;
  const oppose = againstUs.length;

  out.against = againstUs.map((v) => v.family);
  out.agreement = { agree, total: agree + oppose };

  // ⚠️ A TIE IS NOT A DIRECTION, AND `>=` WOULD HAVE PUBLISHED FOUR OF THEM.
  // The leading family is the only one permitted to NAME a direction, and that permission is about
  // currency and provenance, not about being right. When the countable sources are evenly split —
  // one for, one against — publishing the leader's side asserts that our authority ordering beats
  // the weight of the evidence, which nothing here has established. Replayed on the live board,
  // allowing ties published CRWV, ADC, RWT and GMRS on a single source against a single dissenter.
  if (oppose >= agree) {
    out.reading = READING.INSUFFICIENT;
    out.label = READING_LABEL.INSUFFICIENT;
    out.belowFloor = belowFloor;
    out.why = `${leading.map((v) => v.family).join(' and ')} point ${dir === 'up' ? 'positive' : 'negative'}, but more sources point the other way. Not enough agreement to name a direction.`;
    return out;
  }

  // ⚠️ ONE MODERATE FAMILY, ALONE, IS NOT A VERDICT. See SOLO_LEAD_MIN.
  const strongest = leading.reduce((m, v) => {
    const E = Math.abs(num(list.find((f) => f?.family === v.family)?.E) ?? 0);
    return E > m ? E : m;
  }, 0);
  if (agree === 1 && strongest < SOLO_LEAD_MIN) {
    out.reading = READING.INSUFFICIENT;
    out.label = READING_LABEL.INSUFFICIENT;
    out.belowFloor = belowFloor;
    out.why = `Only ${leading.map((v) => v.family).join(' and ')} carries a current, substantial direction, and on its own it is not strong enough to name one.`;
    return out;
  }

  out.direction = dir;
  out.reading = dir === 'up' ? READING.POSITIVE : READING.NEGATIVE;
  out.label = dir === 'up' ? READING_LABEL.POSITIVE : READING_LABEL.NEGATIVE;
  out.tier = tierFor(agree);
  out.tierLabel = TIER_LABEL[out.tier];
  out.belowFloor = belowFloor;

  const led = leading.map((v) => v.family).join(' and ');
  out.why = againstUs.length
    ? `${led} point ${dir === 'up' ? 'positive' : 'negative'}; ${againstUs.map((v) => v.family).join(' and ')} disagree but cannot name a direction.`
    : `${led} point ${dir === 'up' ? 'positive' : 'negative'}${withUs.length ? `, with ${withUs.map((v) => v.family).join(' and ')} agreeing` : ''}.`;
  return out;
}
