// MATERIAL ISSUER 8-Ks, SHAPED FOR THE NEWS RIVER.
//
// ⚠️ WHY THIS EXISTS AS A MODULE RATHER THAN A BLOCK INSIDE THE ROUTE. The defect it fixes is
// behavioural — "a qualifying issuer 8-K must reach the main column and score HIGH" — and a route
// that needs Clerk and a database cannot be called from a test. Inlined, the only assertion
// available would have been a regex over the route's source, which is precisely the kind of test
// that passes while the product is broken; this session produced three such false greens already.
// As a pure function over rows, the real behaviour is assertable: feed it filings, read back what
// the feed would show, and score it with the same impactOf the tab uses.
//
// ⚠️ THIS MODULE DOES NOT CLASSIFY FILINGS AND MUST NOT LEARN TO. `material` and `primaryLabel`
// are decided by classifyItems() in lib/eightk at ingest, against the SEC item codes. Everything
// here is shaping and de-duplication. A second opinion about what an 8-K means is exactly the
// thing the brief forbids, and the reason the rails and the column could otherwise disagree about
// the same filing.

import { isIngestableTicker } from './security-identity.mjs';

/**
 * Collapse a batch of 8-K rows to one row per real-world event, newest first.
 *
 * Two passes, because "the same event twice" has two shapes:
 *   accession    — the SEC's own unique id. Two rows sharing one is a read-path duplicate.
 *   ticker|label — an original and its /A amendment are two accessions describing ONE event,
 *                  which is how the wire showed PETV twice.
 */
export function dedupeFilings(rows = []) {
  const byAccession = new Map();
  for (const f of rows) {
    if (!f) continue;
    // A row with no accession cannot be proven distinct, so it is keyed on itself rather than
    // dropped — losing a real filing is worse than showing one that might be a duplicate.
    const key = f.accession || `${f.ticker}|${f.filedAt}|${f.primaryLabel}`;
    if (!byAccession.has(key)) byAccession.set(key, f);
  }
  const byEvent = new Map();
  for (const f of byAccession.values()) {
    const key = `${f.ticker}|${f.primaryLabel}`;
    const prev = byEvent.get(key);
    // filedAt is the public clock. Never inserted_at, which is when WE saw it.
    if (!prev || new Date(f.filedAt) > new Date(prev.filedAt)) byEvent.set(key, f);
  }
  return [...byEvent.values()].sort((a, b) => new Date(b.filedAt) - new Date(a.filedAt));
}

/**
 * Shape deduped filings into the item the news feed already normalises.
 *
 * ⚠️ category 'SEC' IS THE LOAD-BEARING FIELD, and it is a statement of provenance, not a nudge to
 * the ranker. impactOf treats `cat === 'SEC'` as an issuer filing, which — combined with a
 * resolved ticker — satisfies product rule (A). Both halves are required, so a filing whose
 * ticker will not pass the ingest grammar is DROPPED rather than shown with a guessed symbol: a
 * catalyst nobody can act on is not a catalyst.
 */
export function filingsToStories(rows = []) {
  return dedupeFilings(rows)
    .filter((f) => f && isIngestableTicker(f.ticker) && f.primaryLabel)
    .map((f) => ({
      title: `${f.ticker} · ${f.primaryLabel}`,
      summary: f.company || '',
      source: 'SEC 8-K',
      category: 'SEC',
      ticker: f.ticker,
      published: f.filedAt,          // when it became public, not when we read it
      url: f.url || null,
      material: true,
      accession: f.accession || null,
      imageUrl: null,                // a filing card borrows no publisher artwork
    }));
}
