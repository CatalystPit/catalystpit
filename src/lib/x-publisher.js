// Catalyst Pit X auto-poster — persistence and the X API. All decisions live in x-autopost.mjs.
//
// CREDENTIALS ARE NEVER READ INTO A RETURN VALUE, A LOG LINE OR AN ERROR MESSAGE. They are read
// from the environment at the moment a request is signed and go nowhere else. Every failure path
// below reports a status code or a short reason, never a header, a signature or a key.

import { db } from './db';
import { sql } from 'drizzle-orm';
import { createHmac, randomBytes } from 'node:crypto';
import { buildCandidate, resolveMode, canPublish, cashtags } from './x-autopost.mjs';
import { backfillTickers } from './primary-events';

export const mode = () => resolveMode(process.env.X_AUTOPOST_MODE);

// ── candidate generation ─────────────────────────────────────────────────────
// Canonical events only, with every source code in their cluster, so Walter provenance is visible
// whether he was the first report or a later one that merged in.
//
// LEFT JOIN against x_post_candidates: an event that already has a candidate is never reconsidered,
// which is what stops a later merge producing a second post.
async function eligibleEvents(sinceHours, limit) {
  const res = await db.execute(sql`
    select e.seq, e.headline, e.summary, e.headline_status, e.importance, e.tickers, e.source_kind,
           e.source_type, e.category, e.source_headline, e.published_at,
           array(
             select distinct m.source from primary_events m
              where m.seq = e.seq or m.cluster_id = e.seq
           ) as sources
      from primary_events e
      left join x_post_candidates c on c.event_seq = e.seq
     where e.cluster_id is null
       and c.id is null
       and e.published_at > now() - (${sinceHours} || ' hours')::interval
       -- Cheap prefilter; the real decision is evaluate() in the pure module. It has to admit
       -- everything evaluate() would accept, so it reads HIGH-or-better, not CRITICAL: the policy
       -- is that every HIGH or CRITICAL canonical event is eligible, and a prefilter pinned to 3
       -- would have kept every HIGH event off the account no matter what the gate decided.
       and (e.importance >= 2 or exists (
             select 1 from primary_events w
              where (w.seq = e.seq or w.cluster_id = e.seq) and w.source = 'WALTERBLOOMBERG'))
     order by e.published_at desc
     limit ${Math.max(1, Math.min(500, limit))}`);
  return res.rows ?? res;
}

/**
 * Walk recent eligible events and persist a candidate for each. Never calls X.
 * In `off` this does nothing at all.
 */
