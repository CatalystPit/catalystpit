// BUILD CONTEXT — the batched data-access layer for the Consensus board build.
//
// ── WHAT THIS PROTECTS ──────────────────────────────────────────────────────
//
// The board build issued 16 database round trips per candidate — 52,944 for a full pass — and could
// not finish inside the platform's 300s ceiling. The context fetches the same rows once per chunk.
// Three properties make that safe, and each is asserted here:
//
//   1. it is DATA ACCESS ONLY — no interpretation, no thresholds, no methodology
//   2. every window is IMPORTED from the module that owns it, never retyped
//   3. a miss FALLS BACK to the per-ticker query; it never silently means "no evidence"
//
// The output-equivalence proof is a separate, database-backed script:
//   node --env-file=.env.local --import ./scripts/real-db-register.mjs \
//     scripts/verify-consensus-batch-equivalence.mjs
//
// This suite imports the constants from the modules that own them, and two of those reach db.js,
// so it runs with the same resolver + env the other Consensus suites use. It opens no connection:
// every database in it is a stub.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs \
//        scripts/verify-consensus-build-context.mjs

import {
  BuildContext, chunkTickers, CHUNK, WINDOWS, loadBuildContext,
} from '../src/lib/consensus/build-context.mjs';
import { CONSTANTS } from '../src/lib/consensus/consensus-v1.mjs';
import { HISTORY_WINDOW_DAYS, DISPLAY_WINDOW_DAYS } from '../src/lib/evidence/resolve.js';
import { MAX_RELEVANCE_DAYS } from '../src/lib/evidence/company-events.mjs';
import { HISTORY_DAYS } from '../src/lib/structure/structure-data.js';
import fs from 'node:fs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

// ── 1. WINDOWS ARE IMPORTED, NOT RETYPED ─────────────────────────────────────
sec('⚠️ EVERY WINDOW COMES FROM THE MODULE THAT OWNS IT');
// This is the bug the equivalence run caught before deployment: the first version hard-coded 45
// days for the consensus families. The real values are 90/90/14, and 70 of 120 setups differed.
check('consensus insider window is the methodology constant',
  WINDOWS.consensusInsiderDays === CONSTANTS.activationWindowDays.insiders, `${WINDOWS.consensusInsiderDays}`);
check('consensus congress window likewise',
  WINDOWS.consensusCongressDays === CONSTANTS.activationWindowDays.congress, `${WINDOWS.consensusCongressDays}`);
check('consensus catalyst window likewise',
  WINDOWS.consensusCatalystDays === CONSTANTS.activationWindowDays.catalysts, `${WINDOWS.consensusCatalystDays}`);
check('⚠️ and they are NOT all the same number',
  new Set([WINDOWS.consensusInsiderDays, WINDOWS.consensusCatalystDays]).size === 2);
check('evidence history window is the resolver constant',
  WINDOWS.resolveHistoryDays === HISTORY_WINDOW_DAYS);
check('evidence display window is the resolver constant',
  WINDOWS.resolveDisplayDays === DISPLAY_WINDOW_DAYS);
check('press window is the taxonomy constant', WINDOWS.pressDays === MAX_RELEVANCE_DAYS);
check('candle window is the structure constant', WINDOWS.candleDays === HISTORY_DAYS);

