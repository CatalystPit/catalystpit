// Anthropic usage accounting and availability state. Owns writes to anthropic_usage and to the
// `_anthropic` / `_rewrite_health` rows of feed_state.
//
// Nothing here may break a caller: every write is best-effort and swallows its own errors. Nothing
// here stores prompt or response content.

import { db } from './db';
import { sql } from 'drizzle-orm';
import { BLOCKING_CLASSES, describeFailure } from './anthropic-errors.mjs';

const MODEL_STATE_KEY = '_anthropic';
const HEALTH_KEY = '_rewrite_health';

/**
 * One row per API call.
 * @param {{feature:string, model?:string, ok:boolean, status?:number, errorClass?:string|null,
 *          usage?:{input_tokens?:number, output_tokens?:number, cache_read_tokens?:number, cache_write_tokens?:number}|null,
 *          items?:number|null, ms?:number|null}} r
 */
export async function recordUsage(r) {
  try {
    const u = r.usage || {};
    await db.execute(sql`
      insert into anthropic_usage (feature, model, ok, status, error_class, input_tokens, output_tokens,
                                   cache_read_tokens, cache_write_tokens, items, ms)
      values (${r.feature}, ${r.model ?? null}, ${!!r.ok}, ${r.status ?? null}, ${r.errorClass ?? null},
              ${u.input_tokens ?? null}, ${u.output_tokens ?? null}, ${u.cache_read_tokens ?? null},
              ${u.cache_write_tokens ?? null}, ${r.items ?? null}, ${r.ms == null ? null : Math.round(r.ms)})`);
  } catch (e) {
    console.error('[anthropic-usage] record failed:', String(e?.message || e).slice(0, 120));
  }
}

/**
 * Record whether the model was reachable, logging only on a CHANGE of state. A success is written
 * at most once a minute while healthy, so a busy minute does not become dozens of writes.
 * @param {{reachable:boolean, errorClass?:string|null, status?:number|null, message?:string|null, feature:string}} s
 *   reachable=false only for failures where the model never produced a response (credits, auth,
 *   rate limit, overload, server error, timeout, network). A billed but unusable response is
 *   reachable=true.
 */
