import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { DELIVERY_STATUS, MAX_DELIVERY_ATTEMPTS, readyToAttempt } from './social-delivery.mjs';

// THE DURABLE STATE FOR THE NEW CHANNELS: the table, the claim, the watermark, the heartbeat.
//
// Everything in here is deliberately small and shared, because these are the operations whose
// correctness the whole no-duplicate-posts argument rests on. One implementation of the claim means
// one thing to prove, and the two publishers cannot drift apart on it.

let _ensured = false;

/**
 * Create the tables if they are not there. Idempotent, and the same belt-and-braces pattern
 * fb_post_candidates uses: the migration in drizzle/0034 is the record of intent, and this means a
 * deploy that reaches the code before anyone has run the migration still works rather than throwing
 * on every cron tick.
 */
export async function ensureSocialTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS social_deliveries (
    id bigserial PRIMARY KEY,
    channel text NOT NULL,
    event_seq bigint NOT NULL,
    content_hash text NOT NULL,
    source_uid text,
    payload_text text NOT NULL,
    media_url text,
    container_id text,
    container_at timestamptz,
    status text NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0,
    provider_post_id text,
    failure_reason text,
    failure_class text,
    retry_after timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    posted_at timestamptz,
    CONSTRAINT ck_social_channel CHECK (channel IN ('instagram', 'threads')),
    CONSTRAINT ck_social_status CHECK (status IN ('pending','publishing','posted','failed','skipped'))
  )`);
  // ⚠️ THE DEDUPE IS THE SCHEMA'S, not the application's. Scoped to the channel in both cases, so
  // Instagram failing leaves Threads free to publish the same story — which a global unique key on
  // event_seq would forbid, and which is the whole point of independent destinations.
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_social_channel_event ON social_deliveries (channel, event_seq)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_social_channel_hash ON social_deliveries (channel, content_hash)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_social_drain ON social_deliveries (channel, status, created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_social_recent ON social_deliveries (channel, created_at DESC)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS social_channel_activation (
    channel text PRIMARY KEY,
    activated_at timestamptz NOT NULL DEFAULT now(),
    note text,
    CONSTRAINT ck_social_activation_channel CHECK (channel IN ('instagram', 'threads'))
  )`);
  _ensured = true;
}

/**
 * ⚠️ THE ACTIVATION WATERMARK. Read-or-create, and the create is what makes first activation safe.
 *
 * The row is written with activated_at = now() on the first call for a channel, BEFORE any event has
 * been looked at. Every scan then requires received_at > activated_at, so the first run cannot match a
 * single historical event — not because the window happened to be empty, but because the comparison is
 * against a stored instant that is, at that moment, now.
 *
 * ON CONFLICT DO NOTHING means two concurrent first runs cannot produce two different watermarks, and
 * nothing in this module ever moves one forward: a watermark that could advance would be a watermark
 * that could also be reset, and resetting it is the one action that would permit a backfill.
 */
export async function channelActivation(channel) {
  await ensureSocialTables();
  await db.execute(sql`insert into social_channel_activation (channel, activated_at, note)
    values (${channel}, now(), 'first activation: nothing received before this instant is eligible')
    on conflict (channel) do nothing`);
  const row = (await db.execute(sql`select activated_at from social_channel_activation
    where channel = ${channel}`)).rows?.[0];
  return row?.activated_at ?? null;
}

/**
 * Record a delivery row. ON CONFLICT DO NOTHING against either unique index, so a concurrent scan or a
 * second story from another source cannot produce a second row for the same (channel, event).
 */
export async function queueDelivery({ channel, eventSeq, contentHash, sourceUid = null,
  payloadText, mediaUrl = null }) {
  if (!payloadText) return { queued: false, reason: 'no text to publish' };
  if (eventSeq == null || !contentHash) return { queued: false, reason: 'event has no identity' };
  await ensureSocialTables();
  const res = await db.execute(sql`
    insert into social_deliveries (channel, event_seq, content_hash, source_uid, payload_text, media_url)
    values (${channel}, ${eventSeq}, ${contentHash}, ${sourceUid}, ${payloadText}, ${mediaUrl})
    on conflict do nothing
    returning id`);
  const row = (res.rows ?? res)?.[0];
  return row ? { queued: true, id: row.id } : { queued: false, reason: 'already queued for this channel' };
}

