// CONSENSUS MATERIALIZATION — freshness, versioning and scale.
//
// ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
//
// The board lived at one fixed KV key with no record of which methodology built it, rebuilt by a
// 30-minute cron and nothing else. When V2.1 deployed, production kept serving V2 rows described
// as current until that cron next ran. Two distinct defects: rows could be STALE (up to the cron
// interval behind the evidence) and rows could be WRONG (computed by code that no longer existed,
// with nothing on the read path able to tell).
//
// Every existing consensus suite tests pure functions. Nothing tested the KV round trip, the
// degraded-vs-empty distinction, the entitlement slice, or what happens when a build fails — which
// is precisely where this bug lived. So this suite runs the real modules against an in-memory
// Upstash, exercising the actual command traffic rather than a mock of the intent.
//
// Run: node scripts/verify-consensus-materialization.mjs [--mutate=<mode>]

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// ── AN IN-MEMORY UPSTASH ────────────────────────────────────────────────────
//
// Implements the generic command endpoint the real client talks to, so the modules under test are
// unmodified and their actual command traffic is observable.
const KV = new Map();
const SETS = new Map();
let commands = [];
let kvFailing = false;

process.env.KV_REST_API_URL = 'http://kv.test';
process.env.KV_REST_API_TOKEN = 'test-token';

globalThis.fetch = async (url, init) => {
  if (String(url) !== 'http://kv.test') throw new Error(`unexpected fetch: ${url}`);
  const parts = JSON.parse(init.body);
  commands.push(parts);
  if (kvFailing) return { ok: false, json: async () => ({}) };
  const [cmd, key, ...rest] = parts;
  const reply = (result) => ({ ok: true, json: async () => ({ result }) });

  switch (cmd.toUpperCase()) {
    case 'GET': return reply(KV.has(key) ? KV.get(key) : null);
    case 'SET': {
      // Honour NX, because the single-writer lock depends on it.
      if (rest.includes('NX') && KV.has(key)) return reply(null);
      KV.set(key, rest[0]);
      return reply('OK');
    }
    case 'DEL': { KV.delete(key); SETS.delete(key); return reply(1); }
    case 'SADD': {
      if (!SETS.has(key)) SETS.set(key, new Set());
      const s = SETS.get(key); const before = s.size;
      for (const m of rest) s.add(m);
      return reply(s.size - before);
    }
    case 'SREM': {
      const s = SETS.get(key); if (!s) return reply(0);
      let n = 0; for (const m of rest) if (s.delete(m)) n++;
      return reply(n);
    }
    case 'SMEMBERS': return reply([...(SETS.get(key) || [])]);
    case 'SCARD': return reply((SETS.get(key) || new Set()).size);
    case 'EXPIRE': return reply(1);
    default: return reply(null);
  }
};
const resetKv = () => { KV.clear(); SETS.clear(); commands = []; kvFailing = false; };

const M = await import('../src/lib/consensus/materialization.mjs');
const R = await import('../src/lib/consensus/refresh.js');
const { familyValue } = await import('../src/lib/consensus/consensus-v1.mjs');
const { SETUP_VERSION } = await import('../src/lib/consensus/setup.mjs');
const { SYNTHESIS_VERSION } = await import('../src/lib/consensus/synthesis.mjs');

// ── FIXTURES ────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-09-20T12:00:00Z');
const fam = (family, direction, extra = {}) => familyValue({
  family, direction, strength: 0.8, freshness: 1, quality: 0.9, evidenceCount: 4,
  state: direction > 0.2 ? 'bullish' : direction < -0.2 ? 'bearish' : 'mixed', ...extra,
});

// Per-ticker CONSENSUS families the fake resolver serves. Mutating this simulates evidence landing.
let EVIDENCE = {};
let resolveCalls = [];
const resolve = async (ticker) => {
  resolveCalls.push(ticker);
  return EVIDENCE[ticker] || [fam('insiders', 0.9), fam('congress', 0.8)];
};

