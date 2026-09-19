// WHAT ORDER DOES "WHAT CHANGED" SHOW THINGS IN? PURE: no DB, no network, no AI.
//
// Deterministic and explainable, per section 12 of the brief: same inputs, same order, and every
// position justifiable by pointing at two rows' fields. There is no learned ranker here and there
// must never be one — a trader who cannot tell why an item is at the top has to read the whole list,
// which is the problem this section exists to solve.
//
// ── FRESHNESS IS A TIER, NOT A TERM ──────────────────────────────────────────
//
// Freshness buckets FIRST, then weight within the bucket. Folding freshness into one multiplied
// score lets a big enough 13F observation outrank an 8-K filed this morning, which is precisely
// backwards for a product answering "what changed". It also matches how the section renders —
// TODAY, then OLDER / STILL RELEVANT — so the ordering and the headings can never disagree.
//
// Within a tier: materiality, then quality, then historical unusualness, then recency. Unusualness
// is a modest BOOST rather than a primary key: "first CEO buy in 842 days" should lift a purchase
// above a routine filing, but it should not lift a trivial event above a material one.

import { freshness, toEpoch } from './model.mjs';

/** Tier order. Lower sorts first. */
export const TIER = Object.freeze({ today: 0, recent: 1, active: 2, stale: 3 });

/** What an unusual-for-this-company finding is worth. One notch, not a reordering of the world. */
export const UNUSUAL_BOOST = 0.15;

/**
 * The within-tier weight, in [0, ~1.15].
 *
 * materiality × quality is the base: a certain report of a trivial thing and a dubious report of a
 * major thing should both sit below a solid report of a major thing.
 */
export function weight(ev) {
  const m = Number.isFinite(ev?.materiality) ? ev.materiality : 0.5;
  const q = Number.isFinite(ev?.quality) ? ev.quality : 0.5;
  const unusual = ev?.context?.unusual === true || ev?.context?.boundedByCoverage === true
    || (typeof ev?.context?.gapDays === 'number');
  return m * q + (unusual ? UNUSUAL_BOOST : 0);
}

/**
 * Sort key, exposed so a test can assert an ordering decision rather than just an outcome, and so
 * the API can return WHY a row placed where it did.
 */
export function rankKey(ev, { now = Date.now() } = {}) {
  return {
    tier: TIER[freshness(ev, { now })] ?? TIER.stale,
    weight: weight(ev),
    publicTime: toEpoch(ev?.publicTime) ?? 0,
    id: String(ev?.evidenceId ?? ''),
  };
}

/**
 * Order evidence for display. Stable and total: the final tiebreak is the evidence id, so two
 * otherwise identical rows never swap between renders.
 */
export function rankEvidence(list, { now = Date.now() } = {}) {
  return [...(Array.isArray(list) ? list : [])]
    .map((ev) => ({ ev, k: rankKey(ev, { now }) }))
    .sort((a, b) =>
      (a.k.tier - b.k.tier)
      || (b.k.weight - a.k.weight)
      || (b.k.publicTime - a.k.publicTime)
      || a.k.id.localeCompare(b.k.id))
    .map((x) => x.ev);
}

/**
 * Split into the two groups the section renders.
 *
 * `stale` is returned separately rather than dropped: the ticker page does not show it, but the
 * caller can say "and 14 older items" instead of pretending they do not exist.
 */
export function groupForDisplay(list, { now = Date.now() } = {}) {
  const ranked = rankEvidence(list, { now });
  return {
    today: ranked.filter((e) => freshness(e, { now }) === 'today'),
    older: ranked.filter((e) => ['recent', 'active'].includes(freshness(e, { now }))),
    stale: ranked.filter((e) => freshness(e, { now }) === 'stale'),
  };
}
