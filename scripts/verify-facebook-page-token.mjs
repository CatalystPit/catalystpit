// SYSTEM USER -> PAGE TOKEN: the exchange that makes unattended publishing work, exercised against
// a fake Graph API rather than asserted on the shape of the source.
//
// THE PRODUCTION FAILURE. Business Manager was configured correctly — System User with Admin access,
// Page assigned at Full Access, app assigned, token generated with pages_manage_posts,
// pages_read_engagement, pages_show_list and expiry "Never" — and publishing still failed with
// "(#200) ... requires ... pages_manage_posts permission with page token". POST /{page-id}/feed
// needs a PAGE-type token; a System User token is a USER-type token. The setup was right and the
// token class was wrong.
//
// And the obvious workaround is a trap: reading GET /{page-id}?fields=access_token from the Graph
// API Explorer signs the request as the person using the Explorer, so the Page token it returns
// inherits THAT session's short lifetime and personal app-scoped identity — it dies within the hour.
// Made with the System User token, the same call returns a Page token derived from a credential that
// never expires.
//
//   node scripts/verify-facebook-page-token.mjs

import { resolvePageToken, invalidatePageToken, pageTokenCached, graphUrl }
  from '../src/lib/facebook-page-token.mjs';
import { facebookConfig, facebookReadiness, isPermanentFailure, failureSpendsAttempt }
  from '../src/lib/facebook-post.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);

const SYSTEM_USER_TOKEN = 'SYSU' + 'x'.repeat(120);
const PAGE_TOKEN = 'EAAPAGE' + 'y'.repeat(120);
const PAGE_ID = '1327000000000629';
const cfgSystemUser = { pageId: PAGE_ID, graphVersion: 'v26.0', systemUserToken: SYSTEM_USER_TOKEN, token: null };
const cfgPageToken = { pageId: PAGE_ID, graphVersion: 'v26.0', systemUserToken: null, token: PAGE_TOKEN };

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
// Records every call so we can assert what was sent, and to WHOM.
const spy = (handler) => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  f.calls = calls;
  return f;
};
const okExchange = () => spy(() => res(200, { access_token: PAGE_TOKEN, id: PAGE_ID }));

section('1. the System User token is exchanged, not posted with');
{
  invalidatePageToken();
  const f = okExchange();
  const out = await resolvePageToken(cfgSystemUser, f);
  ok('the exchange succeeds', out.ok === true, out.reason);
  ok('it returns the PAGE token, not the System User token', out.token === PAGE_TOKEN);
  ok('the System User token is never what publishing uses', out.token !== SYSTEM_USER_TOKEN);
  ok('the mode is reported', out.mode === 'system_user');
  ok('exactly one Graph call was made', f.calls.length === 1, String(f.calls.length));

  const { url, init } = f.calls[0];
  ok('it reads the Page node access_token field',
    url === `https://graph.facebook.com/v26.0/${PAGE_ID}?fields=access_token`, url);
  ok('it is a GET', (init.method || 'GET') === 'GET');
  // The credential must not be in the URL: URLs reach proxy logs, redirect chains and error traces.
  ok('the credential is NOT in the query string', !url.includes(SYSTEM_USER_TOKEN));
  ok('the credential travels in the Authorization header',
    init.headers.Authorization === `Bearer ${SYSTEM_USER_TOKEN}`);
  ok('the Graph version comes from config', graphUrl(cfgSystemUser, 'x').includes('/v26.0/'));
}

section('2. it is cached, and the cache cannot serve the wrong Page');
{
  invalidatePageToken();
  const f = okExchange();
  await resolvePageToken(cfgSystemUser, f);
  const second = await resolvePageToken(cfgSystemUser, f);
  ok('a second resolve does not hit Graph again', f.calls.length === 1, String(f.calls.length));
  ok('it is marked as cached', second.cached === true);
  ok('it still returns the right token', second.token === PAGE_TOKEN);

  // Keyed on page id and Graph version: changing either must re-derive, never reuse.
  const other = await resolvePageToken({ ...cfgSystemUser, pageId: '999' }, f);
  ok('a different page id re-derives', f.calls.length === 2, String(f.calls.length));
  ok('the re-derive asks for the OTHER page', f.calls[1].url.includes('/999?fields='));
  invalidatePageToken();
  await resolvePageToken(cfgSystemUser, f);
  const vf = spy(() => res(200, { access_token: PAGE_TOKEN }));
  await resolvePageToken({ ...cfgSystemUser, graphVersion: 'v27.0' }, vf);
  ok('a different graph version re-derives', vf.calls.length === 1);

  invalidatePageToken();
  ok('invalidating clears the cache', pageTokenCached() === false);
}