/**
 * ⚠️ THE ATOMIC CLAIM — the single mechanism that makes cron overlap and concurrent workers safe.
 *
 * The UPDATE is conditional on the row still being `pending`. Two workers issuing it against one row
 * are serialised by Postgres: the first transitions pending -> publishing and gets the row back, the
 * second matches nothing and gets no row. The loser therefore returns WITHOUT contacting the provider,
 * and it learns this from the database rather than from a lock we would have to manage, a lease we
 * would have to expire, or an advisory lock that a crashed process would hold.
 *
 * It also counts the attempt. Taking the attempt at claim time rather than after the response is what
 * makes a crashed worker visible: the row is left in `publishing` with the attempt spent, which is
 * exactly the state that must never be reclaimed automatically.
 *
 * The provenance gate runs BEFORE the claim, so a row with no source event never enters the state that
 * requires manual review.
 */
export async function claimDelivery(channel, id) {
  // Read first, with the source event joined, so every refusal can name its reason.
  const cur = (await db.execute(sql`
    select d.id, d.channel, d.event_seq, d.content_hash, d.payload_text, d.media_url, d.status,
           d.attempts, d.container_id, d.provider_post_id, d.retry_after, e.seq as source_seq
      from social_deliveries d
      left join primary_events e on e.seq = d.event_seq
     where d.id = ${id} and d.channel = ${channel}`)).rows?.[0];
  if (!cur) return { ok: false, reason: 'no such delivery' };

  const gate = readyToAttempt(cur);
  if (!gate.ready) return { ok: false, reason: gate.reason };

  // PROVENANCE. Everything published must trace to an ingested canonical event. Terminal rather than
  // retried: a row with no source event is not a transient failure, it is a row that must never be
  // sent. Checked before the claim so it cannot leave a row needing manual review.
  if (cur.event_seq == null || cur.source_seq == null) {
    const why = cur.event_seq == null ? 'no source event' : 'source event no longer exists';
    await db.execute(sql`update social_deliveries
       set status = ${DELIVERY_STATUS.FAILED}, failure_reason = ${'provenance: ' + why},
           failure_class = 'permanent', updated_at = now()
     where id = ${id}`);
    return { ok: false, reason: 'provenance: ' + why, permanent: true };
  }

  const claimed = (await db.execute(sql`
    update social_deliveries
       set status = ${DELIVERY_STATUS.PUBLISHING}, attempts = attempts + 1, updated_at = now()
     where id = ${id}
       and channel = ${channel}
       and status = ${DELIVERY_STATUS.PENDING}
       and provider_post_id is null
       and attempts < ${MAX_DELIVERY_ATTEMPTS}
    returning id, attempts, container_id, payload_text, media_url, event_seq, content_hash`)).rows?.[0];
  // No row means another worker got there first. Not an error, and deliberately not retried in this
  // pass: the winner is already publishing it.
  if (!claimed) return { ok: false, reason: 'claimed by another worker' };
  return { ok: true, row: { ...cur, ...claimed } };
}

/**
 * Release a row a human has confirmed was NOT published. The only way out of `publishing`, and
 * deliberately manual: automating it would reintroduce exactly the double-post this design prevents.
 */
export async function releaseStuckDelivery(channel, id) {
  const res = await db.execute(sql`
    update social_deliveries
       set status = ${DELIVERY_STATUS.PENDING}, retry_after = null, updated_at = now()
     where id = ${id} and channel = ${channel} and status = ${DELIVERY_STATUS.PUBLISHING}
       and provider_post_id is null
    returning id`);
  const row = (res.rows ?? res)?.[0];
  return row ? { released: true } : { released: false, reason: 'not stuck, or already posted' };
}

/** How many posts this channel has actually published in the last 24 hours. */
export async function dailyPostedCount(channel) {
  const row = (await db.execute(sql`select count(*)::int n from social_deliveries
    where channel = ${channel} and provider_post_id is not null
      and posted_at > now() - interval '24 hours'`)).rows?.[0];
  return Number(row?.n) || 0;
}

/**
 * Per-channel health, derived from the delivery rows themselves.
 *
 * NOTHING SENSITIVE LEAVES, and that is load-bearing rather than tidiness: failure_reason can carry a
 * provider's own error text, and Meta's "Malformed access token" class ECHOES THE SUBMITTED TOKEN back
 * inside it. So the text is counted and classified here and never returned. What comes out is counts,
 * timestamps and a failure CLASS.
 */
