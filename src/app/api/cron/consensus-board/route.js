import { db } from '../../../../lib/db';
import { sql } from 'drizzle-orm';
import { EVALUATE_LIMIT, BUILD_DEADLINE_MS } from '../../../../lib/consensus/setup-board.js';
import { rebuildBoardExclusive } from '../../../../lib/consensus/refresh';
import { MATERIALIZATION_VERSION } from '../../../../lib/consensus/materialization.mjs';
import { recordJobRun } from '../../../../lib/job-heartbeat';

export const runtime = 'nodejs';
export const maxDuration = 300;
// ⚠️ 300s IS THE PLAN CEILING. A BUILD THAT OVERRUNS IS KILLED, NOT REJECTED.
//
// This route has now run out of time twice, and the second time the diagnosis from the first was
// what made it hard to see.
//
// ── WHAT THE FIRST FIX SAID, AND WHY IT IS NO LONGER TRUE ───────────────────
//
// It concluded the build was CPU-BOUND, on the evidence that raising the resolve fan-out from 4 to
// 16 moved the wall clock under 3% (173.1s -> 168.8s). Vercel allocates CPU in proportion to
// configured memory, so the function was pinned to 3009MB in vercel.json for roughly 3x the CPU.
// That was a correct reading of the build AS IT THEN WAS.
//
// The build has since changed shape. A V3.5 setup runs TWO evidence engines per ticker —
// consensusRow against consensus/evidence.js and tickerEvidence against evidence/resolve.js — plus
// a reaction attach, which is about a dozen Neon round trips per candidate over a 3,309-candidate
// pool. A CPU profile of a 150-ticker build is 85% IDLE. It is not computing; it is waiting, and
// four waiters cannot fill a pipe that deep. The memory pin stays — it is not harmful and the CPU
// it buys still helps the 15% — but it is no longer the thing that makes this fit.
//
// ── WHAT ACTUALLY FIXED IT ──────────────────────────────────────────────────
//
// CONCURRENCY 4 -> 32 in board.mjs, which is measured there. Full-pass wall clock 499s -> 217s on
// the same candidate pool, with byte-identical output. Plus BUILD_DEADLINE_MS below, so that when
// this route runs out of time again — and a growing candidate pool means it eventually will — it
// stops itself and SAYS SO instead of being killed in silence.

