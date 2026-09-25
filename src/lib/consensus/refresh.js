// CONSENSUS REFRESH — compute, validate, publish.
//
// The write side of materialization. Everything expensive happens here, on a schedule or in
// response to evidence landing; nothing here runs on a user request.
//
// Three entry points:
//
//   refreshTicker(ticker)        one ticker, recomputed and materialized
//   rebuildBoard(db, sql, opts)  the board index, validated, then published atomically
//   drainDirty(db, sql, opts)    recompute what evidence changed, then republish the index
//
// See materialization.mjs for why the version lives in the key rather than in a field somebody has
// to remember to compare.

import { consensusRow, BOARD_LIMIT } from './board.mjs';
import { EVALUATE_LIMIT } from './setup-board.js';
import {
  MATERIALIZATION_VERSION, boardKey, tickerKey, LAST_GOOD_KEY,
  BOARD_TTL_SEC, LAST_GOOD_TTL_SEC, TICKER_TTL_SEC, TICKER_REUSE_MAX_AGE_MS,
  kvGetJson, kvSetJson, claimLock, releaseLock,
  readDirty, clearDirty, drainStrategy, validateBoardPayload,
} from './materialization.mjs';

const BOARD_LOCK = 'consensus:board';

// ── ONE TICKER ──────────────────────────────────────────────────────────────

/** Recompute a ticker and materialize it. Returns the row (or null when it has nothing to say). */
export async function refreshTicker(ticker, { now = Date.now(), resolve } = {}) {
  const resolveEvidence = resolve || (await import('./evidence.js')).resolveEvidence;
  const families = await resolveEvidence(ticker, { now });
  // Pass the already-resolved families through rather than resolving twice. This is the single
  // place a row is computed (see consensusRow), so the ticker page and the board cannot diverge.
  const row = await consensusRow(ticker, { now, resolve: async () => families });
  await kvSetJson(tickerKey(ticker), {
    materializationVersion: MATERIALIZATION_VERSION,
    calculatedAt: new Date(now).toISOString(),
    ticker: String(ticker).toUpperCase(),
    row,                                   // null is a real answer: "nothing currently qualifying"
    // The raw families too: the ticker page renders inactive families as well, and "Congress: no
    // disclosures in window" is information the board's row shape drops.
    families,
  }, TICKER_TTL_SEC);
  return row;
}

/**
 * The resolved families for a ticker, materialized if recent enough, else null.
 *
 * Used by the per-ticker read path so an already-computed ticker costs a KV GET instead of five
 * database round trips. Returns families rather than the finished row so the caller runs them
 * through the same canonical functions either way — a cached SHAPE, never a cached INTERPRETATION.
 */
export async function readTickerFamilies(ticker, now = Date.now()) {
  const hit = await readTicker(ticker, { now });
  return Array.isArray(hit?.families) && hit.families.length ? hit.families : null;
}

/**
 * Read a materialized ticker, or null when it is missing, from another methodology, or too old.
 *
 * The version check is implicit — a ticker materialized under an older methodology lives under a
 * different key — but it is asserted anyway, because this object is about to be published inside a
 * board that claims to be entirely one methodology.
 */
export async function readTicker(ticker, { maxAgeMs = TICKER_REUSE_MAX_AGE_MS, now = Date.now() } = {}) {
  const hit = await kvGetJson(tickerKey(ticker));
  if (!hit || hit.materializationVersion !== MATERIALIZATION_VERSION) return null;
  const age = now - Date.parse(hit.calculatedAt || 0);
  if (!Number.isFinite(age) || age > maxAgeMs) return null;
  return hit;
}

// ── THE BOARD ───────────────────────────────────────────────────────────────

/**
 * Build the board, validate it, and publish it — in that order.
 *
 * ⚠️ NOTHING IS PUBLISHED THAT HAS NOT VALIDATED. A failed or partial build leaves the previous
 * board exactly where it was. A deployment that cannot build is a board that is BEHIND, which the
 * read path reports honestly; it is never a blank page and never a half-written payload.
 *
 * @param {boolean} [opts.reuseTickers] reuse recently materialized tickers instead of recomputing
 *   every one. The reconciliation pass passes false: its entire job is to catch the drift that
 *   reusing a cache would perpetuate.
 * @param {string[]} [opts.force] tickers to recompute even when a fresh materialization exists.
 */
