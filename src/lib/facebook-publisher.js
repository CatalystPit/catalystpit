import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { facebookText, facebookEligibility, facebookConfig, facebookReadiness,
  isPermanentFailure, failureSpendsAttempt } from './facebook-post.mjs';

// PUBLISHING WALTER BLOOMBERG TO THE CATALYST PIT FACEBOOK PAGE.
//
// `server-only` is a build-time tripwire: if anything reachable from a 'use client' component ever
// imports this file, the production build FAILS rather than shipping a module that reads a Page
// access token. Same guard, same reason, as wire-sources.server.mjs and ticker-seo.server.mjs.
//
// THE TOKEN NEVER LEAVES THIS FILE. It is read from the environment inside the request, sent to
// Meta in the POST body, and never returned, logged, rendered or included in an error string. Every
// failure path below reconstructs its message from the HTTP status and Meta's own error text, and
// Meta does not echo the token back. There is no code path that puts it in a Response.
//
// IT NEVER BLOCKS INGESTION. Nothing here is called inline from insertEvents; ingestion enqueues a
// row and returns. A Meta outage, a revoked token or a rate limit leaves Pit Wire untouched, and the
// queued row simply waits.

let _ensured = false;
export async function ensureFacebookTable() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS fb_post_candidates (
    id SERIAL PRIMARY KEY,
    event_seq BIGINT,
    source_uid TEXT,
    content_hash TEXT NOT NULL,
    message TEXT NOT NULL,
    page_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    fb_post_id TEXT,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    posted_at TIMESTAMPTZ
  )`);
  // THE DUPLICATE DEFENCE, at the database rather than in application logic. content_hash is the
  // canonical event's own hash, already unique per real-world story, so two ingests of the same
  // Walter item cannot produce two queue rows however the calling code behaves.
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_fb_candidate_hash ON fb_post_candidates (content_hash)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_fb_candidate_seq ON fb_post_candidates (event_seq) WHERE event_seq IS NOT NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_fb_candidate_status ON fb_post_candidates (status)`);
  _ensured = true;
}

/**
 * Queue a newly ingested Walter event. Called AFTER the row is written, never before, and wrapped by
 * the caller so a failure here cannot affect ingestion.
 *
 * Returns { queued, reason }. Queuing is not publishing: the kill switch is checked at publish time,
 * so a queue built while publishing is off is simply a queue, and turning the switch on later does
 * not retroactively fire a backlog — see publishPending, which only takes rows created recently.
 */
export async function queueFacebookPost(ev, { isNew, isCanonical, isBackfill = false } = {}) {
  const decision = facebookEligibility(ev, { isNew, isCanonical, isBackfill });
  if (!decision.eligible) return { queued: false, reason: decision.reason };
  const message = facebookText(ev);
  try {
    await ensureFacebookTable();
    const res = await db.execute(sql`
      insert into fb_post_candidates (event_seq, source_uid, content_hash, message)
      values (${ev._seq ?? ev.seq ?? null}, ${ev.source_uid ?? null}, ${ev.content_hash}, ${message})
      on conflict do nothing
      returning id`);
    const row = (res.rows ?? res)?.[0];
    return row ? { queued: true, id: row.id } : { queued: false, reason: 'already queued' };
  } catch (e) {
    console.error('[facebook] queue failed', String(e?.message || e).slice(0, 120));
    return { queued: false, reason: 'queue error' };
  }
}

const GRAPH = (cfg, path) => `https://graph.facebook.com/${cfg.graphVersion}/${path}`;

/**
 * Send one message to the Page. The ONLY function that contacts Meta.
 *
 * The token goes in the POST BODY, not the query string: a URL can end up in a proxy log or an error
 * trace, and a body does not. The returned error text is built from the status and Meta's own
 * message, which never contains the credential.
 */
async function postToPage(cfg, message, fetchImpl = fetch) {
  const r = await fetchImpl(GRAPH(cfg, `${cfg.pageId}/feed`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, access_token: cfg.token }),
  });
  const body = await r.json().catch(() => ({}));
  if (r.ok && body?.id) return { ok: true, id: String(body.id) };
  const err = body?.error || {};
  // Meta's own words, capped. `code` and `message` say whether this is a permission problem, an
  // expired token or a content rejection, and those need different fixes.
  const why = `HTTP ${r.status}`
    + (err.code ? ` code ${err.code}` : '')
    + (err.error_subcode ? `/${err.error_subcode}` : '')
    + (err.message ? `: ${String(err.message).slice(0, 160)}` : '');
  // A credential failure is not a property of this post — see isPermanentFailure. The code is
  // returned so the caller can tell an expired token from a rejected post; it is a small integer
  // from Meta's error envelope and carries nothing sensitive.
  return { ok: false, reason: why, code: err.code ?? null, permanent: isPermanentFailure(r.status, err.code) };
}