section('3. an explicit Page token still works exactly as before');
{
  invalidatePageToken();
  const f = okExchange();
  const out = await resolvePageToken(cfgPageToken, f);
  ok('it is used as-is', out.ok && out.token === PAGE_TOKEN);
  ok('NO Graph call is made to derive it', f.calls.length === 0, String(f.calls.length));
  ok('the mode says so', out.mode === 'page_token');
  const none = await resolvePageToken({ pageId: PAGE_ID, graphVersion: 'v26.0' }, f);
  ok('no credential at all fails, and fails as a credential problem',
    none.ok === false && none.code === 190);
}

section('4. a failed exchange HOLDS the post — it never destroys it');
{
  // This is the property that cost real posts. Every way the exchange can fail is a credential
  // problem, so it must route into the retryable path, not the terminal one.
  const cases = [
    ['an expired System User token', 400, { error: { message: 'Session has expired', code: 190, error_subcode: 463 } }],
    ['a revoked System User token', 400, { error: { message: 'revoked', code: 190 } }],
    ['the Page not assigned to the System User', 403, { error: { message: 'Permissions error', code: 200 } }],
    ['a 200 with no access_token field', 200, { id: PAGE_ID }],
  ];
  for (const [label, status, body] of cases) {
    invalidatePageToken();
    const out = await resolvePageToken(cfgSystemUser, spy(() => res(status, body)));
    ok(`${label}: reported as a failure`, out.ok === false);
    ok(`${label}: classified as a credential failure`,
      isPermanentFailure(status, out.code) === false, 'code ' + out.code);
    ok(`${label}: does not spend an attempt`, failureSpendsAttempt(out.code) === false, 'code ' + out.code);
    ok(`${label}: nothing is cached`, pageTokenCached() === false);
    ok(`${label}: the reason names the exchange`, /page token exchange/.test(out.reason), out.reason);
  }
  // The unassigned-Page case is a different fix from a bad token, so it says which.
  invalidatePageToken();
  const unassigned = await resolvePageToken(cfgSystemUser, spy(() => res(200, { id: PAGE_ID })));
  ok('an unassigned Page says so in words', /is the Page assigned/.test(unassigned.reason), unassigned.reason);
}

section('5. no credential ever appears in a failure string');
{
  // Meta's "Malformed access token" class echoes the SUBMITTED token back. That string is persisted
  // in failure_reason and returned by the cron route, so it must be redacted at the source.
  invalidatePageToken();
  const echoed = { error: { message: `Malformed access token ${SYSTEM_USER_TOKEN} is not valid`, code: 190 } };
  const out = await resolvePageToken(cfgSystemUser, spy(() => res(400, echoed)));
  ok('the echoed System User token is stripped', !out.reason.includes(SYSTEM_USER_TOKEN), out.reason);
  ok('the message is still legible', /Malformed access token/.test(out.reason), out.reason);
  ok('no long credential-shaped run survives', !/[A-Za-z0-9_-]{40,}/.test(out.reason), out.reason);

  // A transport failure must not be terminal either — the credential is fine, the network was not.
  invalidatePageToken();
  const boom = await resolvePageToken(cfgSystemUser, spy(() => { throw new Error('socket hang up'); }));
  ok('a transport failure is reported, not thrown', boom.ok === false);
  ok('a transport failure is not permanent', isPermanentFailure(500, boom.code) === false);
  ok('it names the transport', /transport/.test(boom.reason), boom.reason);
}

