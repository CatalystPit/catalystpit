// EVIDENCE ALERT GENERATION — server-side, batched, durable, and harmless to run twice.
//
// ── ⚠️ WHY THIS IS A WORKER AND NOT A HOOK ──────────────────────────────────
//
// Evidence in this product is not produced in one place. An 8-K arrives through the filings
// ingest, a Form 4 through a different cron, a 13F through a quarterly sync, a congressional
// disclosure through another — and none of them produce canonical EVIDENCE, they produce rows that
// the Evidence Engine later resolves into evidence. Hooking "alert on new evidence" into each
// ingest would mean five call sites, five chances to forget one, and a second definition of what
// counts as evidence living in the ingests. One scheduled pass over the engine's own output is
// fewer moving parts and cannot drift from what the ticker page shows.
//
// ── ⚠️ HOW IT AVOIDS N+1 ────────────────────────────────────────────────────
//
// tickerEvidence() is a per-ticker call that issues ~16 round trips. Running it for every
// subscribed ticker directly would be exactly the N+1 the brief forbids. It is not run directly:
// loadBuildContext() — the same prefetch the Consensus board build uses — issues each family's
// query ONCE with `ticker = ANY($1)` and hands every resolver the rows its own query would have
// returned. The resolvers then run from memory. Round trips become (tickers / CHUNK) x families
// instead of tickers x 16, and the engine's logic is untouched because it is literally the same
// code reading the same rows.
//
// ── ⚠️ AND WHY RUNNING IT TWICE IS SAFE ─────────────────────────────────────
//
// Nothing here tracks "where did I get to". Delivery is idempotent in the database on
// (user_id, evidence_id), so a retry, an overlapping cron or a redeploy mid-run re-derives the
// same alerts and inserts nothing. That is deliberate: a cursor that advances past an item during
// a partial failure loses it silently, which is the one failure mode a person cannot detect.

import { db } from '../db';
import { sql } from 'drizzle-orm';
import { tickerEvidence } from '../evidence/resolve.js';
import { loadBuildContext, chunkTickers, CHUNK } from '../consensus/build-context.mjs';
import { alertsFor, LOOKBACK_DAYS } from './evidence-alerts.mjs';
import { activeSubscriptions, insertAlerts, pruneAlerts } from './evidence-alert-store.js';
import { resolveAccessByIds } from '../entitlements';

// The tiers Evidence Alerts are sold to. Named once, matching /api/evidence-alerts.
const PRO_TIERS = new Set(['pro', 'elite']);

/** Distinct tickers a single run will resolve. Beyond this the run reports the overflow. */
export const MAX_TICKERS_PER_RUN = 600;

/**
 * @param budgetMs stop starting new chunks past this, so a slow run ends cleanly inside
 *                 maxDuration instead of being killed mid-chunk with rows half-written.
 */
