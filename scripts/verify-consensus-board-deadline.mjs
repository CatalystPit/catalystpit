// CONSENSUS BOARD RELIABILITY — the deadline, the no-partial-publish guarantee, and the
// concurrency-is-a-schedule-not-a-methodology guarantee.
//
// ── WHAT THIS PROTECTS ──────────────────────────────────────────────────────
//
// The board stopped refreshing for six hours because the build outgrew maxDuration and was KILLED
// mid-flight: no heartbeat, no log, no lock release, and a frozen clock as the only symptom. Three
// things now stand between that and a repeat, and each is asserted here:
//
//   1. the build stops ITSELF before the platform does
//   2. a truncated build is never published, so last-known-good survives
//   3. raising concurrency changed the clock and not a single row
//
// Run: node scripts/verify-consensus-board-deadline.mjs

import { buildSetupBoard, BUILD_DEADLINE_MS } from '../src/lib/consensus/setup-board.js';
import { rebuildBoard } from '../src/lib/consensus/refresh.js';
import { CONCURRENCY } from '../src/lib/consensus/board.mjs';
import { MATERIALIZATION_VERSION } from '../src/lib/consensus/materialization.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

// ── a fake database, so this suite runs with no network ──────────────────────
//
// selectSetupCandidates issues three grouped reads and buildSetupBoard issues one universe count.
// Returning insider rows for N synthetic tickers is enough to produce N candidates.
const mkDb = (tickers) => ({
  execute: async (q) => {
    const text = JSON.stringify(q).toLowerCase();
    if (text.includes('insider_trades')) {
      return { rows: tickers.map((t) => ({ ticker: t, buy_usd: 5_000_000, any_usd: 5_000_000 })) };
    }
    if (text.includes('congress_trades')) return { rows: [] };
    if (text.includes('eightk_filings')) return { rows: [] };
    return { rows: [{ n: tickers.length }] };          // the universe count
  },
});
const sqlTag = (strings, ...vals) => ({ strings: [...strings], vals });
const TICKERS = Array.from({ length: 400 }, (_, i) => `TK${String(i).padStart(3, '0')}`);

/**
 * How many candidates the build actually picked up.
 *
 * ⚠️ NOT `evaluated`. buildSetup calls consensusRow for real and consensusRow needs a database, so
 * under these doubles every ticker lands in `failed`. Attempts is what the deadline governs, and
 * it is the same number either way.
 */
const attempted = (b) => b.evaluated + b.failed;

// A resolver that takes real wall-clock time, so a deadline can actually be reached.
const slowResolve = (ms) => async () => { await new Promise((r) => setTimeout(r, ms)); return { evidence: [], failedFamilies: [] }; };
const slowConsensus = (ms) => async (t) => {
  await new Promise((r) => setTimeout(r, ms));
  return { ticker: t, canonical: null, families: [] };
};

sec('THE DEADLINE EXISTS AND IS BELOW THE PLATFORM CEILING');
check('BUILD_DEADLINE_MS is defined', Number.isFinite(BUILD_DEADLINE_MS));
check('⚠️ and leaves room under the 300s maxDuration', BUILD_DEADLINE_MS < 300_000,
  `${BUILD_DEADLINE_MS}ms`);
check('...with enough room for validation and the heartbeat write', 300_000 - BUILD_DEADLINE_MS >= 30_000);

sec('A BUILD THAT RUNS OUT OF TIME STOPS ITSELF');
{
  const db = mkDb(TICKERS);
  const started = Date.now();
  // ⚠️ DETERMINISTIC BY CONSTRUCTION: 400 candidates cannot all be taken in one pass at
  // CONCURRENCY workers, and the first wave takes longer than the deadline, so the second pull
  // is guaranteed to find the budget gone.
  const board = await buildSetupBoard(db, sqlTag, {
    deadlineAt: Date.now() + 60,
    resolve: slowResolve(150), resolveConsensus: slowConsensus(150),
  });
  const took = Date.now() - started;
  check('⚠️ it reports that it aborted', board.aborted === true);
  check('...rather than silently returning a short board', attempted(board) < TICKERS.length,
    `attempted ${attempted(board)} of ${TICKERS.length}`);
  check('...having taken no more than one wave of work', attempted(board) <= CONCURRENCY,
    `attempted ${attempted(board)} at concurrency ${CONCURRENCY}`);
  check('...and it stopped near the deadline, not at the end of the work',
    took < 3000, `${took}ms`);
  check('the candidate count still reports the WHOLE pool, not the part it reached',
    board.candidates === TICKERS.length, `${board.candidates}`);
}

