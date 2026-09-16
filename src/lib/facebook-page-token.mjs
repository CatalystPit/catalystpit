// Turning a Business Manager System User credential into the PAGE access token that publishing
// actually requires.
//
// WHY THIS IS A SEPARATE MODULE. It contains the one piece of Facebook authentication logic with
// real branching — cache, exchange, failure classification — and facebook-publisher.js cannot be
// imported by a test because it pulls in the database. Kept here, the whole flow is exercised
// against an injected fetch with no database, no credentials and no network. The publisher imports
// it; nothing else does.

import { redactCredential, META_OAUTH_ERROR_CODE } from './facebook-post.mjs';

export const graphUrl = (cfg, path) => `https://graph.facebook.com/${cfg.graphVersion}/${path}`;

/**
 * THE BUG THIS EXISTS TO FIX, stated plainly.
 *
 * Publishing to a Page requires a PAGE-type access token carrying pages_manage_posts and
 * pages_read_engagement. A Business Manager System User token is a USER-type token. With the System
 * User holding Admin access, the Page assigned at Full Access, the app assigned, and the token
 * generated with exactly the right permissions and expiry "Never", posting with it STILL fails:
 *
 *   (#200) ... requires ... pages_manage_posts permission with page token
 *
 * Nothing about the Business Manager setup is wrong. The token class is wrong. Meta requires the
 * Page's own token, and the System User token is the thing you use to GET one.
 *
 * WHY THE GRAPH API EXPLORER ROUTE PRODUCES A TOKEN THAT DIES IN AN HOUR. A Page access token
 * inherits the lifetime and the identity of the token used to REQUEST it. Calling
 * GET /{page-id}?fields=access_token from the Explorer signs the request as the person logged into
 * the Explorer, on that session's short-lived user token — so the Page token returned is short-lived
 * and app-scoped to that person, which is exactly what the Access Token Debugger reports.
 *
 * Making the SAME call with the System User token yields a Page token derived from a credential that
 * does not expire, so the Page token does not expire on a timer either. That call belongs on the
 * server, which is here.
 */
const PAGE_TOKEN_TTL_MS = 30 * 60 * 1000;
let cache = null;   // { pageId, graphVersion, token, at }

/** Drop the cached Page token. Called whenever Meta rejects a credential. */
export function invalidatePageToken() { cache = null; }

/** Test seam only: report whether a token is currently cached, never what it is. */
export const pageTokenCached = () => !!cache;

/**
 * Resolve the Page access token to publish with.
 *
 * Returns { ok: true, token } or { ok: false, reason, code }. A failure here is always reported with
 * a CREDENTIAL error code, because every way this can fail is a credential problem — the System User
 * token is wrong or revoked, or the Page is no longer assigned to it. That matters: it routes the
 * failure into the hold-the-post path instead of the destroy-the-post path.
 *
 * The cache is keyed on page id and Graph version so changing either cannot serve a stale token, and
 * the TTL is a backstop rather than the real bound — a serverless instance rarely outlives it, and
 * invalidatePageToken() drops it the instant Meta rejects a credential.
 */
export async function resolvePageToken(cfg, fetchImpl = fetch) {
  // An explicitly configured Page token is used as-is. No exchange, no extra Graph call, and the
  // previous behaviour is preserved exactly for anyone still running that way.
  if (!cfg.systemUserToken) {
    return cfg.token
      ? { ok: true, token: cfg.token, mode: 'page_token' }
      : { ok: false, reason: 'no credential configured', code: META_OAUTH_ERROR_CODE };
  }

  if (cache && cache.pageId === cfg.pageId && cache.graphVersion === cfg.graphVersion
      && Date.now() - cache.at < PAGE_TOKEN_TTL_MS) {
    return { ok: true, token: cache.token, mode: 'system_user', cached: true };
  }

  let r, body;
  try {
    // The System User credential travels in the Authorization header, not the query string: a URL
    // reaches proxy logs, redirect chains and error traces, and a header does not.
    r = await fetchImpl(graphUrl(cfg, `${cfg.pageId}?fields=access_token`), {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.systemUserToken}` },
    });
    body = await r.json().catch(() => ({}));
  } catch (e) {
    // A transport failure is not a credential failure, but it must not be terminal either.
    return { ok: false, code: null,
      reason: `page token exchange: transport: ${redactCredential(String(e?.message || e)).slice(0, 100)}` };
  }

  const token = body?.access_token;
  if (r.ok && token) {
    cache = { pageId: cfg.pageId, graphVersion: cfg.graphVersion, token: String(token), at: Date.now() };
    return { ok: true, token: String(token), mode: 'system_user' };
  }

  const err = body?.error || {};
  // A 200 with no access_token field is the signature of a System User that can SEE the Page but has
  // not been assigned it, which is a different fix from a bad token and worth saying out loud.
  const why = `page token exchange: HTTP ${r.status}`
    + (err.code ? ` code ${err.code}` : '')
    + (err.error_subcode ? `/${err.error_subcode}` : '')
    + (err.message ? `: ${redactCredential(err.message).slice(0, 140)}` : '')
    + (r.ok && !token ? ': no access_token field — is the Page assigned to this System User?' : '');
  return { ok: false, reason: why, code: err.code ?? META_OAUTH_ERROR_CODE };
}
