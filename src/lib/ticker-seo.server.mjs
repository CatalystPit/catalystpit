import 'server-only';
import { unstable_cache } from 'next/cache';
import { getTickerBundle as fetchBundle } from './ticker-seo.mjs';

// THE ONLY ENTRY POINT APP CODE MAY USE for the ticker SEO bundle.
//
// `server-only` is a build-time tripwire, not a runtime check: if any module reachable from a
// 'use client' component ever imports this file, the production build FAILS rather than shipping the
// query, the table names and the internal eligibility state to a browser. Same guard, same reason, as
// wire-sources.server.mjs.

/**
 * Cached ticker SEO bundle, keyed by normalised uppercase symbol.
 *
 * Six hours, matching the data rather than a habit. Every field in the public model is daily or
 * slower: insider filings arrive on a T+2 clock, 13F holdings change four times a year,
 * congressional disclosures lag thirty to forty-five days, and the close is the close. Nothing here
 * is a live price — the quote and the intraday chart are client-fetched and completely unaffected by
 * this cache, so a six-hour shell costs a reader nothing.
 *
 * The reason it exists is crawl shape rather than user latency. A single reader costs one bundle; a
 * crawler working through thousands of ticker URLs would otherwise cost one database round trip per
 * URL per visit. Cached, that collapses to one per symbol per window.
 *
 * Cache internals stay internal: the key is the symbol, the tag is ours, and neither the key, the
 * tag, the age nor the hit/miss state is returned to the caller or rendered anywhere.
 */
const cached = unstable_cache(
  async (symbol) => fetchBundle(symbol),
  ['ticker-seo-bundle'],
  { revalidate: 21600, tags: ['ticker-seo-bundle'] },
);

/**
 * Bundle for a symbol, or null when we hold nothing or a read failed.
 *
 * Returns `{ public, eligibility }`. ONLY `.public` may be serialized into a page or an RSC payload —
 * `.eligibility` describes our own coverage and stays on the server, where it exists to feed the
 * indexability rule a later step will apply.
 */
export async function getTickerSeoBundle(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return null;
  try {
    return await cached(sym);
  } catch (err) {
    console.error('[ticker-seo] cache read failed', err?.message || err);
    return null;
  }
}