/**
 * Publish one queued candidate.
 *
 * CRASH SAFETY. Meta's /feed endpoint has no idempotency key, so a process that dies between "Meta
 * accepted the post" and "we recorded the id" cannot be distinguished from one that died before the
 * call. The row is therefore marked `publishing` BEFORE the request and is never picked up again
 * automatically: a stuck row needs a human to look at the Page and either mark it posted or release
 * it. That trades a rare manual step for never double-posting, which is the right way round on a
 * public page.
 */
export async function publishFacebookCandidate(id, { fetchImpl = fetch } = {}) {
  const cfg = facebookConfig();
  // Checked before any database read, any request object and any credential access.
  if (!cfg.enabled) return { sent: false, reason: 'FACEBOOK_AUTO_POST_ENABLED is not true' };
  if (!cfg.pageId || !cfg.token) return { sent: false, reason: 'page id or token not configured' };

  await ensureFacebookTable();
  // The join resolves the source event in the same round trip — see the provenance gate below.
  const cur = (await db.execute(sql`
    select c.id, c.event_seq, c.message, c.status, c.attempts, c.fb_post_id, e.seq as source_seq
      from fb_post_candidates c
      left join primary_events e on e.seq = c.event_seq
     where c.id = ${id}`)).rows?.[0];
  if (!cur) return { sent: false, reason: 'no such candidate' };
  if (cur.fb_post_id) return { sent: false, reason: 'already posted', fbPostId: cur.fb_post_id };
  if (cur.status === 'publishing') return { sent: false, reason: 'left mid-publish, needs manual review' };
  if (cur.status === 'failed') return { sent: false, reason: 'previously failed permanently' };
  if (Number(cur.attempts) >= MAX_FB_ATTEMPTS) return { sent: false, reason: 'attempts exhausted' };

  // PROVENANCE. Everything published to the Page must trace to an ingested Walter event. Queuing
  // already runs inside insertEvents, so this is true of every row ever written — 33 of 33, none
  // orphaned — and the gate changes nothing about what gets posted. It makes that an enforced
  // invariant: no future path into this table can put text on the Page without a real event behind it.
  //
  // Deliberately duplicated rather than shared with the X publisher. These two systems have no table,
  // column, formatter, route, credential or status value in common, and a helper spanning both would
  // be the first thing to couple them.
  //
  // Checked BEFORE the row is marked `publishing`, so a rejected candidate never enters the state
  // that requires manual review, and terminal rather than retried: a row with no source event is not
  // a transient failure.
  if (cur.event_seq == null || cur.source_seq == null) {
    const why = cur.event_seq == null ? 'no source event' : 'source event no longer exists';
    await db.execute(sql`update fb_post_candidates
       set status = 'failed', failure_reason = ${'provenance: ' + why}, updated_at = now()
     where id = ${id}`);
    return { sent: false, reason: 'provenance: ' + why, permanent: true };
  }

  await db.execute(sql`update fb_post_candidates
     set status = 'publishing', attempts = attempts + 1, page_id = ${cfg.pageId}, updated_at = now()
   where id = ${id}`);

  try {
    const out = await postToPage(cfg, cur.message, fetchImpl);
    if (out.ok) {
      await db.execute(sql`update fb_post_candidates
         set status = 'posted', fb_post_id = ${out.id}, failure_reason = null,
             posted_at = now(), updated_at = now() where id = ${id}`);
      return { sent: true, fbPostId: out.id };
    }
    // THE ATTEMPT IS STILL TAKEN BEFORE THE REQUEST, and only given back once Meta has answered
    // that the problem was the credential. That ordering is what keeps the crash-safety property:
    // a process that dies mid-request leaves the row in `publishing` with the attempt counted, and
    // is still never picked up again automatically.
    const spent = failureSpendsAttempt(out.code);
    await db.execute(sql`update fb_post_candidates
       set status = ${out.permanent ? 'failed' : 'pending'},
           attempts = ${spent ? sql`attempts` : sql`greatest(attempts - 1, 0)`},
           failure_reason = ${out.reason}, updated_at = now() where id = ${id}`);
    return { sent: false, reason: out.reason, permanent: out.permanent, authFailure: !spent };
  } catch (e) {
    // The request itself failed, so Meta may or may not have seen it. Left in `publishing` rather
    // than released, for the reason in the doc comment above.
    const why = `transport: ${String(e?.message || e).slice(0, 100)}`;
    await db.execute(sql`update fb_post_candidates
       set failure_reason = ${why}, updated_at = now() where id = ${id}`);
    return { sent: false, reason: why };
  }
}