// RECONCILIATION — the safety net, no longer the only mechanism.
//
// ── WHAT THIS USED TO BE ────────────────────────────────────────────────────
//
// The whole freshness story. It rebuilt the board every 30 minutes into one fixed, unversioned KV
// key, and nothing else ever updated the board. So the worst-case age of any row was the full cron
// interval plus the build — including, after a methodology change, rows computed by code that no
// longer existed, served as current because the read path had no way to tell.
//
// ── WHAT IT IS NOW ──────────────────────────────────────────────────────────
//
// Freshness belongs to /api/cron/consensus-refresh, which drains the tickers evidence ingestion
// marked and rebuilds the board index from already-materialized rows. This pass catches what that
// cannot:
//
//   · evidence that changed without anything marking it dirty — a 13F ingest touches thousands of
//     tickers at once and deliberately marks none of them individually
//   · marks lost because KV was briefly unavailable when a filing committed
//   · materialization drift: a ticker cached once and never touched again
//   · board MEMBERSHIP changes driven by the passage of time rather than by a write — evidence
//     ageing out of its activation window makes a ticker stop qualifying, and no ingest happens
//     when nothing is filed
//
// That last case is why this pass recomputes EVERYTHING rather than reusing materialized tickers.
// Reconciliation that trusted the cache would perpetuate exactly the drift it exists to repair.
//
// ── WHY STILL 30 MINUTES ────────────────────────────────────────────────────
//
// Targeted invalidation carries freshness, so running this more often would buy no correctness and
// spend real database capacity; running it much less often would let a lost mark or an aged-out
// activation window persist. It is a repair interval, not a freshness interval.
//
// ⚠️ AND IT IS NOT CHEAP ANY MORE. The note here used to read "~60 tickers at ~1.6s each — roughly
// 90 seconds of Neon time", from when the pool was sixty names. It is now a full pass over ~3,300
// candidates costing ~220s at CONCURRENCY 32. Thirty minutes is still the right interval, but the
// margin under maxDuration is thin and shrinks as the evidence windows admit more candidates.
// BUILD_DEADLINE_MS is what keeps that from becoming another silent outage.

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();

  // ⚠️ THE CLOCK MOVES BEFORE THE WORK, NOT ONLY AFTER IT.
  //
  // This is the failure this route just had, and it is the same one the SEC cron had: the function
  // was killed at maxDuration, so recordJobRun below never ran. last_polled_at stayed frozen at the
  // last SUCCESS and consecutive_failures stayed at 0, which made a six-hour outage look identical
  // to a cron that had never been scheduled. There was no durable state anywhere saying "it
  // started".
  //
  // Writing a failure row FIRST fixes that with the infrastructure that already exists:
  //
  //   started, still running   last_polled_at moves, last_success_at does not, failures += 1
  //   completed                the success write below resets failures to 0
  //   started and disappeared  the 'started' row is what remains — and it is the only evidence
  //                            a kill leaves behind, because a kill runs no code of ours
  //
  // The cost is one row write per invocation and a failure count that is transiently 1 during a
  // normal run. That is a good trade for being able to tell "dead" from "never asked".
  await recordJobRun('consensus-board', { ok: false, note: 'started' });

  try {
    // reuseTickers defaults to false — see above. Every candidate is recomputed from the database.
    const r = await rebuildBoardExclusive(db, sql, {
      limit: EVALUATE_LIMIT, reason: 'reconcile',
      // ⚠️ MEASURED FROM WHEN THE INVOCATION STARTED, not from when the build does. Everything
      // before the build — auth, the candidate query, module loading — spends the same budget.
      deadlineAt: t0 + BUILD_DEADLINE_MS,
    });
    const rows = r.payload?.rows?.length ?? 0;
    const ms = Date.now() - t0;

    // 'locked' is a normal outcome, not a failure: a drain was already rebuilding, which means the
    // board is being kept current by the mechanism this pass exists to back up.
    if (!r.published) {
      const benign = r.reason === 'locked';
      // 'deadline' means the build stopped itself rather than being killed. The previous board is
      // untouched, the lock was released normally, and the heartbeat below records what happened —
      // which is the whole difference between this and the outage that prompted the change.
      console.warn(`[consensus-board] not published (${r.reason}) after ${ms}ms`);
      // ⚠️ THIS PATH USED TO RECORD NOTHING AT ALL, AND THAT IS HOW A TOTAL OUTAGE STAYED INVISIBLE.
      //
      // A reconciliation pass that cannot start is a pass that did not happen, whatever the reason.
      // Recording no heartbeat here meant last_polled_at never moved and consecutive_failures sat
      // at 0, so /api/health could only report the job as "late" — indistinguishable from a cron
      // that had simply never fired. In the incident this fixes, the pass was locked out on every
      // single attempt for nearly six hours while the board sat frozen, and the only visible symptom
      // was a clock that had stopped.
      //
      // `locked` is recorded as a FAILURE rather than a tick even though a healthy drain holds the
      // same lock: the drain records nothing under this name, so treating locked as benign here
      // leaves exactly the blind spot above. A single locked pass costs one increment and is
      // forgotten by the next successful run; a persistently starved one now surfaces as rising
      // consecutive_failures instead of silence.
      await recordJobRun('consensus-board', { ok: false, note: `not published: ${r.reason} after ${Math.round(ms / 1000)}s` });
      return Response.json({
        ok: benign, published: false, why: r.reason, version: MATERIALIZATION_VERSION, ms,
      }, { status: benign ? 200 : 500 });
    }

    console.log(`[consensus-board] ${rows} rows / ${r.payload.candidates} candidates,`
      + ` ${r.payload.failed} failed, ${ms}ms`);
    // A 'locked' pass above is deliberately NOT a heartbeat: the drain that holds the lock is the
    // thing doing the work, and recording a tick here would credit this pass for it.
    await recordJobRun('consensus-board', { ok: true, seen: rows, note: `${rows} rows / ${r.payload.candidates} candidates in ${Math.round(ms / 1000)}s` });
    return Response.json({
      ok: true, published: true, rows, candidates: r.payload.candidates,
      failed: r.payload.failed, version: MATERIALIZATION_VERSION, ms,
    });
  } catch (e) {
    // A failed build leaves the PREVIOUS board in KV. Overwriting it with an empty one would turn a
    // build failure into "no evidence exists", which is a different and false statement.
    console.error(`[consensus-board] build failed: ${e.message}`);
    await recordJobRun('consensus-board', { ok: false, note: 'build failed' });
    return Response.json({ ok: false, error: 'build_failed' }, { status: 500 });
  }
}
