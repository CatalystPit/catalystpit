import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { instagramCaption, instagramEligibility, instagramConfig, instagramReadiness,
  IG_CATALYST_WORDING } from './instagram-post.mjs';
import { redactCredential } from '../facebook-post.mjs';
import { resolvePageToken } from '../facebook-page-token.mjs';
import { buildInstagramCard } from './social-card.jsx';
import { DELIVERY_STATUS, FAILURE_CLASS, PHASE, MAX_DELIVERY_ATTEMPTS, MAX_PER_RUN,
  DAILY_POST_LIMIT, MAX_AGE_MINUTES, classifyProviderFailure, backoffMs, providerErrorText } from './social-delivery.mjs';
import { ensureSocialTables, claimDelivery, recordChannelScan, channelActivation,
  queueDelivery, dailyPostedCount } from './social-store.js';

// INSTAGRAM PUBLISHING. The I/O half; every editorial decision is in instagram-post.mjs, which is pure.
//
// `server-only`, for the same build-time reason as the other publishers.
//
// THREE CALLS, NOT TWO. Instagram's container has to be POLLED: the Graph API accepts a media container
// and then fetches the image asynchronously from the URL we gave it, so the container is not
// publishable until its status_code reads FINISHED. Publishing an IN_PROGRESS container fails, and
// treating that failure as "the post was rejected" would destroy a perfectly good post — so the status
// check is a step of the protocol rather than an optimisation.
//
// IT SHARES THE FACEBOOK CREDENTIAL, DELIBERATELY AND ONLY BECAUSE META'S MODEL SAYS SO. An Instagram
// professional account hangs off a Facebook Page in the same Business portfolio and is addressed
// through graph.facebook.com with that Page's token. So resolvePageToken() — the System User to Page
// token exchange already proven on the Facebook path — is reused as-is. Threads is the opposite case
// and shares nothing; see its publisher.
//
// NO CREDENTIAL IS EVER RETURNED, LOGGED OR RENDERED. Provider messages pass through redactCredential
// before storage because Meta echoes submitted tokens inside its "Malformed access token" class.

const CHANNEL = 'instagram';
const TIMEOUT_MS = 20_000;
// Meta fetches the image itself, so the container can take a few seconds to become publishable. Polled
// a bounded number of times within one cron tick; an unfinished container is left for the next tick
// rather than waited on, because holding a serverless function open is the more expensive mistake.
const STATUS_POLLS = 3;
const STATUS_POLL_WAIT_MS = 2_000;

export function instagramStatus() {
  const cfg = instagramConfig();
  return {
    channel: CHANNEL,
    ...instagramReadiness(cfg),
    // Whether a card can be produced at all. Reported separately from the credential because they are
    // different owner actions with different fixes.
    hasMediaHost: !!process.env.BLOB_READ_WRITE_TOKEN,
    // Everything this channel needs, as one answer: the account, a usable credential, the Page id when
    // the credential has to be exchanged, and somewhere to host the card.
    publishable: !!(cfg.igUserId && (cfg.systemUserToken || cfg.pageToken)
      && (!cfg.systemUserToken || cfg.pageId) && process.env.BLOB_READ_WRITE_TOKEN),
  };
}

/**
 * Find canonical events that may go to Instagram, render a card for each, and record a delivery row.
 *
 * ⚠️ THE CARD IS RENDERED AT QUEUE TIME, NOT AT PUBLISH TIME, and that ordering is deliberate: a
 * delivery row exists only once there is a real, hosted, validated JPEG behind it. The alternative —
 * queue now, render later — produces rows that can never publish and a failure class that looks like
 * Instagram rejecting us when in fact we never had an image.
 *
 * Rendering is bounded per run because it is the expensive step (rasterise, encode, upload).
 */
