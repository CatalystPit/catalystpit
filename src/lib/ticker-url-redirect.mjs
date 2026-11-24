// WHERE A NON-CANONICAL TICKER URL SHOULD GO — as a pure function of the path and the tab, so the
// decision can be made in middleware instead of inside the page.
//
// ── ⚠️ WHY THIS MOVED OUT OF page.jsx AT ALL ────────────────────────────────
//
// The ticker route served `Cache-Control: private, no-cache, no-store` with `x-vercel-cache: MISS`
// on every one of ~19,750 URLs, including an immediate repeat of the same one. The cause was not a
// missing header — a `headers()` entry in next.config was tried on 2026-11-24 and measured not to
// take, because for a dynamically rendered route the framework's own Cache-Control is applied last.
// The cause was that the route WAS dynamic, and the single reason it was dynamic is that Page()
// awaited `searchParams` to carry `?tab=` across the lowercase→uppercase redirect. One query
// parameter, read on a branch that fires for a small minority of requests, opted the other
// ~19,750 URLs out of the cache for every crawl and every visitor.
//
// Adding `export const revalidate` without moving this was measured first and does nothing at all:
// the build output lists no Revalidate for the route and `next start` still answers
// `private, no-cache, no-store` on a second identical request.
//
// So the decision moves to middleware, which already runs on these paths, and the page keeps a
// tab-less backstop. Middleware sees the query string for free — no dynamic API, nothing to opt out
// of — and the redirect behaviour is unchanged: real tabs survive, tracking parameters do not.
//
// ⚠️ THE GRAMMAR IS NOT RE-IMPLEMENTED HERE. normalizeSymbol and tickerPath are the same two
// functions the page called, and verify-ticker-urls.mjs's assertions about them keep applying
// unchanged — that suite tests the grammar module, not the caller, which is why the caller could
// move. What this adds is only the part that was never expressible as grammar: reading the symbol
// out of a URL path.
import { normalizeSymbol, tickerPath } from './ticker-symbol.mjs';
import { tickerTabEnabled } from './feature-availability.mjs';

const PREFIX = '/ticker/';

/**
 * The canonical path a /ticker/<segment> request should be 308'd to, or null to let the route render.
 *
 * Returns null for anything that is not exactly one segment under /ticker/, for a segment that is
 * already canonical, and — deliberately — for a segment no symbol can be read from. That last case
 * is a 404 the page itself must answer, on the branded not-found page; answering it here would turn
 * a 404 into a redirect loop or a bare framework error.
 *
 * @param {{ pathname?: string, tab?: string|null }} req
 * @returns {string|null}
 */
export function tickerCanonicalRedirect({ pathname, tab } = {}) {
  if (typeof pathname !== 'string' || !pathname.startsWith(PREFIX)) return null;

  const rest = pathname.slice(PREFIX.length);
  // `/ticker/`, `/ticker/AAPL/`, `/ticker/AAPL/anything` are not this route's canonical shape. Next
  // and the page handle them; inventing a target for them here would invent URLs.
  if (!rest || rest.includes('/')) return null;

  // The page reads `params`, which arrives percent-decoded. Middleware reads the raw path, so it has
  // to decode to be asking the same question. A malformed escape decodes to nothing readable and is
  // left to the page, which 404s it.
  let raw;
  try { raw = decodeURIComponent(rest); } catch { return null; }

  const sym = normalizeSymbol(raw);
  if (!sym) return null;        // not a symbol: the page's notFound() still owns this
  if (raw === sym) return null; // already canonical: render it, and let it be cached

  // ⚠️ ONLY A REAL, CURRENTLY AVAILABLE TAB SURVIVES, which is exactly what the page did. A link to
  // a module that is switched off lands on Overview rather than being redirected to an empty panel,
  // and ?ref=/?utm_source= are dropped rather than minted into a second permanent URL for one view.
  const keep = tickerTabEnabled(tab) ? tab : undefined;
  return tickerPath(sym, keep);
}
