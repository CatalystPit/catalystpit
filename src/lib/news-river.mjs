// HOW THE NEWS RIVER IS COMPOSED — one definition, two callers.
//
// ⚠️ THIS EXISTS BECAUSE /news NOW RENDERS ON THE SERVER TOO, AND THE TWO COPIES MUST NOT DISAGREE.
//
// /api/news built the river inline: dedupe the journalism pools against the filing documents, then
// hand the three pools to composeRiver. app/news/page.jsx now needs the identical river at
// generation time so the crawler's copy of the page and the reader's copy lead with the same story.
// Two inline copies of "dedupe, then compose" is exactly how the homepage's crawler HTML came to
// name HPE as the day's biggest catalyst while the hydrated page named a delisting — both correct
// for their own pool, which is the problem. So the composition is named, pure, and imported.
//
// ⚠️ NOTHING HERE RANKS, RECLASSIFIES OR FILTERS. composeRiver owns the ordering and lib/impact.js
// owns materiality; this function owns one decision only — that a story already linking to a
// filing document is the same event twice — and then delegates.
import { composeRiver } from './impact';

/**
 * The composed news river: journalism (with a genuinely exceptional filing allowed to compete for
 * the lead), then the material filings as their own block, then the press-release wires.
 *
 * @param {object}   pools
 * @param {object[]} pools.curated  enriched stories from `catalystpit:top_stories`
 * @param {object[]} pools.wire     press-release wires from `catalystpit:wire_news`
 * @param {object[]} pools.filings  material 8-Ks, already shaped by filingsToStories
 * @param {object}   [opts]
 * @param {number}   [opts.now]     the clock, passed through to composeRiver so a server
 *                                  generation and a browser render can share one instant
 * @returns {object[]} the river, in display order
 */
export function buildNewsRiver({ curated = [], wire = [], filings = [] } = {}, { now = Date.now() } = {}) {
  const pool = Array.isArray(filings) ? filings : [];
  // A story already linking to the same filing document is the same event twice.
  const filingUrls = new Set(pool.map((f) => f.url).filter(Boolean));
  const notAlreadyFiled = (s) => !(s?.url && filingUrls.has(s.url));
  return composeRiver({
    curated: (Array.isArray(curated) ? curated : []).filter(notAlreadyFiled),
    wire: (Array.isArray(wire) ? wire : []).filter(notAlreadyFiled),
    filings: pool,
  }, { now });
}
