// THE /go DECISION, AS A PURE FUNCTION. No database, no network, no Request object, no credentials.
//
// ⚠️ WHY THIS IS NOT INSIDE THE ROUTE HANDLER. Every security property of /go lives in this logic — the
// allowlist match, the refusal to read a destination from the request, the one permitted query parameter
// — and a route handler cannot be called from a test without a live server, a database and a Next
// runtime. Logic that can only be exercised end to end is logic whose edge cases get argued about
// instead of asserted. So the handler is a thin wrapper that does I/O, and the decisions are here where
// a suite can hand them an encoded `javascript:` URL and read the answer.
//
// The `partners` parameter is a test seam and nothing more: production passes the real registry, and the
// suite passes unmistakably synthetic fixtures so that no invented partner ever exists outside a test.

import { resolvePartner, PLACEMENT_IDS, PARTNERS } from './partners.mjs';

/** Headers every answer carries, whether a redirect or a refusal. */
export const GO_HEADERS = Object.freeze({
  // A cached redirect cannot be revoked. If a partnership ends, a browser holding a cached entry would
  // keep sending readers there — which is why this is a 302 and why caching is refused outright.
  'Cache-Control': 'no-store, max-age=0',
  // /go is an endpoint, not a page. robots.txt asks crawlers not to fetch it; this tells anything that
  // fetched it anyway not to index it. The two cover different cases — a URL found via an external link
  // is never crawled under the first rule but would still be indexable under none.
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Type': 'text/plain; charset=utf-8',
  // The destination has no business learning which Catalyst Pit page the reader came from.
  'Referrer-Policy': 'no-referrer',
});

export const GO_REDIRECT_STATUS = 302;

/**
 * Extract the partner key from a /go pathname.
 *
 * ⚠️ DECODED ONCE, LOWERCASED, THEN MATCHED BY EQUALITY — never used to build anything. That is what
 * makes traversal and encoding tricks uninteresting rather than dangerous: `..%2f..%2fetc`, a double
 * slash, a trailing dot and `%2e%2e` are all simply not partner keys, so they fall through to the same
 * refusal as a typo. There is no filesystem path and no URL being concatenated for them to escape from.
 *
 * A key containing a slash after decoding is refused outright rather than matched, because a value that
 * decodes into another path segment is a value someone is probing with.
 */
export function partnerKeyFromPath(pathname) {
  const segments = String(pathname || '').split('/').filter(Boolean);
  if (!segments.length) return null;
  const last = segments[segments.length - 1];
  let decoded;
  try { decoded = decodeURIComponent(last); } catch { return null; }   // malformed percent-encoding
  if (!decoded || decoded === 'go') return null;
  if (/[/\\]/.test(decoded)) return null;
  if (decoded.includes('..')) return null;
  return decoded.toLowerCase();
}

/**
 * Decide what /go should answer.
 *
 * Returns { status: 302, location, headers } or { status: 404, headers, reason }. The reason is for the
 * server's own logs and tests; it is never put in the response body, because a probe should not be able
 * to tell "no such partner" from "that partner is disabled".
 */
export function resolveGoRequest({ url, partners = PARTNERS, env = process.env } = {}) {
  let u;
  try { u = url instanceof URL ? url : new URL(String(url)); }
  catch { return { status: 404, headers: GO_HEADERS, reason: 'unparseable request url' }; }

  const key = partnerKeyFromPath(u.pathname);
  if (!key) return { status: 404, headers: GO_HEADERS, reason: 'no partner key' };

  // ⚠️ EXACTLY ONE QUERY PARAMETER IS READ, and only to be compared against our own closed vocabulary.
  // Everything else on the incoming URL is ignored: not forwarded, not logged, not inspected. So no
  // caller can append a parameter to the outbound URL, override a sub-id, or smuggle a value through —
  // and `?url=`, `?to=` and `?next=` have no meaning here because nothing reads them.
  const requested = u.searchParams.get('placement');
  const placement = PLACEMENT_IDS.includes(requested) ? requested : null;

  const r = resolvePartner(key, { env, placement, partners });
  if (!r.ok) return { status: 404, headers: GO_HEADERS, reason: r.reason, placement };

  return {
    status: GO_REDIRECT_STATUS,
    location: r.url,
    headers: { ...GO_HEADERS, Location: r.url },
    partnerKey: key,
    placement,
    kind: r.kind,
  };
}