export async function runEvidenceAlerts({
  now = Date.now(), budgetMs = 45_000, deliver = insertAlerts,
  // ⚠️ INJECTED SO THE ENTITLEMENT FILTER CAN BE TESTED WITHOUT CLERK, exactly as `deliver` is
  // injected so delivery can be. A guard that can only be exercised against a live third party is a
  // guard that gets exercised once, by hand, and then trusted forever.
  resolveAccess = resolveAccessByIds,
} = {}) {
  const startedAt = Date.now();
  const allSubs = await activeSubscriptions();
  // ⚠️ THE SAME SHAPE AS A REAL RUN. This omitted `failed` and `ms`, and the cron interpolates both
  // into the heartbeat note — so every quarter-hour with no subscribers recorded
  // "0 tickers · 0 subs · 0 new · undefined failed · undefinedms", which reads as a broken job
  // rather than an idle one. It is currently the ONLY path taken in production, because
  // evidence_alert_subs is empty.
  if (!allSubs.length) {
    return { tickers: 0, subscriptions: 0, skippedNotPro: 0, unresolved: 0, overflow: 0, chunks: 0, created: 0, failed: 0, pruned: 0, ms: Date.now() - startedAt };
  }

  // ⚠️ ENTITLEMENT IS CHECKED HERE, AT DELIVERY, AND NOT ONLY WHERE THE SUBSCRIPTION WAS CREATED.
  //
  // A stored row records what somebody once asked for. It is not proof of what they are entitled to
  // today, and this worker treated it as proof: it read every enabled row and delivered. A subscriber
  // who cancelled Pro in March would have gone on receiving Pro alerts indefinitely, because the only
  // tier check in the system ran in the POST that created the row.
  //
  // ⚠️ THE ROW IS NOT DELETED, ONLY SKIPPED. Cancelling Pro is frequently temporary, and deleting the
  // preference would mean a returning subscriber silently receives nothing until they notice and
  // re-enable forty tickers by hand. Skipping is reversible: reactivate Pro and the next run delivers
  // again, from the subscriber's original enabled_at watermark rather than from the gap.
  //
  // ⚠️ AND enabled_at IS DELIBERATELY NOT MOVED ON REACTIVATION. The watermark means "I asked to hear
  // about things from this moment". Sliding it to the reactivation date would silently discard evidence
  // published during the lapse; leaving it is bounded anyway by the run's own lookback floor.
  const { access, unresolved } = await resolveAccess(allSubs.map((s) => s.userId));
  const subs = allSubs.filter((s) => PRO_TIERS.has(access.get(s.userId)?.tier));
  const skippedNotPro = allSubs.length - subs.length;
  if (!subs.length) {
    return { tickers: 0, subscriptions: 0, skippedNotPro, unresolved, overflow: 0, chunks: 0, created: 0, failed: 0, pruned: 0, ms: Date.now() - startedAt };
  }

  // Who is waiting on each ticker, and since when.
  const waiting = new Map();
  for (const s of subs) {
    if (!waiting.has(s.ticker)) waiting.set(s.ticker, []);
    waiting.get(s.ticker).push(s);
  }
  const all = [...waiting.keys()];
  const tickers = all.slice(0, MAX_TICKERS_PER_RUN);

  // ⚠️ THE FLOOR IS A CATCH-UP MARGIN, NOT A WINDOW. Each subscriber is still gated on their own
  // watermark below, so this can never widen what anyone receives — it only decides how long the
  // worker may be down before a legitimately new item stops being considered.
  const floor = new Date(now - LOOKBACK_DAYS * 86400000).toISOString();

  let created = 0, chunks = 0, failed = 0;
  for (const group of chunkTickers(tickers, CHUNK)) {
    if (Date.now() - startedAt > budgetMs) break;
    chunks++;
    let ctx = null;
    try {
      ctx = await loadBuildContext(db, sql, group, { now });
    } catch {
      // ⚠️ FAIL CLOSED. Without the prefetch the resolvers would fall back to per-ticker queries —
      // the N+1 this exists to prevent — so the chunk is skipped rather than resolved the slow way.
      failed += group.length;
      continue;
    }
    for (const ticker of group) {
      let evidence = null;
      try {
        const res = await tickerEvidence(ticker, { now, ctx });
        evidence = res?.evidence || [];
      } catch {
        // ⚠️ A RESOLUTION FAILURE CREATES NOTHING. The brief is explicit, and the alternative —
        // alerting from a partial resolve — would send a person an alert we cannot stand behind.
        failed++;
        continue;
      }
      const rows = [];
      for (const s of waiting.get(ticker) || []) {
        // ⚠️ THE WATERMARK IS THE LATER OF THE TWO. The subscriber's own enabled_at is the
        // point-in-time guarantee; the floor only bounds how far back this run looks. Taking the
        // later of them can only ever narrow what a person receives, never widen it.
        const subSince = Date.parse(s.since);
        if (!Number.isFinite(subSince)) continue;   // an unreadable watermark delivers nothing
        const since = new Date(Math.max(subSince, Date.parse(floor))).toISOString();
        for (const a of alertsFor(evidence, since, { now })) {
          rows.push({ ...a, userId: s.userId });
        }
      }
      if (rows.length) {
        try { created += await deliver(rows); } catch { failed++; }
      }
    }
  }

  let pruned = 0;
  try { pruned = await pruneAlerts(); } catch { /* retention is best-effort; delivery is not */ }

  return {
    tickers: tickers.length,
    subscriptions: subs.length,
    skippedNotPro,
    unresolved,
    overflow: all.length - tickers.length,
    chunks,
    created,
    failed,
    pruned,
    ms: Date.now() - startedAt,
  };
}