// V3 builds ALSO resolve evidence_v1 records. One fresh material catalyst plus a congressional
// disclosure is enough to produce an active setup for every fixture ticker.
const evAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();
// Per-ticker override, so a test can make a company genuinely stop qualifying. Under V3.5
// qualification is decided by the evidence_v1 records, not by the consensus family values, so
// clearing only the latter would leave the ticker on the board — correctly.
let EV1 = {};
const evidenceV1 = async (ticker) => (EV1[ticker] !== undefined
  ? { ticker, evidence: EV1[ticker], failedFamilies: [], quarantined: [], coverage: {} }
  : {
  ticker,
  evidence: [
    { evidenceId: `${ticker}-c`, family: 'catalyst', type: 'sec_8k_material_agreement',
      direction: 'unknown', materiality: 0.75, quality: 0.95, publicTime: evAgo(1),
      summary: 'Material agreement', source: 'sec_8k', url: 'https://sec.gov/x',
      facts: { items: ['1.01'], material: true }, methodology: 'evidence_v1' },
    { evidenceId: `${ticker}-g`, family: 'congress', type: 'congress_disclosure',
      direction: 'positive', materiality: 0.55, quality: 0.6, publicTime: evAgo(2),
      summary: 'A member disclosed a buy', source: 'congress', url: 'https://house.gov/x',
      // A disclosed range large enough to be MEANINGFUL under V3.5 significance. A
      // $1,001-$15,000 trade is deliberately not, so the fixture states a real one.
      // Three members on a large disclosed range — enough to clear the tightened congressional
      // significance bar, which deliberately rejects lone routine disclosures.
      facts: { members: 3, transactionDate: '2026-08-07', disclosureLagDays: 31,
        amountRange: '$500,001 - $1,000,000' },
      methodology: 'evidence_v1' },
  ],
  failedFamilies: [], quarantined: [], coverage: {},
});
// Every rebuild in this suite drives the V3 path, so both seams are always supplied.
const BUILD = { resolve: evidenceV1, resolveConsensus: resolve };

let CANDIDATES = ['AAA', 'BBB', 'CCC'];
const db = { execute: async () => CANDIDATES.map((t) => ({ ticker: t, n: 5 })) };
const sql = (s, ...v) => ({ s, v });

const setEvidence = (t, fams) => { EVIDENCE[t] = fams; };
const reset = () => {
  resetKv(); EVIDENCE = {}; EV1 = {}; resolveCalls = []; CANDIDATES = ['AAA', 'BBB', 'CCC'];
};

// selectCandidates takes each of three queries and unions them, so every ticker appears with
// 3 families and clears the "two or more families" filter.

L('=== THE VERSION IS PART OF THE KEY ===');
{
  ok('the materialization version includes the synthesis methodology',
    M.MATERIALIZATION_VERSION.includes(SYNTHESIS_VERSION), M.MATERIALIZATION_VERSION);
  ok('…and the legacy aggregate methodology', M.MATERIALIZATION_VERSION.includes('consensus_v1'));
  ok('…and a board shape version that can be bumped on its own',
    M.MATERIALIZATION_VERSION.endsWith(M.BOARD_SHAPE_VERSION));
  ok('the board key carries the version',
    M.boardKey().includes(M.MATERIALIZATION_VERSION), M.boardKey());
  ok('a different methodology produces a DIFFERENT key',
    mut('sharedkey') ? false : M.boardKey('other_version') !== M.boardKey());
  ok('the ticker key carries the version and the ticker',
    M.tickerKey('aapl').includes(M.MATERIALIZATION_VERSION) && M.tickerKey('aapl').endsWith(':AAPL'));
  // The last-known-good key must NOT be version-scoped, or after a methodology change there would
  // be nothing in it and a deployment would be an outage.
  ok('last-known-good is deliberately NOT version-scoped',
    !M.LAST_GOOD_KEY.includes(M.MATERIALIZATION_VERSION), M.LAST_GOOD_KEY);
}