export async function generateCandidates({ sinceHours = 24, limit = 200 } = {}) {
  const m = mode();
  const out = { mode: m, examined: 0, created: 0, suppressed: 0, waiting: 0, skipped: 0, blocked: {}, reasons: {} };
  if (m === 'off') return out;

  const rows = await eligibleEvents(sinceHours, limit);
  out.examined = rows.length;

  // TICKER RESOLUTION RUNS BEFORE FORMATTING, and it is the SAME resolver Pit Wire uses. An event
  // that reached this point with no symbol is almost always one the ingest pass saw before the
  // company index could place it; resolving here and writing the result back means the cashtag on
  // the post and the ticker on the Pit Wire row can never disagree, because they are one value.
  // Events that genuinely resolve to nothing — macro prints, geopolitics — stay untagged and post
  // without a cashtag, which is the correct shape for them.
  out.tickersResolved = await backfillTickers(rows);

  // What the account has already said, for the story guard. Read once; each new post is appended in
  // memory so a single pass cannot post the same story twice either.
  const priors = (await db.execute(sql`
    select post_text, story_key, post_facts, created_at,
           (select headline from primary_events e where e.seq = c.event_seq) as headline
      from x_post_candidates c
     where status in ('dry_run', 'pending', 'posted')
       and created_at > now() - interval '24 hours'
     order by created_at desc limit 200`)).rows ?? [];

  for (const ev of rows) {
    // No market-reaction reading is passed. The only change figure we hold is a daily screener
    // value that is hours to days old, and presenting that as the reaction to a breaking event
    // would be inventing a fact. One line now beats two lines that are wrong.
    const c = buildCandidate(ev, null, Date.now(), priors);

    // Not eligible at all, or still waiting for Catalyst wording: nothing is persisted, because the
    // event must be reconsidered on a later pass once the rewrite queue reaches it.
    if (!c.eligible) {
      out.waiting += c.blocked?.startsWith('awaiting') ? 1 : 0;
      out.skipped += c.blocked?.startsWith('awaiting') ? 0 : 1;
      out.blocked[c.blocked || 'unknown'] = (out.blocked[c.blocked || 'unknown'] || 0) + 1;
      continue;
    }

    // Eligible but NOT publishable. Recorded with its specific reason so every rejection is
    // auditable, and recorded against the same unique event_seq so it is judged once, not on a loop.
    if (!c.publishable) {
      out.suppressed++;
      out.reasons[c.suppressed] = (out.reasons[c.suppressed] || 0) + 1;
      await db.execute(sql`
        insert into x_post_candidates
          (event_seq, reason, post_text, char_count, shape, ticker, impact, mode, status, failure_reason)
        values (${ev.seq}, ${c.reason}, ${ev.headline ?? ''}, 0, 'suppressed',
                ${cashtags(ev)[0] ?? null}, ${ev.importance ?? null}, ${m},
                'suppressed', ${c.suppressed})
        on conflict (event_seq) do nothing`);
      continue;
    }

    // ON CONFLICT DO NOTHING on the unique event_seq: the duplicate guard is the schema's, so a
    // concurrent pass or a later merge cannot produce a second row for one event.
    const ins = await db.execute(sql`
      insert into x_post_candidates
        (event_seq, reason, post_text, char_count, shape, ticker, impact, mode, status, story_key, post_facts)
      values (${ev.seq}, ${c.reason}, ${c.text}, ${c.chars}, ${c.shape},
              ${cashtags(ev)[0] ?? null}, ${ev.importance ?? null}, ${m},
              ${m === 'dry_run' ? 'dry_run' : 'pending'}, ${c.storyKey ?? null}, ${c.facts ?? null})
      on conflict (event_seq) do nothing
      returning id`);
    if ((ins.rows ?? ins)?.length) {
      out.created++;
      // Appended so a later event in THIS SAME pass sees it as a prior post.
      priors.unshift({ headline: ev.headline, story_key: c.storyKey, post_facts: c.facts, created_at: new Date().toISOString() });
    }
  }
  return out;
}

// ── publishing a pass ────────────────────────────────────────────────────────
// At most this many posts per cron run, so a backlog can never empty itself onto the timeline in
// one burst. The story guard already limits repetition; this limits VOLUME.
export const MAX_PER_RUN = 3;

/**
 * Publish the candidates waiting in `pending`, oldest first. In any mode but `live` this returns
 * immediately without reading the database, so the dry run cannot become a live run by accident.
 */
export async function publishPending({ limit = MAX_PER_RUN, fetchImpl = fetch } = {}) {
  if (!canPublish(process.env.X_AUTOPOST_MODE)) return { sent: 0, mode: mode(), results: [] };
  const rows = (await db.execute(sql`
    select id from x_post_candidates
     where status = 'pending' and x_post_id is null
       and attempts < ${MAX_PUBLISH_ATTEMPTS}
       and created_at > now() - interval '2 hours'
     order by created_at asc limit ${Math.max(1, Math.min(MAX_PER_RUN, limit))}`)).rows ?? [];
  const results = [];
  for (const r of rows) results.push(await publishCandidate(r.id, { fetchImpl }));
  return { sent: results.filter((x) => x.sent).length, mode: mode(), results };
}

// ── inspection ───────────────────────────────────────────────────────────────
export async function recentCandidates(limit = 50) {
  const res = await db.execute(sql`
    select c.id, c.event_seq, c.reason, c.post_text, c.char_count, c.shape, c.ticker, c.impact,
           c.mode, c.status, c.attempts, c.x_post_id, c.failure_reason, c.created_at, c.posted_at,
           e.headline, e.published_at, e.source_count
      from x_post_candidates c
      left join primary_events e on e.seq = c.event_seq
     order by c.created_at desc
     limit ${Math.max(1, Math.min(200, limit))}`);
  return res.rows ?? res;
}

