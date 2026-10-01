import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { threadsText, threadsEligibility, threadsConfig, threadsReadiness,
  THREADS_CATALYST_WORDING } from './threads-post.mjs';
import { redactCredential } from '../facebook-post.mjs';
import { DELIVERY_STATUS, FAILURE_CLASS, PHASE, MAX_DELIVERY_ATTEMPTS, MAX_PER_RUN,
  DAILY_POST_LIMIT, MAX_AGE_MINUTES, classifyProviderFailure, backoffMs, providerErrorText,
  switchedOn } from './social-delivery.mjs';
import { ensureSocialTables, claimDelivery, recordChannelScan, channelActivation,
  queueDelivery, dailyPostedCount } from './social-store.js';

// THREADS PUBLISHING. The I/O half; every editorial decision is in threads-post.mjs, which is pure.
//
// `server-only` is a build-time tripwire, the same one facebook-publisher.js carries: if anything
// reachable from a 'use client' component ever imports this file, the build FAILS rather than shipping
// a module that reads an access token.
//
// THE TOKEN NEVER LEAVES THIS FILE. It is read from the environment inside the call, sent to Meta in
// the POST body, and never returned, logged, rendered or put in an error string. Threads' error
// envelope can echo a submitted token the same way Facebook's does, so every provider message is
// passed through redactCredential before it is stored — and the stored text is still treated as
// credential-bearing: counted and matched against, never returned to a caller.
//
// THREADS IS NOT FACEBOOK AND DOES NOT SHARE ITS CREDENTIAL. Instagram hangs off the same Page and
// Business portfolio, so it can use the Facebook System User token. Threads is a separate API on
// graph.threads.net with its own user id and its own long-lived token. There is no path here that
// falls back to a Facebook credential, because a Facebook token on this host is simply invalid and a
// fallback would turn "Threads is not configured" into an opaque auth failure.

const CHANNEL = 'threads';
const TIMEOUT_MS = 15_000;

/** Configuration status for an operator: whether a credential is set, never what it is. */
export function threadsStatus() {
  return { channel: CHANNEL, ...threadsReadiness(threadsConfig()) };
}

/**
 * Find canonical events that may go to Threads, and record one delivery row for each.
 *
 * QUEUING IS NOT PUBLISHING. The kill switch is checked at publish time, so a queue built while the
 * channel is off is just a queue — and because every row is bounded by BOTH the activation watermark
 * and the age window, turning the switch on later cannot fire a backlog.
 *
 * The LEFT JOIN against this channel's own delivery rows is what stops a re-run queueing twice, and it
 * is scoped to the channel: an event Instagram has already taken is still available to Threads.
 */