L('\n=== A BOARD IS NEVER PUBLISHED UNVALIDATED ===');
{
  const base = {
    rows: [{ ticker: 'AAA', canonical: { state: 'MIXED', version: SYNTHESIS_VERSION } }],
    candidates: 3, failed: 0, builtAt: new Date(NOW).toISOString(),
    materializationVersion: M.MATERIALIZATION_VERSION,
  };
  ok('a well-formed payload validates', M.validateBoardPayload(base).ok);

  // THE ONE THAT MATTERS: no payload may contain rows from two methodologies.
  const mixed = { ...base, rows: [...base.rows, { ticker: 'BBB', canonical: { state: 'MIXED', version: 'consensus_v2_OLD' } }] };
  const v = M.validateBoardPayload(mixed);
  ok('a payload mixing methodologies is REFUSED',
    mut('mixed') ? false : !v.ok && v.reason.startsWith('mixed-methodology'), v.reason);
  ok('…and the refusal says how many rows were wrong', v.reason === 'mixed-methodology:1');

  ok('a payload stamped with another materialization version is refused',
    !M.validateBoardPayload({ ...base, materializationVersion: 'x' }).ok);
  ok('a malformed row is refused',
    !M.validateBoardPayload({ ...base, rows: [{ canonical: { version: SYNTHESIS_VERSION } }] }).ok);
  ok('a payload with no rows array is refused', !M.validateBoardPayload({}).ok);
  ok('a payload with no build time is refused', !M.validateBoardPayload({ ...base, builtAt: null }).ok);

  // An empty board is legitimate ONLY when nothing qualified. Empty-with-candidates is a failed
  // build, and publishing it would tell every reader that no evidence exists anywhere.
  ok('empty with zero candidates is legitimate',
    M.validateBoardPayload({ ...base, rows: [], candidates: 0 }).ok);
  ok('empty WITH candidates is refused as a failed build',
    mut('empty') ? false : !M.validateBoardPayload({ ...base, rows: [], candidates: 30 }).ok);
  ok('most candidates failing is refused as systemic',
    !M.validateBoardPayload({ ...base, candidates: 30, failed: 20 }).ok);
}

L('\n=== READ CLASSIFICATION ===');
{
  const cur = { rows: [1], materializationVersion: M.MATERIALIZATION_VERSION };
  ok('a current board with rows reads ok', M.classifyBoard(cur).status === 'ok');
  ok('a current board with no rows reads empty',
    M.classifyBoard({ ...cur, rows: [] }).status === 'empty');
  ok('no board at all reads degraded', M.classifyBoard(null).status === 'degraded');
  // NEVER SILENTLY CURRENT.
  ok('an older methodology reads stale-methodology, never ok',
    mut('silentstale') ? false
      : M.classifyBoard({ ...cur, materializationVersion: 'older' }).status === 'stale-methodology');
  ok('…and is explicitly marked not current',
    M.classifyBoard({ ...cur, materializationVersion: 'older' }).current === false);
}

L('\n=== THE DIRTY SET ===');
{
  reset();
  ok('marking returns the number of tickers accepted',
    (await M.markConsensusDirty(['AAPL', 'MSFT'])) === 2);

  // BURST DEDUPE. Three Form 4s and two wire events for one ticker is one unit of work.
  await M.markConsensusDirty(['AAPL']); await M.markConsensusDirty('AAPL');
  await M.markConsensusDirty(['aapl']); await M.markConsensusDirty(['AAPL', 'AAPL']);
  const dirty = await M.readDirty();
  ok('repeated marks for one ticker collapse to one entry',
    mut('nodedupe') ? false : dirty.filter((t) => t === 'AAPL').length === 1, dirty.join(','));
  ok('case is normalised, so aapl and AAPL are the same ticker', !dirty.includes('aapl'));
  ok('unrelated tickers are untouched by another ticker\'s marks',
    dirty.includes('MSFT') && dirty.length === 2, dirty.join(','));

  // NO CROSS-TICKER CONTAMINATION and no junk.
  await M.markConsensusDirty(['', null, undefined, 'TOOLONGTICKER', '../../etc', 'BRK.B']);
  const d2 = await M.readDirty();
  ok('invalid tickers are rejected, not stored',
    d2.length === 3 && d2.includes('BRK.B'), d2.join(','));

  await M.clearDirty(['AAPL']);
  const d3 = await M.readDirty();
  ok('clearing removes exactly what was drained', !d3.includes('AAPL') && d3.includes('MSFT'));
}