// ── OAuth 1.0a user context ──────────────────────────────────────────────────
// X's create-post endpoint requires user-context auth; OAuth 1.0a is the form that works with the
// four credentials already held. Signed here and nowhere else.
const enc = (s) => encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function authHeader(method, url) {
  const key = process.env.X_API_KEY;
  const secret = process.env.X_API_SECRET;
  const token = process.env.X_ACCESS_TOKEN;
  const tokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
  if (!key || !secret || !token || !tokenSecret) throw new Error('x credentials not configured');

  const params = {
    oauth_consumer_key: key,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: '1.0',
  };
  // JSON body parameters are NOT part of an OAuth 1.0a signature base string.
  const base = [method.toUpperCase(), enc(url),
    enc(Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&'))].join('&');
  const signature = createHmac('sha1', `${enc(secret)}&${enc(tokenSecret)}`).update(base).digest('base64');
  const all = { ...params, oauth_signature: signature };
  return 'OAuth ' + Object.keys(all).sort().map((k) => `${enc(k)}="${enc(all[k])}"`).join(', ');
}

const X_CREATE_POST = 'https://api.x.com/2/tweets';

// A 4xx that is about authentication or the content itself will fail identically forever, so it
// stops the candidate rather than being retried. Only transport and 5xx/429 are worth another go.
const isPermanent = (status) => status === 400 || status === 401 || status === 403 || status === 404;

/**
 * Publish ONE candidate. Guarded three ways: mode must be exactly 'live', the row is re-read inside
 * the call, and a row that is already posted returns its existing id without contacting X.
 */
export async function publishCandidate(id, { fetchImpl = fetch } = {}) {
  // The ONLY gate on contacting X, and it is checked before anything else in this function: no
  // database read, no request object, no credential access happens unless the mode is exactly live.
  if (!canPublish(process.env.X_AUTOPOST_MODE)) return { sent: false, reason: `mode is ${mode()}` };

  // Re-read immediately before publishing, so a concurrent pass or an earlier success is seen.
  const cur = (await db.execute(sql`
    select id, event_seq, post_text, status, attempts, x_post_id
      from x_post_candidates where id = ${id}`)).rows?.[0];
  if (!cur) return { sent: false, reason: 'no such candidate' };
  if (cur.x_post_id) return { sent: false, reason: 'already posted', xPostId: cur.x_post_id };
  if (cur.status === 'failed') return { sent: false, reason: 'previously failed permanently' };
  if (Number(cur.attempts) >= MAX_PUBLISH_ATTEMPTS) return { sent: false, reason: 'attempts exhausted' };

  await db.execute(sql`update x_post_candidates
     set attempts = attempts + 1, updated_at = now() where id = ${id}`);

  try {
    const r = await fetchImpl(X_CREATE_POST, {
      method: 'POST',
      headers: { Authorization: authHeader('POST', X_CREATE_POST), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: cur.post_text }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.ok && body?.data?.id) {
      await db.execute(sql`update x_post_candidates
         set status = 'posted', x_post_id = ${String(body.data.id)}, failure_reason = null,
             posted_at = now(), updated_at = now() where id = ${id}`);
      return { sent: true, xPostId: String(body.data.id) };
    }
    // Status code and X's own short title only. No headers, no request, no credentials.
    const why = `HTTP ${r.status}${body?.title ? ` ${String(body.title).slice(0, 60)}` : ''}`;
    await db.execute(sql`update x_post_candidates
       set status = ${isPermanent(r.status) ? 'failed' : 'pending'},
           failure_reason = ${why}, updated_at = now() where id = ${id}`);
    return { sent: false, reason: why, permanent: isPermanent(r.status) };
  } catch (e) {
    const why = String(e?.message || e).slice(0, 80);
    await db.execute(sql`update x_post_candidates
       set failure_reason = ${why}, updated_at = now() where id = ${id}`);
    return { sent: false, reason: why };
  }
}

export const MAX_PUBLISH_ATTEMPTS = 3;