export async function queueInstagram({ limit = 6 } = {}) {
  await ensureSocialTables();

  const cfg = instagramConfig();
  // No point rendering cards for a channel that cannot publish them. Reported, not thrown.
  if (!cfg.igUserId || !(cfg.systemUserToken || cfg.pageToken)
      || (cfg.systemUserToken && !cfg.pageId)) {
    const out = { channel: CHANNEL, queued: 0, examined: 0, skipped: ['instagram not configured'] };
    await recordChannelScan(CHANNEL, out).catch(() => {});
    return out;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    const out = { channel: CHANNEL, queued: 0, examined: 0, skipped: ['media host not configured'] };
    await recordChannelScan(CHANNEL, out).catch(() => {});
    return out;
  }

  // The watermark, read and written before any event is considered — see social-store.js. First
  // activation queues nothing by construction.
  const activatedAt = await channelActivation(CHANNEL);

  const wording = [...IG_CATALYST_WORDING].join(',');
  const rows = (await db.execute(sql`
    select e.seq, e.source, e.source_uid, e.headline, e.headline_status, e.tickers, e.content_hash,
           e.importance, e.received_at
      from primary_events e
      left join social_deliveries d on d.event_seq = e.seq and d.channel = ${CHANNEL}
     where d.id is null
       and e.cluster_id is null
       and e.headline_status = any(${`{${wording}}`}::text[])
       -- ⚠️ A HIGHER BAR THAN THE OTHER CHANNELS, ON PURPOSE. Instagram is a slow feed where each post
       -- is a designed card, and the account's own standard is the constraint rather than the API's
       -- rate limit. CRITICAL only, so the channel carries the events that justify a graphic instead of
       -- every HIGH headline the wire produces.
       and coalesce(e.importance, 0) >= 3
       and e.received_at > ${activatedAt}
       and e.received_at > now() - (${MAX_AGE_MINUTES} || ' minutes')::interval
     order by e.received_at desc
     limit ${Math.max(1, Math.min(20, limit))}`)).rows ?? [];

  let queued = 0;
  const skipped = [];
  for (const ev of rows) {
    // The text gates FIRST, before any rendering: if the caption is not publishable there is no reason
    // to spend a rasterise and an upload discovering it. `image: null` makes the pure check return
    // 'awaiting card render', which is the one reason we expect and step past here.
    const dry = instagramEligibility(ev, { isNew: true, isCanonical: true, qualifies: true, image: null });
    if (!dry.eligible && dry.reason !== 'awaiting card render') { skipped.push(dry.reason); continue; }

    const card = await buildInstagramCard({ headline: ev.headline, tickers: ev.tickers || [], eventSeq: ev.seq });
    if (!card.ok) { skipped.push(card.reason); continue; }

    // The full gate, now with the real card, so Meta's media rules are enforced by the same pure
    // function that the tests exercise — not by trusting the renderer's own output.
    const decision = instagramEligibility(ev, { isNew: true, isCanonical: true, qualifies: true, image: card.image });
    if (!decision.eligible) { skipped.push(decision.reason); continue; }

    const res = await queueDelivery({
      channel: CHANNEL, eventSeq: ev.seq, contentHash: ev.content_hash,
      sourceUid: ev.source_uid ?? null, payloadText: instagramCaption(ev), mediaUrl: card.image.url,
    });
    if (res.queued) queued += 1; else skipped.push(res.reason);
  }
  const out = { channel: CHANNEL, queued, examined: rows.length, skipped: [...new Set(skipped)] };
  await recordChannelScan(CHANNEL, out).catch(() => {});
  return out;
}