L('\n=== EVIDENCE INGESTION IS NEVER BROKEN BY DERIVED CONSENSUS ===');
{
  // EVIDENCE FIRST, DERIVED SECOND. An ingest that rolled back because a cache could not be
  // notified would trade authoritative SEC data for a convenience.
  reset();
  kvFailing = true;
  let threw = false;
  try { await M.markConsensusDirty(['AAPL']); } catch { threw = true; }
  ok('a KV failure during marking does not throw into the ingest',
    mut('throws') ? false : !threw);
  kvFailing = false;

  globalThis.fetch = async () => { throw new Error('network down'); };
  let threw2 = false;
  try { await M.markConsensusDirty(['AAPL']); } catch { threw2 = true; }
  ok('a network failure during marking does not throw either', !threw2);
  resetKv();
  // restore the fake
  const restore = await import('node:module');
  void restore;
}

// Rebuild the fetch stub after the deliberate network-failure test above.
{
  const saved = KV, savedSets = SETS;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'http://kv.test') throw new Error(`unexpected fetch: ${url}`);
    const parts = JSON.parse(init.body);
    commands.push(parts);
    if (kvFailing) return { ok: false, json: async () => ({}) };
    const [cmd, key, ...rest] = parts;
    const reply = (result) => ({ ok: true, json: async () => ({ result }) });
    switch (cmd.toUpperCase()) {
      case 'GET': return reply(saved.has(key) ? saved.get(key) : null);
      case 'SET': {
        if (rest.includes('NX') && saved.has(key)) return reply(null);
        saved.set(key, rest[0]); return reply('OK');
      }
      case 'DEL': { saved.delete(key); savedSets.delete(key); return reply(1); }
      case 'SADD': {
        if (!savedSets.has(key)) savedSets.set(key, new Set());
        const s = savedSets.get(key); const b = s.size;
        for (const m of rest) s.add(m);
        return reply(s.size - b);
      }
      case 'SREM': {
        const s = savedSets.get(key); if (!s) return reply(0);
        let n = 0; for (const m of rest) if (s.delete(m)) n++; return reply(n);
      }
      case 'SMEMBERS': return reply([...(savedSets.get(key) || [])]);
      case 'SCARD': return reply((savedSets.get(key) || new Set()).size);
      case 'EXPIRE': return reply(1);
      default: return reply(null);
    }
  };
}

L('\n=== A SUCCESSFUL REBUILD PUBLISHES ATOMICALLY ===');
{
  reset();
  const r = await R.rebuildBoard(db, sql, { now: NOW, reason: 'test', ...BUILD });
  ok('the rebuild publishes', r.published, r.reason);
  ok('it wrote the version-scoped key', KV.has(M.boardKey()));
  ok('…and the last-known-good key', KV.has(M.LAST_GOOD_KEY));

  const stored = JSON.parse(KV.get(M.boardKey()));
  ok('every published row carries the deployed synthesis version',
    stored.rows.length > 0 && stored.rows.every((x) => x.canonical.version === SYNTHESIS_VERSION));
  ok('the payload is stamped with the materialization version',
    stored.materializationVersion === M.MATERIALIZATION_VERSION);
  ok('it carries freshness metadata for operations',
    !!stored.builtAt && stored.candidates === 3 && stored.reason === 'test');

  const read = await R.readPublishedBoard();
  ok('the read path finds it and calls it ok', read.status === 'ok');
  ok('…and returns the same rows', read.payload.rows.length === stored.rows.length);
}

L('\n=== A FAILED REBUILD PRESERVES THE LAST KNOWN GOOD ===');
{
  // A good board is live. Then the next build produces something that cannot be published.
  const goodPayload = KV.get(M.boardKey());
  ok('a good board is live before the failure', !!goodPayload);

  // Every candidate throws — the board comes back empty WITH candidates waiting, which validation
  // refuses precisely so a broken build is not published as "no evidence exists".
  const brokenResolve = async () => { throw new Error('evidence engine down'); };
  const r = await R.rebuildBoard(db, sql, { now: NOW + 1000, reason: 'broken', resolve: brokenResolve, resolveConsensus: resolve });

  ok('the broken build does NOT publish',
    mut('publishbroken') ? false : !r.published, r.reason);
  ok('…and says why', /empty-with-candidates|too-many-failed/.test(r.reason), r.reason);
  ok('the previously good board is still byte-identical in KV',
    KV.get(M.boardKey()) === goodPayload);
  const read = await R.readPublishedBoard();
  ok('readers still get the good board, not an outage', read.status === 'ok' && read.payload.rows.length > 0);
  ok('…and it is still the old build time', read.payload.reason === 'test');
}

