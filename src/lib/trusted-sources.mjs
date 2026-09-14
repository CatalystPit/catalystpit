// Sources the operator has designated high-signal breaking news.
//
// A trusted source is treated differently in four specific places, and nowhere else:
//
//   1. IMPORTANCE FLOOR. Its events never score below HIGH. The importance scorer is content-based
//      and reads a terse terminal-style flash ("*GERMANY TO LOBBY EU ON NEW CHINA POLICY") as
//      unremarkable — 18 of the first 19 Walter Bloomberg posts scored 0, which put every one of
//      them below the Market Moving preset's impact filter. The floor is what makes the source
//      actually reach the trader, and it is a judgement about the SOURCE, which is exactly the kind
//      of judgement a registry entry should carry.
//   2. NO NOISE CLASSIFICATION. The editorial noise classes never fire on it, so nothing the tape
//      does to suppress commentary can discard a flash.
//   3. TOP REWRITE PRIORITY. Its events jump the enrichment queue ahead of the backlog.
//   4. A LARGER REWRITE BUDGET, AND NEVER PARKED. An ordinary event that exhausts its retries is
//      parked and keeps the publisher's wording. A trusted source's wording must never be what the
//      tape settles on, so it keeps its place in the queue instead.
//
// It changes nothing about capture, dedupe, clustering, provenance or ticker resolution. A trusted
// source is deduped against all 84 feeds exactly like any other, and ticker confidence is untouched
// — a trusted source does not get to invent a symbol.
//
// Kept in its own module with NO imports so both the server registry and the browser's filter
// taxonomy can read one list. wire-taxonomy.mjs ships to the client; pulling in primary-sources.mjs
// there would bundle the whole 84-feed registry and node:crypto with it.

export const TRUSTED_SOURCES = new Set(['WALTERBLOOMBERG']);

export const isTrustedSource = (source) => TRUSTED_SOURCES.has(String(source || '').toUpperCase());

// The floor a trusted source's events cannot fall below. 2 = HIGH, not 3 = CRITICAL: making every
// flash critical would paint the whole tape red and destroy the distinction the impact tiers exist
// to draw. A genuinely critical flash still scores 3 on its own content.
export const TRUSTED_MIN_IMPORTANCE = 2;

// A trusted event keeps trying for a Catalyst Pit headline long after an ordinary one would have
// been parked with the publisher's words.
export const TRUSTED_REWRITE_ATTEMPTS = 12;