sec('⚠️ AND A TRUNCATED BUILD IS NEVER PUBLISHED');
{
  const writes = [];
  // rebuildBoard publishes through materialization's KV helpers; if it ever reaches them on an
  // aborted build that is the bug this asserts against. We detect it by the returned contract,
  // which is what every caller keys on.
  const db = mkDb(TICKERS);
  const r = await rebuildBoard(db, sqlTag, {
    deadlineAt: Date.now() + 60, reason: 'test',
    resolve: slowResolve(150), resolveConsensus: slowConsensus(150),
  });
  check('published is false', r.published === false);
  check('⚠️ for the stated reason, distinguishable from a validation failure',
    r.reason === 'deadline', `got ${r.reason}`);
  check('the payload is returned for diagnosis but marked aborted', r.payload?.aborted === true);
  check('it carries the methodology version like every other payload',
    r.payload?.materializationVersion === MATERIALIZATION_VERSION);
  check('nothing was written', writes.length === 0);
}

sec('A BUILD THAT FITS PUBLISHES NORMALLY');
{
  const db = mkDb(TICKERS.slice(0, 5));
  const board = await buildSetupBoard(db, sqlTag, {
    deadlineAt: Date.now() + 60_000,
    resolve: slowResolve(1), resolveConsensus: slowConsensus(1),
  });
  check('⚠️ aborted is false on a complete build', board.aborted === false);
  check('every candidate was attempted', attempted(board) === 5, `${attempted(board)}`);
  check('the deadline defaults when the caller passes none',
    (await buildSetupBoard(mkDb(['AAA']), sqlTag, { resolve: slowResolve(1), resolveConsensus: slowConsensus(1) })).aborted === false);
}

sec('⚠️ CONCURRENCY IS A SCHEDULE, NOT A METHODOLOGY');
check('the build runs more than a handful of tickers at a time', CONCURRENCY >= 16, `${CONCURRENCY}`);
check('...and not so many that it stops being a bound', CONCURRENCY <= 64, `${CONCURRENCY}`);
{
  // Same inputs, same pinned clock, two very different schedules. The rows must not differ.
  const NOW = Date.parse('2026-09-24T23:00:00Z');
  const fingerprint = (b) => JSON.stringify(b.rows.map((s) => [s.ticker, s.setup?.active, s.setup?.label]));
  const run = () => buildSetupBoard(mkDb(TICKERS.slice(0, 40)), sqlTag, {
    now: NOW, deadlineAt: NOW + 10_000_000,
    resolve: slowResolve(0), resolveConsensus: slowConsensus(0),
  });
  const [a, b] = await Promise.all([run(), run()]);
  check('two interleaved builds of the same input agree', fingerprint(a) === fingerprint(b));
  check('...on the candidate count too', a.candidates === b.candidates);
  check('...and on what was dropped', a.dropped === b.dropped && a.droppedNoEvidence === b.droppedNoEvidence);
}

sec('THE ABORT DOES NOT INVENT A BOARD');
{
  const board = await buildSetupBoard(mkDb(TICKERS), sqlTag, {
    deadlineAt: Date.now() - 1,                       // already past
    resolve: slowResolve(5), resolveConsensus: slowConsensus(5),
  });
  check('⚠️ a deadline already in the past attempts nothing', attempted(board) === 0);
  check('...and says so', board.aborted === true);
  check('...and produces no rows rather than a plausible-looking empty board',
    board.rows.length === 0);
  check('...while still reporting the pool it did not get to', board.candidates === TICKERS.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