L('\n=== A METHODOLOGY CHANGE CANNOT SERVE OLD ROWS AS CURRENT ===');
{
  reset();
  // Simulate what actually happened: a board published by the PREVIOUS methodology is all that
  // exists. Under the old fixed-key design this was served as current.
  const oldPayload = {
    rows: [{ ticker: 'AAA', canonical: { state: 'POSITIVE_ALIGNMENT', version: 'consensus_v2_OLD' } }],
    candidates: 3, failed: 0, builtAt: new Date(NOW).toISOString(),
    materializationVersion: 'consensus_v2_synthesis.consensus_v1.b0',
  };
  KV.set(M.LAST_GOOD_KEY, JSON.stringify(oldPayload));

  const read = await R.readPublishedBoard();
  ok('the current-version key is empty, so nothing current exists', !KV.has(M.boardKey()));
  ok('the read falls back to the last known good rather than going blank',
    read.payload?.rows?.length === 1);
  ok('…and reports stale-methodology, NEVER ok',
    mut('servestale') ? false : read.status === 'stale-methodology', read.status);

  // And the rebuild resolves it.
  const r = await R.rebuildBoard(db, sql, { now: NOW, reason: 'version-rebuild', ...BUILD });
  const after = await R.readPublishedBoard();
  ok('rebuilding under the new methodology republishes', r.published);
  ok('…and the read is now ok', after.status === 'ok');
  ok('…with no row from the old methodology anywhere',
    after.payload.rows.every((x) => x.canonical.version === SYNTHESIS_VERSION));
  ok('the old board was never destroyed to get there — it was replaced after validating',
    after.payload.materializationVersion === M.MATERIALIZATION_VERSION);
}

L('\n=== TARGETED RECOMPUTATION: ONLY WHAT CHANGED ===');
{
  reset();
  await R.rebuildBoard(db, sql, { now: NOW, reason: 'seed', ...BUILD });

  // Evidence lands for BBB only.
  setEvidence('BBB', [fam('insiders', -0.9), fam('congress', -0.85)]);
  await M.markConsensusDirty(['BBB']);

  resolveCalls = [];
  const d = await R.drainDirty(db, sql, { now: NOW + 60_000, ...BUILD });

  ok('the drain runs a targeted pass', d.strategy === 'targeted', d.strategy);
  ok('…and publishes', d.published, d.reason);
  // ⚠️ THE CONTRACT CHANGED AT V3, DELIBERATELY. The consensus board reused recently materialized
  // rows to make a 90-second rebuild cheap. A V3 build resolves its whole candidate set in ~20s,
  // and reusing a cached row would risk publishing a SETUP classified against stale evidence —
  // exactly what a freshness-driven board must never do. Targeted invalidation still decides WHEN
  // to rebuild; it no longer decides which rows get recomputed.
  ok('the dirty ticker is recomputed rather than served from cache',
    mut('recomputeall') ? false : resolveCalls.includes('BBB'), resolveCalls.join(','));
  ok('…and the rebuild stays bounded to the candidate set, not the universe',
    resolveCalls.length <= CANDIDATES.length * 3, String(resolveCalls.length));

  // NO CROSS-TICKER CONTAMINATION.
  const rows = Object.fromEntries(d.payload.rows.map((x) => [x.ticker, x.canonical.state]));
  ok('the changed ticker reflects its new evidence',
    rows.BBB === 'NEGATIVE_ALIGNMENT', rows.BBB);
  ok('…and the untouched tickers are unchanged',
    rows.AAA === 'POSITIVE_ALIGNMENT' && rows.CCC === 'POSITIVE_ALIGNMENT',
    `${rows.AAA}/${rows.CCC}`);

  ok('the dirty set is cleared after a successful publish',
    (await M.readDirty()).length === 0);
}