section('6. configuration and readiness');
{
  const env = { FACEBOOK_AUTO_POST_ENABLED: 'true', FACEBOOK_PAGE_ID: PAGE_ID,
    FACEBOOK_SYSTEM_USER_TOKEN: SYSTEM_USER_TOKEN };
  const c = facebookConfig(env);
  ok('the System User token is read from the environment', c.systemUserToken === SYSTEM_USER_TOKEN);
  const r = facebookReadiness(c);
  ok('a System User token alone is enough to be ready', r.ready === true);
  ok('the mode is reported as system_user', r.credentialMode === 'system_user');
  ok('readiness reports its presence as a boolean', r.hasSystemUserToken === true);
  // The readiness object is returned over HTTP. It must never carry either credential.
  const json = JSON.stringify(r);
  ok('no credential is in the readiness object',
    !json.includes(SYSTEM_USER_TOKEN) && !json.includes(PAGE_TOKEN), json);

  // The System User token wins when both are set: it is the one that does not expire.
  const both = facebookConfig({ ...env, FACEBOOK_PAGE_ACCESS_TOKEN: PAGE_TOKEN });
  ok('the System User path wins when both are configured',
    facebookReadiness(both).credentialMode === 'system_user');
  invalidatePageToken();
  const f = okExchange();
  await resolvePageToken(both, f);
  ok('and it really does exchange rather than use the page token', f.calls.length === 1);

  ok('a page token alone still reports ready',
    facebookReadiness(facebookConfig({ FACEBOOK_AUTO_POST_ENABLED: 'true',
      FACEBOOK_PAGE_ID: PAGE_ID, FACEBOOK_PAGE_ACCESS_TOKEN: PAGE_TOKEN })).ready === true);
  ok('no credential at all is not ready',
    facebookReadiness(facebookConfig({ FACEBOOK_AUTO_POST_ENABLED: 'true', FACEBOOK_PAGE_ID: PAGE_ID })).ready === false);
  ok('the kill switch still governs readiness',
    facebookReadiness(facebookConfig({ FACEBOOK_PAGE_ID: PAGE_ID, FACEBOOK_SYSTEM_USER_TOKEN: SYSTEM_USER_TOKEN })).ready === false);
}

section('7. the publisher uses the exchange, and the safeguards are untouched');
{
  const { readFile } = await import('node:fs/promises');
  const pub = await readFile(new URL('../src/lib/facebook-publisher.js', import.meta.url), 'utf8');
  ok('postToPage resolves a page token first', /const derived = await resolvePageToken\(cfg, fetchImpl\)/.test(pub));
  ok('it publishes with the DERIVED token', /access_token: derived\.token/.test(pub));
  ok('it no longer publishes with the raw configured token', !/access_token: cfg\.token/.test(pub));
  ok('a rejected credential drops the cached page token', /if \(isAuthFailure\(err\.code\)\) invalidatePageToken\(\)/.test(pub));
  ok('a failed exchange short-circuits the POST', pub.indexOf('if (!derived.ok)') < pub.indexOf(`${'$'}{cfg.pageId}/feed`));

  // THE SAFEGUARDS THIS ROUND MUST NOT HAVE LOOSENED.
  ok('the attempt cap is still 3', /MAX_FB_ATTEMPTS = 3/.test(pub));
  ok('the freshness window is still 30 minutes', /MAX_AGE_MINUTES = 30/.test(pub));
  ok('the drain still applies the freshness window', /created_at > now\(\) - \(\$\{MAX_AGE_MINUTES\}/.test(pub));
  ok('the provenance gate is still terminal', /provenance: ' \+ why, permanent: true/.test(pub));
  ok('a row left mid-publish is still never auto-retried', /left mid-publish, needs manual review/.test(pub));
  ok('the kill switch is still checked first', /FACEBOOK_AUTO_POST_ENABLED is not true/.test(pub));
  ok('the queue table is unchanged', /CREATE TABLE IF NOT EXISTS fb_post_candidates/.test(pub));
  ok('dedupe indexes are unchanged',
    /uq_fb_candidate_hash/.test(pub) && /uq_fb_candidate_seq/.test(pub));

  const tok = await readFile(new URL('../src/lib/facebook-page-token.mjs', import.meta.url), 'utf8');
  ok('the token module never logs', !/console\./.test(tok));
  ok('the token module reads no environment variable directly', !/process\.env/.test(tok));
  ok('it touches no database', !/from '\.\/db'/.test(tok) && !/fb_post_candidates/.test(tok));

  // X must be untouched by any of this.
  const x = await readFile(new URL('../src/lib/x-publisher.js', import.meta.url), 'utf8');
  ok('the X publisher shares no Facebook credential path',
    !/facebook-page-token|resolvePageToken|FACEBOOK_/.test(x));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