export async function queueThreads({ limit = 20 } = {}) {
  await ensureSocialTables();
  // ⚠️ CONFIGURATION FIRST, SO THE WATERMARK MEANS WHAT IT SAYS. An unconfigured channel must not
  // stamp an activation instant: the row would then record the first time this code happened to run
  // rather than the moment Threads was switched on, and anyone later reading it would draw the wrong
  // conclusion about which events the channel was ever asked to carry. Instagram already did this.
  const cfgEarly = threadsConfig();
  if (!cfgEarly.userId || !cfgEarly.token) {
    const out = { channel: CHANNEL, queued: 0, examined: 0, skipped: ['threads not configured'] };
    await recordChannelScan(CHANNEL, out).catch(() => {});
    return out;
  }
  // ⚠️ THE WATERMARK IS READ AND WRITTEN BEFORE ANY EVENT IS CONSIDERED. On the very first call this
  // sets activated_at = now(), so the query below — which requires received_at > activated_at — can
  // match nothing at all. First activation therefore queues zero rows by construction rather than by
  // the luck of an empty window.
  const activatedAt = await channelActivation(CHANNEL);

  const wording = [...THREADS_CATALYST_WORDING].join(',');
  const rows = (await db.execute(sql`
    select e.seq, e.source, e.source_uid, e.headline, e.headline_status, e.tickers, e.content_hash,
           e.importance, e.received_at
      from primary_events e
      left join social_deliveries d on d.event_seq = e.seq and d.channel = ${CHANNEL}
     where d.id is null
       and e.cluster_id is null
       -- Catalyst Pit's own wording only. Until enrichment has run, the headline column is still the
       -- publisher's line, and this is a WAIT rather than a rejection: no row is written, so the next
       -- scan reconsiders the event.
       --
       -- ARRAY LITERAL, not a JS array. Passing an array straight into a drizzle template throws on
       -- this driver, which is how the Facebook reworded scan once failed silently for half an hour.
       and e.headline_status = any(${`{${wording}}`}::text[])
       -- THE SAME EDITORIAL BAR THE X CHANNEL USES: HIGH or better. Threads is a text channel for our
       -- own sentence, so what qualifies is the EVENT's importance, never a particular publisher's
       -- copy — which is why there is no source whitelist here.
       and coalesce(e.importance, 0) >= 2
       -- Both freshness bounds, in SQL as well as in the pure check below, so a large backlog is never
       -- even read into memory.
       and e.received_at > ${activatedAt}
       and e.received_at > now() - (${MAX_AGE_MINUTES} || ' minutes')::interval
     order by e.received_at desc
     limit ${Math.max(1, Math.min(100, limit))}`)).rows ?? [];

  let queued = 0;
  const skipped = [];
  for (const ev of rows) {
    // Through the pure eligibility and the pure text builder, exactly as every other channel does.
    // This function decides only WHICH events to consider, never whether they may publish or what
    // they say.
    const decision = threadsEligibility(ev, { isNew: true, isCanonical: true, qualifies: true });
    if (!decision.eligible) { skipped.push(decision.reason); continue; }
    const text = threadsText(ev);
    const res = await queueDelivery({
      channel: CHANNEL, eventSeq: ev.seq, contentHash: ev.content_hash,
      sourceUid: ev.source_uid ?? null, payloadText: text, mediaUrl: null,
    });
    if (res.queued) queued += 1; else skipped.push(res.reason);
  }
  const out = { channel: CHANNEL, queued, examined: rows.length, skipped: [...new Set(skipped)] };
  // A heartbeat, written where an operator already reads feed health, so "did the scan run at all?"
  // is answerable without a log reader. Never allowed to fail the scan.
  await recordChannelScan(CHANNEL, out).catch(() => {});
  return out;
}

/**
 * The two Threads calls. Separated from the state machine so the protocol can be exercised against an
 * injected fetch with no credential, no database and no network.
 */
