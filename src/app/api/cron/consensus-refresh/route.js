import { db } from '../../../../lib/db';
import { sql } from 'drizzle-orm';
import { drainDirty, rebuildBoardExclusive, readPublishedBoard } from '../../../../lib/consensus/refresh';
import { MATERIALIZATION_VERSION } from '../../../../lib/consensus/materialization.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;

// THE DRAIN — targeted consensus refresh.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// The board used to be kept current by one 30-minute cron and nothing else, so a Form 4 landing at
// 12:01 was invisible until 12:30, and a methodology deployed at 12:01 served the previous
// methodology's rows until 12:30. Both are fixed here, and they are fixed differently:
//
//   FRESHNESS   evidence ingestion marks tickers dirty; this drains them.
//   CORRECTNESS the board key carries the deployed methodology, so when there is no board under
//               the current version this rebuilds it — which is what makes a deployment
//               self-healing within a minute instead of within the cron interval.
//
// ── WHY THIS IS CHEAP ───────────────────────────────────────────────────────
//
// Almost every run does nothing: no dirty tickers and a current board is two KV reads and a 200.
// When there is work, only the dirty tickers are recomputed and the rest of the index is rebuilt
// from already-materialized rows. A full rebuild happens only when a burst is large enough that
// rebuilding is genuinely cheaper than recomputing the tickers one at a time.
//
// It is safe to miss runs: the reconciliation cron (/api/cron/consensus-board, every 30 minutes)
// recomputes everything from scratch and repairs anything this missed.
//
// ── ⚠️ WHY THIS NO LONGER RUNS EVERY MINUTE ─────────────────────────────────
//
// The paragraph above used to say "safe to run every minute", and that was true while a targeted
// drain only recomputed the dirty tickers. It stopped being true when rebuildBoard began recomputing
// every candidate on every call (see the `void reuseTickers` note there — reusing a cached row risks
// publishing a setup classified against stale evidence, so it was removed deliberately). From that
// point a "targeted" drain of a dozen tickers was a full board build, and a full build does not
// reliably finish inside Vercel's 300s ceiling under production load.
//
// The failure mode that produced was not a slow board — it was a stopped one. The run that won the
// lock was killed at 300s, so the `finally` that releases the lock never executed; the lock then
// sat for the remainder of its own 300s TTL, and the next minute's invocation claimed it the instant
// it expired and was killed in turn. Measured in production: a 504 every ~5 minutes forever, the
// lock held in 56 of 56 samples, and the board frozen for hours.
//
// ⚠️ THE MINUTES ARE CHOSEN, NOT ROUNDED. :04,:14,…,:54 — never :00 or :30. Even in the worst case
// where a drain claims the lock and is killed, its leaked lock expires 300s later (:09, :19, …
// :59), so the reconciliation pass at :00 and :30 always finds the lock free. A plain */10 would
// put a drain on those exact minutes and could starve the reconcile indefinitely, which is the
// defect being repaired here rather than a theoretical one.

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  const url = new URL(request.url);
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();
  const reason = url.searchParams.get('reason') || 'cron';
  try {
    // 1. IS THERE A BOARD FOR THE DEPLOYED METHODOLOGY AT ALL?
    //
    // This is the deployment trigger. `readPublishedBoard` returns 'stale-methodology' when the
    // only board available was built by other code, and 'degraded' when there is none — either way
    // the answer is the same: build one now, and do not touch the existing board until the new one
    // has validated.
    const { status } = await readPublishedBoard();
    if (status === 'stale-methodology' || status === 'degraded') {
      const r = await rebuildBoardExclusive(db, sql, { reason: `version:${reason}` });
      return Response.json({
        ok: true, action: 'version-rebuild', trigger: status,
        published: r.published, why: r.reason,
        version: MATERIALIZATION_VERSION, rows: r.payload?.rows?.length ?? 0, ms: Date.now() - t0,
      });
    }

    // 2. DRAIN WHATEVER EVIDENCE INGESTION MARKED.
    const r = await drainDirty(db, sql);
    return Response.json({
      ok: true, action: 'drain', strategy: r.strategy, drained: r.drained,
      tickers: r.tickers?.slice(0, 40) ?? [], published: r.published, why: r.reason,
      reused: r.payload?.reused ?? null,
      version: MATERIALIZATION_VERSION, rows: r.payload?.rows?.length ?? null, ms: Date.now() - t0,
    });
  } catch (e) {
    // A failed drain leaves the dirty set intact and the previous board untouched. The next run,
    // or the reconciliation cron, picks it up.
    console.error('[consensus-refresh] failed', e);
    return Response.json({ ok: false, error: 'drain_failed', ms: Date.now() - t0 }, { status: 500 });
  }
}