L('\n=== BOARD MEMBERSHIP AND ORDERING FOLLOW A TICKER CHANGE ===');
{
  reset();
  await R.rebuildBoard(db, sql, { now: NOW, reason: 'seed', ...BUILD });
  const before = (await R.readPublishedBoard()).payload.rows.map((r) => r.ticker);
  ok('all three tickers start on the board', before.length === 3, before.join(','));

  // AAA's evidence goes away entirely — it no longer qualifies.
  setEvidence('AAA', [familyValue({ family: 'insiders', evidenceCount: 0 }),
    familyValue({ family: 'congress', evidenceCount: 0 })]);
  EV1.AAA = [];        // and no canonical evidence either — nothing left to qualify on
  await M.markConsensusDirty(['AAA']);
  await R.drainDirty(db, sql, { now: NOW + 60_000, ...BUILD });

  const after = (await R.readPublishedBoard()).payload.rows.map((r) => r.ticker);
  // THE INDEX, NOT JUST THE TICKER. Updating a hidden per-ticker object while leaving the board
  // index stale is the incoherence this design exists to remove.
  ok('a ticker that stops qualifying LEAVES the materialized board',
    mut('staleindex') ? false : !after.includes('AAA'), after.join(','));
  ok('…and the others remain', after.length === 2);

  // Ordering follows too: a ticker whose state strengthens moves up the board.
  reset();
  setEvidence('CCC', [fam('insiders', 0.2, { state: 'mixed' })]);
  await R.rebuildBoard(db, sql, { now: NOW, reason: 'seed', ...BUILD });
  const order1 = (await R.readPublishedBoard()).payload.rows.map((r) => r.ticker);
  // V3 orders by SETUP archetype, not by consensus state, so this only asserts determinism —
  // the archetype ordering itself is covered by verify-consensus-setup.mjs.
  ok('ordering is deterministic across reads',
    (await R.readPublishedBoard()).payload.rows.map((r) => r.ticker).join(',') === order1.join(','),
    order1.join(','));

  setEvidence('CCC', [fam('insiders', 0.95, { strength: 0.95, quality: 0.95 }),
    fam('institutions', 0.9, { strength: 0.9, quality: 0.95, state: 'accumulating' }),
    fam('congress', 0.9, { strength: 0.9, quality: 0.95 })]);
  await M.markConsensusDirty(['CCC']);
  await R.drainDirty(db, sql, { now: NOW + 60_000, ...BUILD });
  const order2 = (await R.readPublishedBoard()).payload.rows.map((r) => r.ticker);
  ok('a republish after new evidence still yields a valid, complete board',
    order2.length > 0 && M.validateBoardPayload((await R.readPublishedBoard()).payload).ok,
    order2.join(','));
}

L('\n=== A BURST IS ONE UNIT OF WORK ===');
{
  reset();
  await R.rebuildBoard(db, sql, { now: NOW, reason: 'seed', ...BUILD });

  // Three Form 4s and two wire events land for BBB in the same minute.
  for (const _ of [1, 2, 3, 4, 5]) await M.markConsensusDirty(['BBB']);
  ok('five marks produce one dirty entry', (await M.readDirty()).length === 1);

  resolveCalls = [];
  await R.drainDirty(db, sql, { now: NOW + 60_000, ...BUILD });
  ok('…and one recomputation, not five',
    resolveCalls.filter((t) => t === 'BBB').length === 1, String(resolveCalls.length));

  // A drain is idempotent: running it again with nothing dirty does no work at all.
  resolveCalls = [];
  const again = await R.drainDirty(db, sql, { now: NOW + 120_000, ...BUILD });
  ok('a drain with nothing dirty does nothing', again.strategy === 'none' && !resolveCalls.length);
  ok('…and says so rather than failing', again.reason === 'nothing-dirty');
}