async function threadsCall(cfg, path, body, fetchImpl) {
  const url = `https://${cfg.host}/${cfg.apiVersion}/${cfg.userId}/${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The token travels in the BODY, not the query string: a URL reaches proxy logs, redirect
      // chains and error traces, and a body does not.
      body: JSON.stringify({ ...body, access_token: cfg.token }),
      signal: ctl.signal,
    });
    const json = await r.json().catch(() => ({}));
    return { httpOk: r.ok, status: r.status, json };
  } catch (e) {
    // AbortError is our own timeout; anything else is transport. The distinction matters because a
    // timeout on the publish step is the one genuinely ambiguous failure in this protocol.
    const timeout = e?.name === 'AbortError';
    return { httpOk: false, status: null, timeout, transport: !timeout,
      message: redactCredential(String(e?.message || e)).slice(0, 100) };
  } finally { clearTimeout(timer); }
}

/**
 * Publish one queued delivery.
 *
 * ⚠️ WHY THIS CANNOT DOUBLE-POST, stated as the four cases the brief asks about:
 *
 *   CRON OVERLAP / CONCURRENT WORKERS — the row is claimed with a conditional UPDATE that only
 *   succeeds from `pending`. Two workers race on one row; Postgres serialises them; the loser gets no
 *   row back and returns without contacting Meta.
 *
 *   RESTART BETWEEN CONTAINER AND PUBLISH — the container id is persisted the moment it exists, and a
 *   resumed attempt publishes THAT container rather than creating another. Creating a container
 *   publishes nothing, so nothing was lost and nothing was duplicated.
 *
 *   TIMEOUT ON THE PUBLISH CALL — genuinely ambiguous: Meta may have accepted it. The row stays in
 *   `publishing` and is never reclaimed automatically. That trades a rare manual step for never
 *   double-posting, which is the right way round on a public account.
 *
 *   REPLAY OF AN ALREADY-PUBLISHED ROW — provider_post_id is checked before anything else, and
 *   UNIQUE(channel, event_seq) means a second row for the same event cannot exist to be published.
 */
export async function publishThreadsDelivery(id, { fetchImpl = fetch } = {}) {
  const cfg = threadsConfig();
  // Checked before any database read, any request object and any credential access.
  if (!cfg.enabled) return { sent: false, reason: 'THREADS_AUTO_POST_ENABLED is not true' };
  if (!cfg.userId || !cfg.token) return { sent: false, reason: 'threads user id or token not configured' };

  const claim = await claimDelivery(CHANNEL, id);
  if (!claim.ok) return { sent: false, reason: claim.reason };
  const row = claim.row;

  // ── step 1: the container. Retryable in every failure mode, because it publishes nothing. ──
  let containerId = row.container_id || null;
  if (!containerId) {
    const res = await threadsCall(cfg, 'threads', { media_type: 'TEXT', text: row.payload_text }, fetchImpl);
    if (res.httpOk && res.json?.id) {
      containerId = String(res.json.id);
      await db.execute(sql`update social_deliveries
         set container_id = ${containerId}, container_at = now(), updated_at = now()
       where id = ${id}`);
    } else {
      const err = res.json?.error || {};
      const cls = classifyProviderFailure({ status: res.status, errorCode: err.code,
        phase: PHASE.CONTAINER, transport: res.transport, timeout: res.timeout });
      const why = res.status == null
        ? `container: ${res.timeout ? 'timeout' : 'transport'}: ${res.message || ''}`.slice(0, 200)
        : providerErrorText({ status: res.status, errorCode: err.code ?? null,
            subcode: err.error_subcode ?? null, message: err.message || '', phase: 'container' },
          redactCredential);
      await settleFailure(id, row, cls, why);
      return { sent: false, reason: why, failureClass: cls.class, permanent: cls.permanent };
    }
  }

  // ── step 2: publish the container. The only call that can create a post. ──
  const res = await threadsCall(cfg, 'threads_publish', { creation_id: containerId }, fetchImpl);
  if (res.httpOk && res.json?.id) {
    await db.execute(sql`update social_deliveries
       set status = ${DELIVERY_STATUS.POSTED}, provider_post_id = ${String(res.json.id)},
           failure_reason = null, failure_class = null, retry_after = null,
           posted_at = now(), updated_at = now()
     where id = ${id}`);
    return { sent: true, providerPostId: String(res.json.id) };
  }

  const err = res.json?.error || {};
  const cls = classifyProviderFailure({ status: res.status, errorCode: err.code,
    phase: PHASE.PUBLISH, transport: res.transport, timeout: res.timeout });
  const why = res.status == null
    ? `publish: ${res.timeout ? 'timeout' : 'transport'}: ${res.message || ''}`.slice(0, 200)
    : providerErrorText({ status: res.status, errorCode: err.code ?? null,
        subcode: err.error_subcode ?? null, message: err.message || '', phase: 'publish' },
      redactCredential);

  if (cls.needsManualReview) {
    // LEFT IN `publishing`, DELIBERATELY. See the doc comment: Meta may have accepted this post and we
    // cannot tell. The container id is already stored, so a human can check the account and either
    // mark it posted or release it.
    await db.execute(sql`update social_deliveries
       set failure_reason = ${why}, failure_class = ${cls.class}, updated_at = now()
     where id = ${id}`);
    return { sent: false, reason: why, failureClass: cls.class, needsManualReview: true };
  }
  await settleFailure(id, row, cls, why);
  return { sent: false, reason: why, failureClass: cls.class, permanent: cls.permanent };
}

/**
 * Write a failure back to the row.
 *
 * THE ATTEMPT IS TAKEN BEFORE THE REQUEST and given back only when the provider has said the problem
 * was the credential or the rate — the same ordering Facebook uses, and for the same reason: a process
 * that dies mid-request must leave the attempt counted. Refunding a credential failure is what lets a
 * fixed token drain the queue instead of finding every row exhausted.
 */
async function settleFailure(id, row, cls, why) {
  const attempts = Number(row.attempts) || 1;
  const until = new Date(Date.now() + backoffMs(attempts, cls.class));
  await db.execute(sql`update social_deliveries
     set status = ${cls.permanent ? DELIVERY_STATUS.FAILED : DELIVERY_STATUS.PENDING},
         attempts = ${cls.spendsAttempt ? sql`attempts` : sql`greatest(attempts - 1, 0)`},
         failure_reason = ${String(why).slice(0, 400)},
         failure_class = ${cls.class},
         retry_after = ${cls.permanent ? null : until},
         updated_at = now()
   where id = ${id}`);
}

/** Drain this channel's queue. Bounded per run, and publishes nothing when the switch is off. */
export async function publishPendingThreads({ limit = MAX_PER_RUN.threads, fetchImpl = fetch } = {}) {
  const cfg = threadsConfig();
  if (!cfg.enabled) return { channel: CHANNEL, sent: 0, enabled: false, results: [] };
  if (!cfg.userId || !cfg.token) {
    // NOT AN ERROR, AND NOT A RETRY LOOP. An unconfigured channel reports itself unconfigured once per
    // run and does nothing else; it must not hammer a provider it has no credential for.
    return { channel: CHANNEL, sent: 0, enabled: true, configured: false, results: [] };
  }
  await ensureSocialTables();

  // Meta's 24-hour ceiling, respected by declining to send rather than by being refused.
  const postedToday = await dailyPostedCount(CHANNEL);
  if (postedToday >= DAILY_POST_LIMIT.threads) {
    return { channel: CHANNEL, sent: 0, enabled: true, dailyLimitReached: true, postedToday, results: [] };
  }
  const room = Math.max(0, Math.min(limit, DAILY_POST_LIMIT.threads - postedToday));

  const rows = (await db.execute(sql`
    select id from social_deliveries
     where channel = ${CHANNEL}
       and status = ${DELIVERY_STATUS.PENDING}
       and provider_post_id is null
       and attempts < ${MAX_DELIVERY_ATTEMPTS}
       and (retry_after is null or retry_after <= now())
       -- The age window applies to the DRAIN as well as to the scan, so a row that waited out an
       -- outage is dropped rather than published late.
       and created_at > now() - (${MAX_AGE_MINUTES} || ' minutes')::interval
     order by created_at asc limit ${room}`)).rows ?? [];

  const results = [];
  for (const r of rows) results.push({ id: r.id, ...(await publishThreadsDelivery(r.id, { fetchImpl })) });
  const authFailures = results.filter((x) => x.failureClass === FAILURE_CLASS.AUTH).length;
  if (authFailures) {
    // No credential in the message: the count and the fix, which is all an operator can act on.
    console.error(`[threads] CREDENTIAL FAILURE on ${authFailures} of ${results.length} deliveries`
      + ' — THREADS_ACCESS_TOKEN is expired, revoked or lacks threads_content_publish.'
      + ` Posts are HELD, not lost, but only for ${MAX_AGE_MINUTES} minutes.`);
  }
  return { channel: CHANNEL, sent: results.filter((x) => x.sent).length, enabled: true,
    configured: true, authFailures, postedToday, results };
}