export async function recordModelState(s) {
  try {
    if (s.reachable) {
      const res = await db.execute(sql`
        with prev as (select consecutive_failures, note from feed_state where feed_key = ${MODEL_STATE_KEY})
        insert into feed_state (feed_key, last_polled_at, last_success_at, last_status, consecutive_failures, events_seen, note)
        values (${MODEL_STATE_KEY}, now(), now(), 200, 0, 0, 'healthy')
        on conflict (feed_key) do update
           set last_polled_at = now(), last_success_at = now(), last_status = 200,
               consecutive_failures = 0, note = 'healthy'
         where feed_state.consecutive_failures > 0
            or feed_state.last_success_at is null
            or feed_state.last_success_at < now() - interval '60 seconds'
        returning (select consecutive_failures from prev) as prev_failures, (select note from prev) as prev_note`);
      const row = (res.rows ?? res)[0];
      if (row && Number(row.prev_failures) > 0) {
        console.log(`[anthropic] state ${String(row.prev_note || 'failing').split(':')[0]} -> healthy (via ${s.feature})`);
      }
      return;
    }
    const note = describeFailure(s.errorClass || 'unknown', s.status, s.message);
    const res = await db.execute(sql`
      with prev as (select consecutive_failures, note from feed_state where feed_key = ${MODEL_STATE_KEY})
      insert into feed_state (feed_key, last_polled_at, last_success_at, last_status, consecutive_failures, events_seen, note)
      values (${MODEL_STATE_KEY}, now(), null, ${s.status ?? 0}, 1, 0, ${note})
      on conflict (feed_key) do update
         set last_polled_at = now(), last_status = excluded.last_status,
             consecutive_failures = feed_state.consecutive_failures + 1, note = excluded.note
      returning (select consecutive_failures from prev) as prev_failures, (select note from prev) as prev_note`);
    const row = (res.rows ?? res)[0];
    const prevClass = row && Number(row.prev_failures) > 0 ? String(row.prev_note || '').split(/[:( ]/)[0] : 'healthy';
    if (prevClass !== (s.errorClass || 'unknown')) {
      console.error(`[anthropic] state ${prevClass} -> ${note} (via ${s.feature})`);
    }
  } catch (e) {
    console.error('[anthropic-usage] state write failed:', String(e?.message || e).slice(0, 120));
  }
}

/**
 * Whether callers should skip the model right now. After a BLOCKING failure (credits, auth,
 * permission) only one probe a minute is let through; after a transient one, one every 15 seconds.
 * Refused calls are not billed, so this is not about cost: it keeps an outage from turning into a
 * stream of doomed requests and log lines, while still noticing recovery within a minute.
 */
export async function modelCircuit() {
  try {
    const res = await db.execute(sql`
      select consecutive_failures, note, extract(epoch from (now() - last_polled_at)) as age_s
        from feed_state where feed_key = ${MODEL_STATE_KEY}`);
    const row = (res.rows ?? res)[0];
    if (!row || !(Number(row.consecutive_failures) > 0)) return { open: false };
    const cls = String(row.note || '').split(/[:( ]/)[0];
    const wait = BLOCKING_CLASSES.has(cls) ? 60 : 15;
    return Number(row.age_s) < wait ? { open: true, errorClass: cls, retryInSeconds: Math.ceil(wait - Number(row.age_s)) } : { open: false, probing: true, errorClass: cls };
  } catch {
    return { open: false };
  }
}

/**
 * INGESTION RUNNING + REWRITES STALLED, measured and persisted once a minute by the enrichment cron.
 * Persisted to feed_state `_rewrite_health` (last_status 200 healthy / 503 stalled) and logged only
 * when the verdict changes.
 * @param {() => any} eligibleWhereSql  the queue's own eligibility predicate over alias `p`
 */
export async function checkRewriteHealth(eligibleWhereSql) {
  const res = await db.execute(sql`
    select
      (select max(received_at) from primary_events where source_kind <> 'sec') as last_ingest,
      (select max(enriched_at) from primary_events
        where headline_status = 'original' and enriched_at > now() - interval '6 hours') as last_rewrite,
      (select count(*)::int from primary_events p where ${eligibleWhereSql('p')}) as due,
      (select min(coalesce(p.enrich_next_at, p.received_at)) from primary_events p where ${eligibleWhereSql('p')}) as oldest_due,
      (select note from feed_state where feed_key = ${MODEL_STATE_KEY}) as model_note,
      (select consecutive_failures from feed_state where feed_key = ${MODEL_STATE_KEY}) as model_failures,
      (select last_status from feed_state where feed_key = ${HEALTH_KEY}) as prev_status,
      now() as now`);
  const r = (res.rows ?? res)[0] || {};
  const now = new Date(r.now).getTime();
  const ago = (t) => (t ? Math.round((now - new Date(t).getTime()) / 1000) : null);
  const ingestAge = ago(r.last_ingest), rewriteAge = ago(r.last_rewrite), waitAge = ago(r.oldest_due);
  const ingesting = ingestAge != null && ingestAge <= 300;
  const backlogWaiting = (r.due || 0) > 0 && waitAge != null && waitAge > 300;
  const rewritesQuiet = rewriteAge == null || rewriteAge > 600;
  const stalled = ingesting && backlogWaiting && rewritesQuiet;
  const health = {
    verdict: stalled ? 'INGESTION RUNNING + REWRITES STALLED' : (ingesting ? 'ok' : 'ingestion idle'),
    stalled, ingesting, lastIngestSecondsAgo: ingestAge, lastRewriteSecondsAgo: rewriteAge,
    dueRewrites: r.due || 0, oldestDueWaitingSeconds: waitAge,
    model: Number(r.model_failures) > 0 ? r.model_note : 'healthy',
  };
  try {
    const status = stalled ? 503 : 200;
    await db.execute(sql`
      insert into feed_state (feed_key, last_polled_at, last_success_at, last_status, consecutive_failures, events_seen, note)
      values (${HEALTH_KEY}, now(), ${stalled ? null : sql`now()`}, ${status}, ${stalled ? 1 : 0}, 0, ${JSON.stringify(health).slice(0, 900)})
      on conflict (feed_key) do update
         set last_polled_at = now(),
             last_success_at = case when ${!stalled} then now() else feed_state.last_success_at end,
             last_status = excluded.last_status,
             consecutive_failures = case when ${stalled} then feed_state.consecutive_failures + 1 else 0 end,
             note = excluded.note`);
    if (r.prev_status != null && Number(r.prev_status) !== status) {
      (stalled ? console.error : console.log)(`[rewrite-health] ${Number(r.prev_status) === 503 ? 'STALLED' : 'ok'} -> ${health.verdict} ${JSON.stringify(health)}`);
    }
  } catch (e) {
    console.error('[rewrite-health] write failed:', String(e?.message || e).slice(0, 120));
  }
  return health;
}