export async function rebuildBoard(db, sql, {
  limit = EVALUATE_LIMIT, now = Date.now(), reuseTickers = false, force = [], reason = 'manual',
  deadlineAt,
  // Test seam. Production leaves this undefined and the real evidence engine is imported lazily,
  // which keeps this module loadable without a database.
  resolve, resolveConsensus,
} = {}) {
  // V3: the board is a SETUP board. Rows carry the V3 setup object AND the full V2.1 canonical
  // object, so Pit Scan's contract and every V2.1 consumer keep working unchanged.
  //
  // Per-ticker reuse is deliberately not applied here. It existed to make a 90-second consensus
  // rebuild cheap; a V3 build resolves ~150 tickers in ~20s because the evidence engine is fast
  // warm, and reusing a cached row would risk publishing a setup classified against stale evidence
  // — the one thing a freshness-driven board must not do. Targeted invalidation still decides WHEN
  // to rebuild; it no longer decides which rows are recomputed.
  void reuseTickers; void force; void readTicker;
  const { buildSetupBoard } = await import('./setup-board.js');
  let reused = 0;

  const board = await buildSetupBoard(db, sql, { limit, now, resolve, resolveConsensus, deadlineAt });

  // ⚠️ A TRUNCATED BUILD IS NOT A BOARD. It is a complete board with an arbitrary subset of the
  // market silently missing, which is a worse lie than being behind. Refusing here keeps the
  // existing guarantee intact: a failed rebuild leaves the previous board exactly where it was.
  if (board.aborted) {
    return { published: false, reason: 'deadline', payload: { ...board, materializationVersion: MATERIALIZATION_VERSION, reason } };
  }
  const payload = {
    ...board,
    materializationVersion: MATERIALIZATION_VERSION,
    reason,
    reused,
  };

  const check = validateBoardPayload(payload);
  if (!check.ok) return { published: false, reason: check.reason, payload };

  // The version-scoped key is what readers ask for, so writing it IS the swap: until this line
  // runs there is no current-methodology board, and after it there is a complete one. There is no
  // moment where a reader can see half of each.
  const wrote = await kvSetJson(boardKey(), payload, BOARD_TTL_SEC);
  if (!wrote) return { published: false, reason: 'kv-write-failed', payload };

  // Last-known-good is written only AFTER the real key, and only on success, so it can never be
  // more broken than what is already live.
  await kvSetJson(LAST_GOOD_KEY, payload, LAST_GOOD_TTL_SEC);
  return { published: true, reason: check.reason, payload };
}

/** Rebuild under a lock. Concurrent callers do not queue behind it — they decline and move on. */
export async function rebuildBoardExclusive(db, sql, opts = {}) {
  if (!(await claimLock(BOARD_LOCK, 300))) return { published: false, reason: 'locked' };
  try {
    return await rebuildBoard(db, sql, opts);
  } finally {
    await releaseLock(BOARD_LOCK);
  }
}

// ── THE DRAIN ───────────────────────────────────────────────────────────────

/**
 * Recompute what changed, then republish the index.
 *
 * WHY THE INDEX IS ALWAYS REPUBLISHED: a ticker's consensus changing is not a private fact about
 * that ticker. It can change whether the ticker qualifies for the board at all, and it certainly
 * changes ordering, the filter counts and the state distribution. Updating a per-ticker object
 * while leaving the index stale would produce exactly the incoherence this design exists to
 * remove — so the drain updates both or neither.
 *
 * The republish is cheap because every ticker that did NOT change is reused from its
 * materialization; only the dirty ones are recomputed.
 */
export async function drainDirty(db, sql, { now = Date.now(), limit = EVALUATE_LIMIT, resolve, resolveConsensus } = {}) {
  const dirty = await readDirty();
  const strategy = drainStrategy(dirty.length);

  if (strategy === 'none') return { strategy, drained: 0, published: false, reason: 'nothing-dirty' };

  if (!(await claimLock(BOARD_LOCK, 300))) {
    // Deliberately do NOT clear the set: whatever is marked stays marked for the next pass.
    return { strategy, drained: 0, published: false, reason: 'locked' };
  }
  try {
    // A full-strategy drain recomputes everything anyway, so nothing needs forcing.
    const result = await rebuildBoard(db, sql, {
      limit, now, reuseTickers: strategy === 'targeted', force: dirty,
      reason: `drain:${strategy}`, resolve, resolveConsensus,
    });
    // Clear ONLY on a successful publish, and clear only the members we actually drained —
    // anything marked while this was running survives to the next pass.
    if (result.published) await clearDirty(dirty);
    return { strategy, drained: dirty.length, tickers: dirty, ...result };
  } finally {
    await releaseLock(BOARD_LOCK);
  }
}

// ── THE READ SIDE'S VIEW ────────────────────────────────────────────────────

/**
 * What the current methodology has published, or the last good board if it has not published yet.
 *
 * Returns `{ payload, status }`. Never computes anything: a visitor must not be able to trigger
 * evidence resolution, however stale the board is.
 */
export async function readPublishedBoard() {
  const current = await kvGetJson(boardKey());
  if (current) return { payload: current, status: current.rows?.length ? 'ok' : 'empty' };

  const lastGood = await kvGetJson(LAST_GOOD_KEY);
  if (lastGood) {
    return {
      payload: lastGood,
      status: lastGood.materializationVersion === MATERIALIZATION_VERSION ? 'ok' : 'stale-methodology',
    };
  }
  return { payload: null, status: 'degraded' };
}
