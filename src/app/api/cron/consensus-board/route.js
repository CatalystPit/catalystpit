import { db } from '../../../../lib/db';
import { sql } from 'drizzle-orm';
import { EVALUATE_LIMIT } from '../../../../lib/consensus/setup-board.js';
import { rebuildBoardExclusive } from '../../../../lib/consensus/refresh';
import { MATERIALIZATION_VERSION } from '../../../../lib/consensus/materialization.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;

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
// A full pass is ~60 tickers at ~1.6s each with concurrency 4 — roughly 90 seconds of Neon time.
// Targeted invalidation now carries freshness, so running this more often would buy no correctness
// and spend real database capacity; running it much less often would let a lost mark or an
// aged-out activation window persist. It is a repair interval, not a freshness interval.

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();
  try {
    // reuseTickers defaults to false — see above. Every candidate is recomputed from the database.
    const r = await rebuildBoardExclusive(db, sql, { limit: EVALUATE_LIMIT, reason: 'reconcile' });
    const rows = r.payload?.rows?.length ?? 0;
    const ms = Date.now() - t0;

    // 'locked' is a normal outcome, not a failure: a drain was already rebuilding, which means the
    // board is being kept current by the mechanism this pass exists to back up.
    if (!r.published) {
      const benign = r.reason === 'locked';
      console.warn(`[consensus-board] not published (${r.reason}) after ${ms}ms`);
      return Response.json({
        ok: benign, published: false, why: r.reason, version: MATERIALIZATION_VERSION, ms,
      }, { status: benign ? 200 : 500 });
    }

    console.log(`[consensus-board] ${rows} rows / ${r.payload.candidates} candidates,`
      + ` ${r.payload.failed} failed, ${ms}ms`);
    return Response.json({
      ok: true, published: true, rows, candidates: r.payload.candidates,
      failed: r.payload.failed, version: MATERIALIZATION_VERSION, ms,
    });
  } catch (e) {
    // A failed build leaves the PREVIOUS board in KV. Overwriting it with an empty one would turn a
    // build failure into "no evidence exists", which is a different and false statement.
    console.error(`[consensus-board] build failed: ${e.message}`);
    return Response.json({ ok: false, error: 'build_failed' }, { status: 500 });
  }
}
