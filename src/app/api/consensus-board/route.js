import { auth } from '@clerk/nextjs/server';
import { familyLean } from '../../../lib/consensus/synthesis.mjs';
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

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const BOARD_KEY = 'consensus:board:v1';
const NO_STORE = { 'Cache-Control': 'private, no-store' };


async function kvGet(k) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`,
      { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store' });
    if (!r.ok) return null;
    const { result } = await r.json();
    return result ? JSON.parse(result) : null;
  } catch { return null; }
}

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
  const fams = row.families || [];
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

export async function GET() {
  const board = await kvGet(BOARD_KEY);

  if (!board) {
    return Response.json({
      status: 'degraded',
      message: 'The evidence board is not available right now. This is not a statement that there '
        + 'is no evidence.',
      rows: [],
    }, { status: 503, headers: NO_STORE });
  }

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
    status: full.length ? 'ok' : 'empty',
    builtAt: board.builtAt ?? null,
    candidates: board.candidates ?? null,
    // Surfaced so a partially-built board is visibly partial rather than quietly short.
    failed: board.failed ?? 0,
    version: 'consensus_v1',
    rows,
    lockedCount,
  // ALWAYS no-store: the slice depends on who is asking, so a shared cache could hand one
    // viewer's truncated board to another.
  }, { headers: NO_STORE });
}
