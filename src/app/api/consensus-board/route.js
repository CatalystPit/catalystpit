import { after } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { familyLean } from '../../../lib/consensus/synthesis.mjs';
import { readPublishedBoard } from '../../../lib/consensus/refresh';
import { MATERIALIZATION_VERSION } from '../../../lib/consensus/materialization.mjs';
import { claimRefreshAttempt } from '../../../lib/market/refresh-policy.mjs';
import { resolveUserTier } from '../../../lib/entitlements';
import { isAdminUser } from '../../../lib/pit';

export const runtime = 'nodejs';
export const maxDuration = 20;

/** Rows a signed-out or free viewer sees, matching the existing confluence board's gate. */
const FREE_ROWS = 5;

// THE CONSENSUS BOARD, SERVED.
//
// Reads the precomputed board from KV. A request NEVER resolves evidence — see the cron for why.
//
// ── THREE OUTCOMES, NEVER COLLAPSED ─────────────────────────────────────────
//
// 'ok'        a board exists
// 'empty'     the board was built and genuinely found nothing qualifying
// 'degraded'  we could not read a board at all
//
// The third is the one that matters. Returning an empty list when the evidence system is
// unavailable tells the trader "nothing is happening", which is a claim about the market rather
// than about us, and it is the failure this product most needs to avoid.

const NO_STORE = { 'Cache-Control': 'private, no-store' };

// ── A FOURTH OUTCOME: 'stale-methodology' ───────────────────────────────────
//
// The board used to be read from one fixed key with no notion of which methodology produced it,
// and this route returned a hardcoded `version: 'consensus_v1'` whatever it found. So when V2.1
// deployed, V2 rows were served as current until the next cron.
//
// Now the deployed methodology is part of the key. A board built by older code cannot be returned
// from it, so 'ok' means "computed by the code running right now" as a matter of structure rather
// than of diligence. When that key is empty — a fresh deployment, a build still running — the last
// known-good board is served and SAID to be behind, and a rebuild is scheduled. That is a board
// which is honestly labelled as lagging, never a blank page and never a false claim of currency.
//
// ⚠️ A READ NEVER COMPUTES. Not on a miss, not on a version mismatch, not for the first visitor
// after a deploy. Resolving evidence costs ~1.6s per ticker and ~90s for the board; putting that on
// a request would mean a thousand visitors could ask for a thousand rebuilds.

/**
 * Per-row display facts, derived from the family STATES rather than from the combined number.
 *
 * ⚠️ ALIGNMENT IS PRESENTED AS A COUNT, NOT A PERCENTAGE. |ΣE|/Σ|E| reads 100% when two of four
 * families are internally mixed and merely fail to oppose — measured on UBER, which showed
 * "align 100%" on insiders:bullish, institutions:mixed, congress:bullish, catalysts:mixed. The
 * percentage is arithmetically correct and rhetorically false, so the number stays in the payload
 * for Pit Scan and the page says "2 of 4 families point bullish".
 */
function displayFacts(row) {
  // ⚠️ SHAPE NOTE. A V3 row uses `families` for the per-family FACT SHEET (an object keyed by
  // family). The V2.1 normalised ARRAY these fields are derived from now lives on
  // `canonical.families`. Reading `row.families` here would silently produce empty leans on
  // every row while looking like it worked.
  const fams = row.canonical?.families || (Array.isArray(row.families) ? row.families : []);
  const active = fams.filter((f) => f.active);
  const up = active.filter((f) => familyLean(f) === 'up');
  const down = active.filter((f) => familyLean(f) === 'down');
  const mixed = active.filter((f) => familyLean(f) === 'mixed');
  return {
    ...row,
    activeFamilies: active.map((f) => f.family),
    inactiveFamilies: fams.filter((f) => !f.active).map((f) => ({ family: f.family, reason: f.inactiveReason })),
    leanUp: up.map((f) => f.family),
    leanDown: down.map((f) => f.family),
    leanMixed: mixed.map((f) => f.family),
    // ALIGNMENT IS ONLY MEANINGFUL ACROSS TWO OR MORE INDEPENDENT FAMILIES (§5). With one active
    // family the page says SINGLE-SOURCE; it must never read 100%.
    alignmentMeaningful: active.length >= 2,
  };
}

