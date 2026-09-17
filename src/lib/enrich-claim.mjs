// The rewrite queue's SQL, built in one place so production and scripts/verify-enrich-claim.mjs run
// the identical statement. No database handle here: callers execute what these return.
//
// ATOMIC CLAIM. Selecting pending rows and later writing the result used to be two unrelated
// statements, so the ingest sweep's inline worker, the enrichment cron and an overlapping sweep all
// selected — and paid Anthropic to rewrite — the same rows at the same time. Claiming is now one
// UPDATE over a FOR UPDATE SKIP LOCKED subselect: a row can be claimed by exactly one worker, a
// second worker skips it, and the claim is stamped with a token that the result write must match.
// A claim older than CLAIM_STALE_SECONDS is treated as abandoned, so a crashed worker strands
// nothing for longer than that.

import { sql } from 'drizzle-orm';
import { TRUSTED_SOURCES } from './trusted-sources.mjs';
import { FB_REWORDED_SOURCES } from './facebook-post.mjs';
import {
  IMMEDIATE_MIN_IMPORTANCE, HIGH_IMPORTANCE, ATTEMPTS_TRUSTED, ATTEMPTS_HIGH, ATTEMPTS_ORDINARY,
  CLAIM_STALE_SECONDS, FRESH_MINUTES,
} from './enrich-policy.mjs';

// Array LITERALS with explicit casts, as everywhere else in the pipeline: a JS array bound straight
// into any() leaves the parameter untyped and the statement fails to parse.
const TRUSTED = `{${[...TRUSTED_SOURCES].join(',')}}`;
const REWORDED = `{${[...FB_REWORDED_SOURCES].join(',')}}`;

// Whether the row or its cluster carries a trusted source.
const clusterTrusted = (alias) => sql`(${sql.raw(alias)}.source = any(${TRUSTED}::text[])
  or exists (select 1 from primary_events tm
              where tm.cluster_id = ${sql.raw(alias)}.seq and tm.source = any(${TRUSTED}::text[])))`;

/**
 * Rows that may be sent to the model now, ignoring claims. Shared by the claim and by the health
 * check, so "stalled" is measured against exactly what a worker would pick up.
 */
export function eligibleWhere(alias = 'p') {
  const a = sql.raw(alias);
  return sql`${a}.headline_status = 'rewrite_pending'
    and ${a}.source_kind <> 'sec'
    and (${a}.enrich_next_at is null or ${a}.enrich_next_at <= now())
    -- DUPLICATES. A member folded into a canonical event is not rewritten: the event displays the
    -- canonical row, and its wording comes from rewriting that row. The one exception is a TRUSTED
    -- member whose head still lacks Catalyst wording, because adoptClusterWording can lift that
    -- member's sentence onto the event — the case where a terse wire line became canonical seconds
    -- before the trusted flash that carried the figures.
    and (${a}.cluster_id is null
         or (${a}.source = any(${TRUSTED}::text[])
             and exists (select 1 from primary_events hd
                          where hd.seq = ${a}.cluster_id and hd.headline_status not in ('original', 'composed'))))
    -- TIERS: see enrich-policy.mjs. Importance 0 waits unless something makes it important.
    and (${a}.importance >= ${IMMEDIATE_MIN_IMPORTANCE}::smallint
         or ${a}.source = any(${REWORDED}::text[])
         or ${clusterTrusted(alias)})
    and ${a}.enrich_attempts < (case when ${clusterTrusted(alias)} then ${ATTEMPTS_TRUSTED}::int
                                     when ${a}.importance >= ${HIGH_IMPORTANCE}::smallint then ${ATTEMPTS_HIGH}::int
                                     else ${ATTEMPTS_ORDINARY}::int end)`;
}

/**
 * Claim up to `limit` rows for one worker.
 * @param {{limit:number, token:string, scope?:'fresh'|'all'}} o
 *   fresh — only rows captured in the last FRESH_MINUTES (the ingest sweep's inline worker)
 */
export function claimSql({ limit, token, scope = 'all' }) {
  const n = Math.max(1, Math.min(60, Number(limit) || 1));
  return sql`
    with picked as (
      select p.seq
        from primary_events p
       where ${eligibleWhere('p')}
         and (p.enrich_claimed_at is null
              or p.enrich_claimed_at < now() - (${CLAIM_STALE_SECONDS} || ' seconds')::interval)
         and (${scope !== 'fresh'}::boolean
              or p.received_at > now() - (${FRESH_MINUTES} || ' minutes')::interval)
       -- Trusted first, then the most important, then newest: a breaking flash goes before backlog.
       order by (p.source = any(${TRUSTED}::text[])) desc, p.importance desc, p.seq desc
       limit ${n}
       for update of p skip locked)
    update primary_events u
       set enrich_claimed_at = now(),
           enrich_claim_token = ${token}
      from picked
     where u.seq = picked.seq
    returning u.seq, u.source, u.source_name, u.source_type, u.headline, u.source_headline, u.summary,
              u.published_at, u.original_url, u.tickers, u.entity, u.fact_sig, u.category, u.importance,
              u.enrich_attempts, u.cluster_id, u.headline_status, u.received_at,
              ${clusterTrusted('u')} as cluster_trusted`;
}

/** Give back every row this worker still holds (model unreachable, or nothing to apply). */
export function releaseSql(token) {
  return sql`
    update primary_events
       set enrich_claimed_at = null, enrich_claim_token = null
     where enrich_claim_token = ${token}
    returning seq`;
}

/**
 * Due rows for the backlog worker: how many, and whether any must not wait for a fuller batch.
 * `urgent` = a due HIGH-importance or trusted row, or anything already waiting past `maxWaitSeconds`.
 */
export function backlogSql({ maxWaitSeconds }) {
  return sql`
    select count(*)::int as n,
           coalesce(bool_or(p.importance >= ${HIGH_IMPORTANCE}::smallint or ${clusterTrusted('p')}
                            or coalesce(p.enrich_next_at, p.received_at) < now() - (${maxWaitSeconds} || ' seconds')::interval), false) as urgent
      from primary_events p
     where ${eligibleWhere('p')}
       and (p.enrich_claimed_at is null
            or p.enrich_claimed_at < now() - (${CLAIM_STALE_SECONDS} || ' seconds')::interval)`;
}