export async function channelHealth(channel) {
  await ensureSocialTables();
  const row = (await db.execute(sql`
    with last_ok as (
      select coalesce(max(posted_at), to_timestamp(0)) as t
        from social_deliveries where channel = ${channel} and provider_post_id is not null)
    select
      (select count(*)::int from social_deliveries where channel = ${channel})                       as total,
      (select count(*)::int from social_deliveries where channel = ${channel} and status = 'posted') as posted,
      (select count(*)::int from social_deliveries where channel = ${channel} and status = 'pending') as pending,
      (select count(*)::int from social_deliveries where channel = ${channel} and status = 'failed')  as failed,
      (select count(*)::int from social_deliveries where channel = ${channel} and status = 'publishing') as needs_review,
      (select count(*)::int from social_deliveries where channel = ${channel} and status = 'skipped') as skipped,
      (select max(updated_at) from social_deliveries where channel = ${channel})                     as last_attempt_at,
      (select t from last_ok)                                                                        as last_success_at,
      -- CONSECUTIVE failures: everything attempted since the last thing that worked.
      (select count(*)::int from social_deliveries d, last_ok
        where d.channel = ${channel} and d.failure_class is not null and d.updated_at > last_ok.t)   as consecutive_failures,
      (select count(*)::int from social_deliveries d, last_ok
        where d.channel = ${channel} and d.failure_class = 'auth' and d.updated_at > last_ok.t)      as auth_failures
    `)).rows?.[0] || {};

  // The classes seen recently, as a histogram. A class name is a fixed vocabulary word, never provider
  // text, so this is safe to return.
  const classes = (await db.execute(sql`select failure_class, count(*)::int n
    from social_deliveries where channel = ${channel} and failure_class is not null
      and updated_at > now() - interval '24 hours' group by 1 order by n desc`)).rows ?? [];

  const iso = (v) => (v && Number(new Date(v)) > 0 ? new Date(v).toISOString() : null);
  return {
    channel,
    total: Number(row.total) || 0,
    posted: Number(row.posted) || 0,
    pending: Number(row.pending) || 0,
    failed: Number(row.failed) || 0,
    skipped: Number(row.skipped) || 0,
    needsManualReview: Number(row.needs_review) || 0,
    lastAttemptAt: iso(row.last_attempt_at),
    lastSuccessAt: iso(row.last_success_at),
    consecutiveFailures: Number(row.consecutive_failures) || 0,
    authFailures: Number(row.auth_failures) || 0,
    credentialHealthy: (Number(row.auth_failures) || 0) === 0,
    recentFailureClasses: classes.map((c) => ({ class: c.failure_class, n: Number(c.n) })),
  };
}

/**
 * Store a scan's outcome beside the existing feed health rows, under a per-channel key, so each
 * destination is independently visible — which is the point: a broken Instagram must not make Facebook
 * look broken, and the only way to guarantee that is for them not to share a status row.
 *
 * `skipped` reasons are OUR OWN vocabulary (ineligible, too old, awaiting wording), never provider
 * text, so they are safe to store and read.
 */
export async function recordChannelScan(channel, { queued, examined, skipped = [] }) {
  const note = `examined ${examined}, queued ${queued}`
    + (skipped.length ? `, skipped: ${[...new Set(skipped)].slice(0, 6).join(' | ')}` : '');
  await db.execute(sql`
    insert into feed_state (feed_key, last_polled_at, last_success_at, last_status, events_seen, note)
    values (${`_${channel}`}, now(), now(), 200, ${examined}::int, ${note.slice(0, 300)})
    on conflict (feed_key) do update
       set last_polled_at = now(), last_success_at = now(), last_status = 200,
           events_seen = ${examined}::int, note = ${note.slice(0, 300)}`);
}

/** Record that a channel's scan THREW, so a swallowed error is still visible. Best effort. */
export async function recordChannelScanError(channel, message) {
  await db.execute(sql`
    insert into feed_state (feed_key, last_polled_at, last_status, consecutive_failures, note)
    values (${`_${channel}`}, now(), 500, 1, ${'ERROR: ' + String(message).slice(0, 280)})
    on conflict (feed_key) do update
       set last_polled_at = now(), last_status = 500,
           consecutive_failures = feed_state.consecutive_failures + 1,
           note = ${'ERROR: ' + String(message).slice(0, 280)}`);
}