/**
 * Ask the refresh cron to rebuild, without waiting for it and without letting traffic multiply it.
 *
 * `claimRefreshAttempt` is the repo's existing SET NX cooldown, so the thousandth visitor after a
 * deployment schedules nothing — the first one already did. `after()` runs this past the response,
 * so the reader's latency is unchanged, and every failure is swallowed: a board that could not
 * schedule its own rebuild is still a board, and the reconciliation cron will get there regardless.
 */
function scheduleRebuild(reason) {
  after(async () => {
    try {
      const secret = process.env.CRON_SECRET;
      const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://catalystpit.com';
      if (!secret) return;
      if (!(await claimRefreshAttempt(`consensus-board:${MATERIALIZATION_VERSION}`, 300))) return;
      await fetch(`${base}/api/cron/consensus-refresh?reason=${encodeURIComponent(reason)}`, {
        headers: { Authorization: `Bearer ${secret}` }, cache: 'no-store',
      });
    } catch { /* derived data must never break a read */ }
  });
}

export async function GET() {
  const { payload: board, status: readStatus } = await readPublishedBoard();

  if (!board) {
    // Nothing at all: KV unreachable, unconfigured, or never built. Returning an empty list here
    // would tell the trader "nothing is happening", which is a claim about the market rather than
    // about us, and it is the failure this product most needs to avoid.
    scheduleRebuild('degraded');
    return Response.json({
      status: 'degraded',
      message: 'The evidence board is not available right now. This is not a statement that there '
        + 'is no evidence.',
      rows: [],
    }, { status: 503, headers: NO_STORE });
  }

  // A board from an older methodology is served rather than withheld — an outage would be worse —
  // but it is never described as current, and it asks for its own replacement.
  if (readStatus === 'stale-methodology') scheduleRebuild('stale-methodology');

  const full = (board.rows || []).map(displayFacts);

  // ENTITLEMENT GATES THE SLICE, NOT THE EVIDENCE. Identical to the board this replaces: the whole
  // board is computed once for everyone, and tier only decides how much of it is returned. Nothing
  // market-data-entitled is involved — this is public disclosure evidence — so no realtime
  // entitlement can leak through it.
  let isFull = false;
  try {
    const { userId } = await auth();
    const tier = await resolveUserTier();
    const admin = userId ? await isAdminUser(userId) : false;
    isFull = tier === 'pro' || tier === 'elite' || admin;
  } catch { /* signed-out reads as free */ }

  const rows = isFull ? full : full.slice(0, FREE_ROWS);
  const lockedCount = isFull ? 0 : Math.max(0, full.length - FREE_ROWS);

  return Response.json({
    status: readStatus === 'ok' && !full.length ? 'empty' : readStatus,
    builtAt: board.builtAt ?? null,
    candidates: board.candidates ?? null,
    // Surfaced so a partially-built board is visibly partial rather than quietly short.
    failed: board.failed ?? 0,
    // FRESHNESS METADATA — for validation, stale detection and operations, not for the UI.
    // `version` is what BUILT these rows; `expected` is what is deployed. Equal is the normal case,
    // and the read path can no longer pretend they are equal when they are not.
    version: board.materializationVersion ?? 'legacy',
    expectedVersion: MATERIALIZATION_VERSION,
    methodologyCurrent: board.materializationVersion === MATERIALIZATION_VERSION,
    rows,
    lockedCount,
  // ALWAYS no-store: the slice depends on who is asking, so a shared cache could hand one
    // viewer's truncated board to another.
  }, { headers: NO_STORE });
}