export const MAX_FB_ATTEMPTS = 3;
const MAX_PER_RUN = 5;
// A queued row older than this is not published. It stops a backlog accumulated while the switch was
// off from firing all at once the moment it is turned on, and it stops stale news going out late.
const MAX_AGE_MINUTES = 30;

/** Drain the queue. Bounded per run and age-limited; publishes nothing when the switch is off. */
export async function publishPendingFacebook({ limit = MAX_PER_RUN, fetchImpl = fetch } = {}) {
  const cfg = facebookConfig();
  if (!cfg.enabled) return { sent: 0, enabled: false, results: [] };
  await ensureFacebookTable();
  const rows = (await db.execute(sql`
    select id from fb_post_candidates
     where status = 'pending' and fb_post_id is null
       and created_at > now() - (${MAX_AGE_MINUTES} || ' minutes')::interval
     order by id asc limit ${limit}`)).rows ?? [];
  const results = [];
  for (const r of rows) results.push({ id: r.id, ...(await publishFacebookCandidate(r.id, { fetchImpl })) });
  // An expired or revoked credential is the one failure a human has to act on, and it is silent
  // otherwise: the queue simply stops draining. Surfaced in the run log, with no credential in it.
  const authFailures = results.filter((x) => x.authFailure).length;
  if (authFailures) {
    console.warn(`[facebook] CREDENTIAL FAILURE on ${authFailures} of ${results.length} candidates`
      + ' — the Page token is expired, revoked or of the wrong type. Posts are being HELD, not lost,'
      + ' until it is replaced or they pass the freshness limit.');
  }
  return { sent: results.filter((x) => x.sent).length, enabled: true, authFailures, results };
}

/**
 * THE ONE MANUAL TEST. Publishes a fixed, harmless line written for this purpose.
 *
 * It deliberately does NOT accept caller-supplied text and does NOT read the queue: using a real
 * Walter item as a test is how historical content gets published by accident, so there is no code
 * path here that can reach one. It also bypasses FACEBOOK_AUTO_POST_ENABLED, because the point of
 * the test is to verify credentials BEFORE automation is switched on — it is guarded by the cron
 * route's own authentication instead.
 */
export async function publishFacebookTest({ fetchImpl = fetch } = {}) {
  const cfg = facebookConfig();
  if (!cfg.pageId || !cfg.token) {
    return { sent: false, reason: 'page id or token not configured', readiness: facebookReadiness(cfg) };
  }
  const message = 'Catalyst Pit publishing test. This post confirms the Page connection and will be removed.';
  const out = await postToPage(cfg, message, fetchImpl);
  return out.ok
    ? { sent: true, fbPostId: out.id, message }
    : { sent: false, reason: out.reason, readiness: facebookReadiness(cfg) };
}

/**
 * CREDENTIAL HEALTH, derived from what the queue already recorded.
 *
 * No new table and no new state: every rejection already stores its reason, and Meta's OAuth code
 * is in that string. Counting the auth failures since the last successful publish is enough to tell
 * a working credential from an expired or revoked one — zero means healthy, a non-zero count with a
 * recent timestamp means the token is broken RIGHT NOW and posts are being held.
 *
 * NOTHING SENSITIVE LEAVES. The count and two timestamps are computed here; the failure text itself
 * is never returned. Meta does not echo a token in an error body, and this does not read one either.
 */
export async function facebookAuthHealth() {
  await ensureFacebookTable();
  const rows = (await db.execute(sql`
    with last_ok as (
      select coalesce(max(posted_at), to_timestamp(0)) as t from fb_post_candidates where fb_post_id is not null)
    select count(*) filter (where c.failure_reason like '%code 190%')::int              as auth_failures,
           max(c.updated_at) filter (where c.failure_reason like '%code 190%')          as last_auth_failure,
           (select t from last_ok)                                                      as last_published
      from fb_post_candidates c, last_ok
     where c.updated_at > last_ok.t`)).rows ?? [];
  const r = rows[0] || {};
  const n = Number(r.auth_failures) || 0;
  return {
    authFailuresSinceLastSuccess: n,
    lastAuthFailureAt: r.last_auth_failure ? new Date(r.last_auth_failure).toISOString() : null,
    lastPublishedAt: r.last_published && Number(new Date(r.last_published)) > 0
      ? new Date(r.last_published).toISOString() : null,
    // The one line an operator needs: is the credential working?
    credentialHealthy: n === 0,
  };
}

/** Configuration status for an operator. Reports WHETHER a token is set, never what it is. */
export function facebookStatus() {
  return facebookReadiness(facebookConfig());
}