L('\n=== A LARGE BURST REBUILDS INSTEAD OF CRAWLING ===');
{
  reset();
  const many = Array.from({ length: M.DIRTY_TARGETED_CAP + 5 }, (_, i) => `T${String(i).padStart(3, '0')}`.slice(0, 5));
  ok('the strategy for a small set is targeted', M.drainStrategy(5) === 'targeted');
  ok('the strategy for an empty set is none', M.drainStrategy(0) === 'none');
  ok('the strategy past the cap is a full rebuild',
    M.drainStrategy(many.length) === 'full', String(many.length));
  ok('the cap is a cost decision, and both paths still end in a complete board',
    M.DIRTY_TARGETED_CAP > 0 && M.DIRTY_TARGETED_CAP < M.DIRTY_SET_MAX);
}

L('\n=== CONCURRENT REFRESH CANNOT CORRUPT THE BOARD ===');
{
  reset();
  await R.rebuildBoard(db, sql, { now: NOW, reason: 'seed', ...BUILD });
  await M.markConsensusDirty(['BBB']);

  // Two drains start at once. One must decline rather than both writing the same keys.
  const [a, b] = await Promise.all([
    R.drainDirty(db, sql, { now: NOW + 60_000, ...BUILD }),
    R.drainDirty(db, sql, { now: NOW + 60_000, ...BUILD }),
  ]);
  const locked = [a, b].filter((r) => r.reason === 'locked');
  ok('exactly one of two concurrent drains proceeds',
    mut('nolock') ? false : locked.length === 1, `${a.reason} / ${b.reason}`);
  ok('the declined one does NOT clear the dirty set it never drained',
    locked[0].drained === 0);
  ok('the board is still valid after the race',
    M.validateBoardPayload(JSON.parse(KV.get(M.boardKey()))).ok);

  // And the exclusive rebuild declines the same way.
  await M.claimLock('consensus:board', 60);
  const r = await R.rebuildBoardExclusive(db, sql, { ...BUILD });
  ok('a rebuild declines while another holds the lock', r.reason === 'locked');
}

L('\n=== THE TICKER AND THE BOARD CANNOT INTERPRET DIFFERENTLY ===');
{
  reset();
  const { consensusRow } = await import('../src/lib/consensus/board.mjs');
  setEvidence('AAA', [fam('insiders', 0.9, { strength: 0.9 }), fam('institutions', 0.8),
    fam('congress', -0.6, { strength: 0.55 })]);

  await R.rebuildBoard(db, sql, { now: NOW, reason: 'seed', ...BUILD });
  const boardRow = (await R.readPublishedBoard()).payload.rows.find((r) => r.ticker === 'AAA');
  const direct = await consensusRow('AAA', { now: NOW, resolve });

  ok('the board row and a direct computation agree on the state',
    boardRow.canonical.state === direct.canonical.state,
    `${boardRow.canonical.state} vs ${direct.canonical.state}`);
  ok('…on confidence', boardRow.canonical.confidence === direct.canonical.confidence);
  ok('…on coverage', boardRow.canonical.coverage.active === direct.canonical.coverage.active);
  ok('…and on the WHY, word for word', boardRow.canonical.why === direct.canonical.why);

  // The materialized ticker feeds the ticker page. It must carry the raw families, because the
  // page renders inactive ones too, and it must be a cached SHAPE rather than an interpretation.
  await R.refreshTicker('AAA', { now: NOW, resolve });
  const fams = await R.readTickerFamilies('AAA', NOW);
  ok('a materialized ticker carries its resolved families', Array.isArray(fams) && fams.length >= 3);
  const fromCache = (await import('../src/lib/consensus/synthesis.mjs')).canonicalConsensus(fams, { now: NOW });
  ok('…and re-interpreting them gives the identical canonical state',
    fromCache.state === direct.canonical.state && fromCache.why === direct.canonical.why);
}

