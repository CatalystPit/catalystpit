// ── HOW A BOARD ROW IS PRESENTED ───────────────────────────────────────────
//
// ⚠️ LIFTED OUT OF app/api/consensus-board/route.js SO THE HOMEPAGE CAN RENDER IT ON THE SERVER.
//
// The Pit Consensus teaser on the front door used to fetch this route from an effect, which meant
// the flagship cross-source evidence module was invisible to anything that does not run
// JavaScript. The server now reads the same published board and shapes the rows with the same
// function — this one — rather than a second copy that would drift from the route by one field and
// report absence as fact, which is exactly how this module once printed a green zero beside a
// ticker the board was calling a conflict.
//
// Nothing here computes evidence, reads a database or consults a session. It is a pure reshaping of
// a row that has already been built, and the rows are free for every visitor: the route's own
// comment records that entitlement gates nothing here, so a server-rendered copy cannot leak
// anything a signed-out reader is not already served.

import { familyLean } from './synthesis.mjs';

/**
 * Per-row display facts, derived from the family STATES rather than from the combined number.
 *
 * ⚠️ ALIGNMENT IS PRESENTED AS A COUNT, NOT A PERCENTAGE. |ΣE|/Σ|E| reads 100% when two of four
 * families are internally mixed and merely fail to oppose — measured on UBER, which showed
 * "align 100%" on insiders:bullish, institutions:mixed, congress:bullish, catalysts:mixed. The
 * percentage is arithmetically correct and rhetorically false, so the number stays in the payload
 * for Pit Scan and the page says "2 of 4 families point bullish".
 */
export function displayFacts(row) {
  // ⚠️ SHAPE NOTE. A V3 row uses `families` for the per-family FACT SHEET (an object keyed by
  // family). The V2.1 normalised ARRAY these fields are derived from now lives on
  // `canonical.families`. Reading `row.families` here would silently produce empty leans on
  // every row while looking like it worked.
  const fams = row.canonical?.families || (Array.isArray(row.families) ? row.families : []);
  const active = fams.filter((f) => f.active);
  const up = active.filter((f) => familyLean(f) === 'up');
  const down = active.filter((f) => familyLean(f) === 'down');
  const mixed = active.filter((f) => familyLean(f) === 'mixed');
  return {
    ...row,
    activeFamilies: active.map((f) => f.family),
    inactiveFamilies: fams.filter((f) => !f.active).map((f) => ({ family: f.family, reason: f.inactiveReason })),
    leanUp: up.map((f) => f.family),
    leanDown: down.map((f) => f.family),
    leanMixed: mixed.map((f) => f.family),
    // ALIGNMENT IS ONLY MEANINGFUL ACROSS TWO OR MORE INDEPENDENT FAMILIES (§5). With one active
    // family the page says SINGLE-SOURCE; it must never read 100%.
    alignmentMeaningful: active.length >= 2,
  };
}