const src = fs.readFileSync('src/lib/consensus/build-context.mjs', 'utf8');
check('⚠️ no window is written as a bare number in a query',
  !/make_interval\(days => \d/.test(src));
check('the candle load covers the other two readers',
  WINDOWS.candleDays > WINDOWS.resolveHistoryDays + 12 && WINDOWS.candleDays > 400);

// ── 2. IT IS DATA ACCESS ONLY ────────────────────────────────────────────────
sec('⚠️ DATA ACCESS ONLY — NO SECOND EVIDENCE ENGINE');
// A methodology term appearing in this file means a rule has leaked out of the engines. The
// comments talk about these ideas; the CODE must not compute them.
const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
for (const term of ['materiality', 'confidence', 'qualif', 'significan', 'freshness', 'direction']) {
  check(`no "${term}" in executable code`, !new RegExp(term, 'i').test(code));
}
check('it imports no evidence-scoring module',
  !/from '\.\.\/evidence\/(model|rank|history)/.test(src));
check('it exports no classifier or scorer',
  !/export function (classify|score|qualify|rank)/i.test(src));

// ── 3. THE ACCESSOR CONTRACT ─────────────────────────────────────────────────
sec('⚠️ A MISS FALLS BACK — IT NEVER MEANS "NO EVIDENCE"');
const fams = new Map([
  ['resolve.insider', new Map([['AAA', [{ ticker: 'AAA', n: 1 }]]])],
]);
const ctx = new BuildContext(['AAA', 'BBB'], fams);
check('a loaded ticker with rows returns them', ctx.rows('resolve.insider', 'AAA')?.length === 1);
check('⚠️ a loaded ticker with NO rows returns an empty array, not null',
  Array.isArray(ctx.rows('resolve.insider', 'BBB')) && ctx.rows('resolve.insider', 'BBB').length === 0);
check('⚠️ a ticker outside the chunk returns null, so the caller queries for itself',
  ctx.rows('resolve.insider', 'ZZZ') === null);
check('⚠️ an unloaded family returns null, not an empty array',
  ctx.rows('resolve.nothing', 'AAA') === null);
check('lookups are case-insensitive', ctx.rows('resolve.insider', 'aaa')?.length === 1);
check('covers() reports membership', ctx.covers('BBB') === true && ctx.covers('ZZZ') === false);
// The distinction above is the whole safety property: `?? await db.execute(...)` falls through on
// null and short-circuits on [], so "not loaded" and "loaded, none" can never be confused.
check('null is falsy for ?? fallback and [] is not',
  (ctx.rows('resolve.insider', 'ZZZ') ?? 'fellback') === 'fellback'
  && (ctx.rows('resolve.insider', 'BBB') ?? 'fellback') !== 'fellback');

// ── 4. CHUNKING ──────────────────────────────────────────────────────────────
sec('CHUNKING BOUNDS MEMORY');
const t100 = Array.from({ length: 100 }, (_, i) => `T${i}`);
check('chunks cover every ticker exactly once',
  chunkTickers(t100, 30).flat().join(',') === t100.join(','));
check('no chunk exceeds the size', chunkTickers(t100, 30).every((c) => c.length <= 30));
check('the last chunk holds the remainder', chunkTickers(t100, 30).at(-1).length === 10);
check('an empty list yields no chunks', chunkTickers([], 30).length === 0);
check('a chunk size larger than the list yields one chunk', chunkTickers(t100, 500).length === 1);
check('⚠️ CHUNK is a memory bound, not unbounded', CHUNK > 0 && CHUNK <= 1000, `${CHUNK}`);
check('a full 3,309-candidate pass is a handful of chunks, not thousands',
  Math.ceil(3309 / CHUNK) <= 20, `${Math.ceil(3309 / CHUNK)}`);

// ── 5. THE LOADER'S OWN SHAPE ────────────────────────────────────────────────
sec('THE LOADER');
{
  let queries = 0;
  const db = { execute: async () => { queries++; return { rows: [] }; } };
  const sqlTag = (s, ...v) => ({ queryChunks: [...s], v });
  const c = await loadBuildContext(db, sqlTag, ['AAA', 'BBB', 'aaa'], { now: Date.now() });
  check('⚠️ one wave of queries for the whole chunk, not per ticker',
    queries <= 20, `${queries} queries for 2 tickers`);
  check('duplicates are collapsed before querying', c.tickers.size === 2);
  check('every family is present even when empty',
    ['consensus.insider', 'consensus.congress', 'consensus.catalyst', 'consensus.institution',
      'resolve.insider', 'resolve.congress', 'resolve.catalyst', 'resolve.form144',
      'resolve.sched13d', 'resolve.press', 'resolve.breadth',
      'price.candles', 'price.quality', 'price.breaks'].every((f) => c.has(f)));
  check('a covered ticker with no rows reads as empty, not missing',
    c.rows('price.candles', 'AAA')?.length === 0);
}
{
  const db = { execute: async () => { throw new Error('nope'); } };
  const sqlTag = (s, ...v) => ({ queryChunks: [...s], v });
  let threw = false;
  try { await loadBuildContext(db, sqlTag, ['AAA'], {}); } catch { threw = true; }
  check('⚠️ a failing load rejects, so the caller can fall back to per-ticker queries', threw);
}
{
  const db = { execute: async () => { throw new Error('should not be called'); } };
  const sqlTag = (s, ...v) => ({ queryChunks: [...s], v });
  const c = await loadBuildContext(db, sqlTag, [], {});
  check('an empty chunk queries nothing', c.tickers.size === 0);
}

// ── 6. DETERMINISTIC ORDERING ────────────────────────────────────────────────
sec('⚠️ TIES ARE BROKEN DETERMINISTICALLY, IN BOTH PATHS');
// Equivalence failed twice on ties: congress rows sharing a disclosure_date made
// `latestTransaction` arbitrary, and insider rows sharing (filing_date, accession) changed the
// ASSOCIATION of a floating-point sum. Both paths now order by the primary key last.
const consensusSrc = fs.readFileSync('src/lib/consensus/evidence.js', 'utf8');
const resolveSrc = fs.readFileSync('src/lib/evidence/resolve.js', 'utf8');
check('per-ticker congress query breaks ties on id',
  /order by disclosure_date desc, id desc/.test(consensusSrc)
  && /order by disclosure_date desc, id desc/.test(resolveSrc));
check('batched congress query breaks ties on id',
  (src.match(/order by disclosure_date desc, id desc/g) || []).length >= 2);
check('per-ticker insider query breaks ties on accession then id',
  /order by filing_date desc, accession desc, id desc/.test(consensusSrc)
  && /order by filing_date desc, accession desc, id desc/.test(resolveSrc));
check('batched insider query breaks ties the same way',
  (src.match(/filing_date desc, accession desc, id desc/g) || []).length >= 2);
check('batched press query breaks ties on seq',
  /published_at desc, p?\.?seq desc/.test(src) || /published_at desc, seq desc/.test(src));
check('per-ticker press query breaks ties on seq',
  /order by published_at desc, seq desc/.test(resolveSrc));

// ── 7. THE PER-TICKER PATH STILL EXISTS ──────────────────────────────────────
sec('⚠️ THE SINGLE-TICKER API MUST KEEP WORKING');
// A ticker page resolves one ticker with no context. Every resolver must still carry its own query.
for (const [name, body] of [['consensus/evidence.js', consensusSrc], ['evidence/resolve.js', resolveSrc]]) {
  check(`${name} still issues its own queries`, /db\.execute\(sql`/.test(body));
  check(`${name} falls back with ?? rather than branching on a flag`,
    /const pre = ctx\?\.rows\(/.test(body) && /pre \?\? await db\.execute/.test(body));
}
check('ctx defaults to null everywhere it is accepted',
  (consensusSrc.match(/ctx = null/g) || []).length >= 5
  && (resolveSrc.match(/ctx = null/g) || []).length >= 6);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