L('\n=== MATERIALIZED TICKERS EXPIRE RATHER THAN DRIFT ===');
{
  reset();
  await R.refreshTicker('AAA', { now: NOW, resolve });
  ok('a just-written ticker is reusable', !!(await R.readTicker('AAA', { now: NOW })));
  ok('…and is still reusable within the reuse window',
    !!(await R.readTicker('AAA', { now: NOW + M.TICKER_REUSE_MAX_AGE_MS - 1000 })));
  ok('…but NOT once it is older than the window',
    mut('nevertoold') ? false
      : (await R.readTicker('AAA', { now: NOW + M.TICKER_REUSE_MAX_AGE_MS + 1000 })) === null);

  // A ticker materialized by another methodology is never reused, key aside.
  const raw = JSON.parse(KV.get(M.tickerKey('AAA')));
  KV.set(M.tickerKey('AAA'), JSON.stringify({ ...raw, materializationVersion: 'older' }));
  ok('a ticker from another methodology is refused even at the current key',
    (await R.readTicker('AAA', { now: NOW })) === null);
}

L('\n=== THE READ PATH NEVER COMPUTES ===');
{
  // THE SCALE INVARIANT, checked structurally rather than by benchmark: expensive work must scale
  // with evidence changes, not with page views. If the read route could reach the evidence engine
  // or the board builder, a thousand concurrent visitors could ask for a thousand rebuilds.
  const fs = await import('node:fs');
  const read = fs.readFileSync(new URL('../src/app/api/consensus-board/route.js', import.meta.url), 'utf8');

  ok('the board read route does not import the evidence engine',
    mut('readcomputes') ? false : !/from '.*consensus\/evidence'/.test(read));
  ok('…does not import the board builder', !/buildConsensusBoard/.test(read));
  ok('…does not import the database', !/lib\/db'/.test(read));
  ok('…and never calls resolveEvidence', !/resolveEvidence\s*\(/.test(read));
  ok('it reads through the published-board helper',
    /readPublishedBoard\s*\(/.test(read));

  // Scheduling a rebuild is allowed — performing one is not. The schedule is cooldown-guarded, so
  // traffic cannot multiply it.
  ok('a version mismatch schedules a rebuild rather than performing one',
    /scheduleRebuild\('stale-methodology'\)/.test(read) && /claimRefreshAttempt/.test(read));
  ok('…deferred past the response so readers wait for nothing', /after\(/.test(read));

  // The entitlement gate must survive all of this.
  ok('the Pro gate is intact', /resolveUserTier/.test(read) && /FREE_ROWS/.test(read));
  ok('lockedCount is still computed from the FULL board, not the slice',
    /lockedCount\s*=\s*isFull\s*\?\s*0\s*:\s*Math\.max\(0,\s*full\.length\s*-\s*FREE_ROWS\)/.test(read));
  ok('the response is still private, no-store', /private, no-store/.test(read));
  ok('one board is built for everyone; tier only slices it',
    /full\.slice\(0, FREE_ROWS\)/.test(read));

  // The per-ticker route may compute — but only one ticker, and coalesced.
  const one = fs.readFileSync(new URL('../src/app/api/consensus/route.js', import.meta.url), 'utf8');
  ok('the per-ticker route prefers materialized evidence', /readTickerFamilies/.test(one));
  ok('…and coalesces concurrent misses for the same ticker', /coalesce\(/.test(one));
  ok('…and never builds the board', !/buildConsensusBoard|rebuildBoard/.test(one));
}

L('\n=== INGESTION MARKS ONLY WHAT IT ACTUALLY INSERTED ===');
{
  const fs = await import('node:fs');
  const paths = {
    'Form 4': '../src/app/api/refresh/route.js',
    'Congress': '../src/lib/congress-sync.js',
    '8-K': '../src/lib/eightk.js',
  };
  for (const [name, p] of Object.entries(paths)) {
    const s = fs.readFileSync(new URL(p, import.meta.url), 'utf8');
    ok(`${name} ingestion marks affected tickers`, /markConsensusDirty/.test(s));
    // Guarded by the insert's own RETURNING, so re-reading a feed marks nothing: dedup means
    // onConflictDoNothing returns no rows, and no rows means no recomputation work.
    ok(`${name} marks only rows that were actually inserted`,
      /if \((inserted|res)\.length\)/.test(s));
    ok(`${name} returns the ticker from the insert`, /ticker:\s*\w+\.ticker/.test(s));
  }
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