/** One Graph call, with a timeout and a credential that travels in the body. */
async function graphCall(cfg, token, path, body, fetchImpl, method = 'POST') {
  const url = `https://graph.facebook.com/${cfg.graphVersion}/${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const init = method === 'GET'
      // A GET cannot carry a body, so this one credential has to travel in a header rather than a
      // query string — which is still not a URL, and so still not in a proxy log.
      ? { method, headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal }
      : { method, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, access_token: token }), signal: ctl.signal };
    const r = await fetchImpl(url, init);
    const json = await r.json().catch(() => ({}));
    return { httpOk: r.ok, status: r.status, json };
  } catch (e) {
    const timeout = e?.name === 'AbortError';
    return { httpOk: false, status: null, timeout, transport: !timeout,
      message: redactCredential(String(e?.message || e)).slice(0, 100) };
  } finally { clearTimeout(timer); }
}

const fail = (res, phase) => {
  const err = res.json?.error || {};
  const cls = classifyProviderFailure({ status: res.status, errorCode: err.code, phase,
    transport: res.transport, timeout: res.timeout });
  const why = res.status == null
    ? `${phase}: ${res.timeout ? 'timeout' : 'transport'}: ${res.message || ''}`.slice(0, 200)
    : providerErrorText({ status: res.status, errorCode: err.code ?? null,
        subcode: err.error_subcode ?? null, message: err.message || '', phase }, redactCredential);
  return { cls, why };
};

/**
 * Publish one queued delivery.
 *
 * The same four no-duplicate cases the Threads publisher documents apply here, with one addition
 * specific to Instagram: the container is created from the IMAGE URL and the CAPTION, and publishing
 * names only the container. So a restart between the two steps resumes with the same container and
 * cannot produce a second post, and a re-render cannot either, because the container id is what is
 * persisted and what is published.
 */
export async function publishInstagramDelivery(id, { fetchImpl = fetch } = {}) {
  const cfg = instagramConfig();
  if (!cfg.enabled) return { sent: false, reason: 'INSTAGRAM_AUTO_POST_ENABLED is not true' };
  if (!cfg.igUserId || !(cfg.systemUserToken || cfg.pageToken)) {
    return { sent: false, reason: 'instagram account id or token not configured' };
  }

  const claim = await claimDelivery(CHANNEL, id);
  if (!claim.ok) return { sent: false, reason: claim.reason };
  const row = claim.row;
  if (!row.media_url) {
    // Cannot happen through queueInstagram, which refuses to write a row without a hosted card. Kept
    // as a terminal refusal rather than an assertion so a future path into this table cannot turn it
    // into an Instagram API error that reads as the provider's fault.
    await db.execute(sql`update social_deliveries
       set status = ${DELIVERY_STATUS.FAILED}, failure_reason = 'no media for an image-only channel',
           failure_class = 'permanent', updated_at = now() where id = ${id}`);
    return { sent: false, reason: 'no media for an image-only channel', permanent: true };
  }

  // ⚠️ THE TOKEN IS RESOLVED AGAINST THE PAGE, THEN USED AGAINST THE INSTAGRAM ACCOUNT. These are two
  // different ids and the distinction is easy to lose: publishing targets {ig-user-id}/media, but the
  // CREDENTIAL that may do so is the linked Page's access token, obtained by reading the PAGE's
  // access_token field. Addressing the exchange to the Instagram id instead returns an error about a
  // missing field, which reads like a permissions problem and is not one.
  if (cfg.systemUserToken && !cfg.pageId) {
    const cls = { class: FAILURE_CLASS.AUTH, retryable: true, permanent: false, spendsAttempt: false };
    const why = 'FACEBOOK_PAGE_ID is required to exchange the System User token for a Page token';
    await settleFailure(id, row, cls, why);
    return { sent: false, reason: why, failureClass: FAILURE_CLASS.AUTH };
  }
  // A failure here is always a credential failure, which routes into the hold-the-post path rather than
  // the destroy-the-post path.
  const derived = await resolvePageToken({ ...cfg, token: cfg.pageToken, pageId: cfg.pageId }, fetchImpl);
  if (!derived.ok) {
    const cls = { class: FAILURE_CLASS.AUTH, retryable: true, permanent: false, spendsAttempt: false };
    await settleFailure(id, row, cls, String(derived.reason).slice(0, 300));
    return { sent: false, reason: derived.reason, failureClass: FAILURE_CLASS.AUTH };
  }
  const token = derived.token;

  // ── step 1: the container. Publishes nothing, so retryable in every failure mode. ──
  let containerId = row.container_id || null;
  if (!containerId) {
    const res = await graphCall(cfg, token, `${cfg.igUserId}/media`,
      { image_url: row.media_url, caption: row.payload_text }, fetchImpl);
    if (res.httpOk && res.json?.id) {
      containerId = String(res.json.id);
      await db.execute(sql`update social_deliveries
         set container_id = ${containerId}, container_at = now(), updated_at = now() where id = ${id}`);
    } else {
      const { cls, why } = fail(res, PHASE.CONTAINER);
      await settleFailure(id, row, cls, why);
      return { sent: false, reason: why, failureClass: cls.class, permanent: cls.permanent };
    }
  }

  // ── step 2: wait for Meta to have fetched the image. ──
  let state = null;
  for (let i = 0; i < STATUS_POLLS; i++) {
    const res = await graphCall(cfg, token, `${containerId}?fields=status_code`, null, fetchImpl, 'GET');
    state = res.httpOk ? String(res.json?.status_code || '') : null;
    if (state === 'FINISHED') break;
    if (state === 'ERROR' || state === 'EXPIRED') {
      // Meta could not use the image. That is terminal FOR THIS CONTAINER, and the commonest cause by
      // far is that it could not fetch the URL — so the reason says so, because "media error" alone
      // sends an operator looking at the wrong thing.
      const why = `container ${state}: Instagram could not process the card (most often the image URL`
        + ' was not reachable from Meta, or was not a JPEG within the published limits)';
      await settleFailure(id, row, { class: FAILURE_CLASS.PERMANENT, permanent: true, spendsAttempt: true }, why);
      return { sent: false, reason: why, failureClass: FAILURE_CLASS.PERMANENT, permanent: true };
    }
    if (i < STATUS_POLLS - 1) await new Promise((r) => setTimeout(r, STATUS_POLL_WAIT_MS));
  }
  if (state !== 'FINISHED') {
    // NOT A FAILURE AND NOT AMBIGUOUS: nothing has been published, and the container is valid for 24
    // hours. Released back to `pending` with the container id kept, so the next tick resumes at step 3
    // rather than rendering and uploading a second card.
    const why = `container not ready (${state || 'unknown'}) — resuming next pass`;
    await db.execute(sql`update social_deliveries
       set status = ${DELIVERY_STATUS.PENDING}, attempts = greatest(attempts - 1, 0),
           failure_reason = ${why}, failure_class = ${FAILURE_CLASS.TRANSIENT},
           retry_after = ${new Date(Date.now() + 60_000)}, updated_at = now()
     where id = ${id}`);
    return { sent: false, reason: why, failureClass: FAILURE_CLASS.TRANSIENT, resuming: true };
  }

  // ── step 3: publish the container. The only call that can create a post. ──
  const res = await graphCall(cfg, token, `${cfg.igUserId}/media_publish`,
    { creation_id: containerId }, fetchImpl);
  if (res.httpOk && res.json?.id) {
    await db.execute(sql`update social_deliveries
       set status = ${DELIVERY_STATUS.POSTED}, provider_post_id = ${String(res.json.id)},
           failure_reason = null, failure_class = null, retry_after = null,
           posted_at = now(), updated_at = now() where id = ${id}`);
    return { sent: true, providerPostId: String(res.json.id) };
  }
  const { cls, why } = fail(res, PHASE.PUBLISH);
  if (cls.needsManualReview) {
    await db.execute(sql`update social_deliveries
       set failure_reason = ${why}, failure_class = ${cls.class}, updated_at = now() where id = ${id}`);
    return { sent: false, reason: why, failureClass: cls.class, needsManualReview: true };
  }
  await settleFailure(id, row, cls, why);
  return { sent: false, reason: why, failureClass: cls.class, permanent: cls.permanent };
}

/** See the Threads publisher: the attempt is taken at claim time and refunded only for auth and rate. */
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
export async function publishPendingInstagram({ limit = MAX_PER_RUN.instagram, fetchImpl = fetch } = {}) {
  const cfg = instagramConfig();
  if (!cfg.enabled) return { channel: CHANNEL, sent: 0, enabled: false, results: [] };
  if (!cfg.igUserId || !(cfg.systemUserToken || cfg.pageToken)) {
    return { channel: CHANNEL, sent: 0, enabled: true, configured: false, results: [] };
  }
  await ensureSocialTables();

  const postedToday = await dailyPostedCount(CHANNEL);
  if (postedToday >= DAILY_POST_LIMIT.instagram) {
    return { channel: CHANNEL, sent: 0, enabled: true, dailyLimitReached: true, postedToday, results: [] };
  }
  const room = Math.max(0, Math.min(limit, DAILY_POST_LIMIT.instagram - postedToday));

  const rows = (await db.execute(sql`
    select id from social_deliveries
     where channel = ${CHANNEL}
       and status = ${DELIVERY_STATUS.PENDING}
       and provider_post_id is null
       and attempts < ${MAX_DELIVERY_ATTEMPTS}
       and (retry_after is null or retry_after <= now())
       -- A LONGER WINDOW THAN THE SCAN, and only here. A container already exists for these rows and is
       -- valid for 24 hours; dropping a row at 30 minutes would throw away a rendered, uploaded and
       -- Meta-accepted card because the image took two polls to become ready. The SCAN's 30-minute
       -- bound is what keeps the content fresh; this bound only governs finishing work already begun.
       and created_at > now() - interval '2 hours'
     order by created_at asc limit ${room}`)).rows ?? [];

  const results = [];
  for (const r of rows) results.push({ id: r.id, ...(await publishInstagramDelivery(r.id, { fetchImpl })) });
  const authFailures = results.filter((x) => x.failureClass === FAILURE_CLASS.AUTH).length;
  if (authFailures) {
    console.error(`[instagram] CREDENTIAL FAILURE on ${authFailures} of ${results.length} deliveries`
      + ' — the Page token is expired, revoked, or lacks instagram_content_publish /'
      + ' instagram_basic. Posts are HELD, not lost.');
  }
  return { channel: CHANNEL, sent: results.filter((x) => x.sent).length, enabled: true,
    configured: true, authFailures, postedToday, results };
}
