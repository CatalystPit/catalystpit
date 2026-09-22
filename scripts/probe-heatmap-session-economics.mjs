// MEASURED TIINGO BEHAVIOUR FOR THE HEATMAP SNAPSHOT — inside and outside the session.
//
//   node --env-file=.env.local scripts/probe-heatmap-session-economics.mjs
//
// ⚠️ THIS COUNTS REAL REQUESTS THROUGH THE REAL STORE. Every other check in this change is a unit
// test or a simulation of the decision path; this one wraps global fetch, calls the production
// heatmapBoard, and reports how many times api.tiingo.com was actually contacted. A design that is
// correct in a simulation and still calls the provider overnight would pass everything else and
// fail here — which is the only reason to run it.
//
// The clock is moved via heatmapBoard's `now` seam, so the closed-market, weekend and holiday
// paths are exercised against the SAME code that serves production, not a copy of it.

// ⚠️ SET BEFORE THE FIRST IMPORT, AND THAT ORDER IS LOAD-BEARING. heatmap-realtime.mjs reads the
// namespace once at module load, so setting it after the import would silently leave this probe
// pointed at the production keys — which is the exact accident this exists to prevent. `.env.local`
// points at the SAME Upstash instance production uses.
process.env.CP_HEATMAP_KV_NAMESPACE = process.env.CP_HEATMAP_KV_NAMESPACE || 'probe';

const L = (s = '') => console.log(s);
const { heatmapBoard } = await import('../src/lib/heatmap/heatmap-store.js');
const { marketPhase } = await import('../src/lib/market/market-session.mjs');
const { kvNamespace, snapshotKey, lockKey, suspendKey } = await import('../src/lib/heatmap/heatmap-realtime.mjs');

// ⚠️ REFUSE TO RUN AT ALL IF THAT DID NOT TAKE. A probe that quietly falls back to production keys
// is worse than one that does not run: it rewrites the board real viewers are being served and
// reports success. Checked against the keys THEMSELVES rather than against the env var, because
// the env var being set is not the same fact as the keys being namespaced.
{
  const ns = kvNamespace();
  const keys = [snapshotKey(500), lockKey(500), suspendKey('2026-01-01')];
  const leaked = keys.filter((k) => !k.startsWith(`cp:hm:${ns}:`));
  if (!ns || leaked.length) {
    console.error('REFUSING TO RUN — not isolated from production Upstash keys.');
    console.error(`  namespace: ${ns || '(none)'}`);
    for (const k of keys) console.error(`  ${k}`);
    process.exit(2);
  }
  L(`kv namespace: ${ns}  (production keys are unreachable from this process)`);
}

// ── THE COUNTER ─────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let tiingo = 0, kvHits = 0;
globalThis.fetch = (...args) => {
  const url = String(args[0]?.url ?? args[0] ?? '');
  if (url.includes('api.tiingo.com')) tiingo += 1;
  else if (/upstash|kv\./i.test(url)) kvHits += 1;
  return realFetch(...args);
};
const measure = async (label, fn) => {
  const t = tiingo, k = kvHits, t0 = Date.now();
  const out = await fn();
  L(`  ${label.padEnd(52)} tiingo=${String(tiingo - t).padStart(3)}  kv=${String(kvHits - k).padStart(3)}  ${Date.now() - t0}ms`);
  return { out, tiingo: tiingo - t, kv: kvHits - k };
};

const LIMIT = 500;
const board = (now) => heatmapBoard({ timeframe: '1D', limit: LIMIT, realtime: true, now });

let fails = 0;
const expect = (label, cond, detail = '') => {
  if (cond) L(`  ok   ${label}`);
  else { fails++; L(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

L(`now: ${new Date().toISOString()}  phase: ${marketPhase().phase}  session: ${marketPhase().sessionDate}`);

L('\n=== 0. THE LOCK ACTUALLY LOCKS ===');
{
  // ⚠️ THIS SECTION EXISTS BECAUSE THE LOCK ONCE COULD NOT BE TAKEN AT ALL. The parameter was
  // `?NX=true`, which the REST API rejects as a syntax error; the helper returned null, the store
  // read that as "someone else is rebuilding", and so EVERY instance declined. The snapshot was
  // never written and the board silently served completed-session prices forever — with every
  // unit test passing, because the code said `acquireRebuildLock` in all the right places.
  //
  // An assertion about the SHAPE of the call could not have caught it. Only taking the lock can.
  const { acquireRebuildLock, lockKey, REBUILD_LOCK_SEC } = await import('../src/lib/heatmap/heatmap-realtime.mjs');
  const PROBE = 999_999;      // a universe size no board uses, so production locks are untouched
  const U = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const T = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const del = (k) => realFetch(`${U}/del/${encodeURIComponent(k)}`, { method: 'POST', headers: { Authorization: `Bearer ${T}` }, cache: 'no-store' });
  await del(lockKey(PROBE));
  const firstTake = await acquireRebuildLock(PROBE);
  const secondTake = await acquireRebuildLock(PROBE);
  const parallel = await Promise.all(Array.from({ length: 20 }, () => acquireRebuildLock(PROBE)));
  await del(lockKey(PROBE));
  expect('⚠️ the first caller WINS the lock (a permanently-failing lock never rebuilds)', firstTake === true);
  expect('…the second caller loses it', secondTake === false);
  expect('…and exactly one of 20 concurrent callers can hold it',
    parallel.filter(Boolean).length === 0, `${parallel.filter(Boolean).length} extra winners while held`);
  L(`  (lock ttl ${REBUILD_LOCK_SEC}s)`);
}

L('\n=== 1. DURING THE REGULAR SESSION ===');
const openNow = Date.now();
if (marketPhase(openNow).phase !== 'regular') {
  L('  (the market is closed right now — the in-session measurements below use a simulated');
  L('   in-session clock, which exercises the same code path but may rebuild against live quotes)');
}
const sessionClock = marketPhase(openNow).phase === 'regular'
  ? openNow
  : Date.parse('2026-09-22T16:00:00Z');   // 12:00 ET on a known trading Tuesday

const first = await measure('first load (may rebuild the snapshot)', () => board(sessionClock));
const repeats = [];
for (let i = 0; i < 5; i++) repeats.push(await measure(`repeat load #${i + 1} within the window`, () => board(sessionClock)));
const repeatTiingo = repeats.reduce((a, r) => a + r.tiingo, 0);
expect('⚠️ 5 repeat loads inside the 15-minute window cost ZERO Tiingo requests',
  repeatTiingo === 0, `${repeatTiingo} requests`);
expect('…and the board still carries live rows', first.out.rows.some((r) => r.live) || repeats.some((r) => r.out.rows.some((x) => x.live)));

L('\n  10 CONCURRENT VIEWERS:');
const before = tiingo;
const many = await Promise.all(Array.from({ length: 10 }, () => board(sessionClock)));
L(`  ${'10 parallel boards'.padEnd(52)} tiingo=${String(tiingo - before).padStart(3)}`);
expect('⚠️ 10 concurrent viewers do not cause 10 rebuilds', tiingo - before === 0, `${tiingo - before} requests`);
expect('…and all ten agree on the snapshot instant',
  new Set(many.map((b) => b.snapshotAt)).size === 1, [...new Set(many.map((b) => b.snapshotAt))].join(' | '));

L('\n=== 2. OUTSIDE THE REGULAR SESSION — THE NEW REQUIREMENT ===');
const CLOSED = [
  ['after the close   (Tue 17:00 ET)', '2026-09-22T21:00:00Z'],
  ['late evening      (Tue 23:00 ET)', '2026-09-23T03:00:00Z'],
  ['overnight         (Wed 03:00 ET)', '2026-09-23T07:00:00Z'],
  ['pre-market        (Wed 08:00 ET)', '2026-09-23T12:00:00Z'],
  ['Saturday          (Sat 12:00 ET)', '2026-09-19T16:00:00Z'],
  ['Sunday            (Sun 12:00 ET)', '2026-09-20T16:00:00Z'],
  ['Thanksgiving      (Thu 12:00 ET)', '2026-11-26T17:00:00Z'],
  ['Good Friday       (Fri 12:00 ET)', '2026-04-03T16:00:00Z'],
  ['MLK Day           (Mon 12:00 ET)', '2026-01-19T17:00:00Z'],
  ['half-day, 14:00ET (Fri, closed)  ', '2026-11-27T19:00:00Z'],
];
let closedTotal = 0;
for (const [label, iso] of CLOSED) {
  const r = await measure(label, () => board(Date.parse(iso)));
  closedTotal += r.tiingo;
}
expect('⚠️ every closed-market clock produces ZERO realtime Tiingo requests',
  closedTotal === 0, `${closedTotal} requests`);

L('\n  CONCURRENT AFTER-HOURS TRAFFIC:');
const b2 = tiingo;
await Promise.all(Array.from({ length: 25 }, () => board(Date.parse('2026-09-23T03:00:00Z'))));
L(`  ${'25 parallel overnight boards'.padEnd(52)} tiingo=${String(tiingo - b2).padStart(3)}`);
expect('⚠️ 25 concurrent overnight viewers produce ZERO Tiingo requests', tiingo - b2 === 0, `${tiingo - b2}`);

const b3 = tiingo;
await Promise.all(Array.from({ length: 25 }, () => board(Date.parse('2026-09-19T16:00:00Z'))));
L(`  ${'25 parallel Saturday boards'.padEnd(52)} tiingo=${String(tiingo - b3).padStart(3)}`);
expect('⚠️ 25 concurrent weekend viewers produce ZERO Tiingo requests', tiingo - b3 === 0, `${tiingo - b3}`);

const b4 = tiingo;
await Promise.all(Array.from({ length: 25 }, () => board(Date.parse('2026-11-26T17:00:00Z'))));
L(`  ${'25 parallel market-holiday boards'.padEnd(52)} tiingo=${String(tiingo - b4).padStart(3)}`);
expect('⚠️ 25 concurrent holiday viewers produce ZERO Tiingo requests', tiingo - b4 === 0, `${tiingo - b4}`);

L('\n=== 3. WHAT THE CLOSED BOARD ACTUALLY SAYS ===');
for (const [label, iso] of CLOSED.slice(0, 4)) {
  const b = await board(Date.parse(iso));
  const live = b.rows.filter((r) => r.live).length;
  L(`  ${label}  phase=${b.session?.phase}  frozen=${b.session?.frozen}  final=${b.session?.final}  sessionDate=${b.session?.sessionDate}  liveRows=${live}`);
  expect(`  …${label.trim()} is not labelled as an open session`, b.session?.phase === 'closed');
}

L('\n=== 4. COVERAGE: HOW MUCH OF THE BOARD IS ACTUALLY LIVE ===');
{
  const b = await board(sessionClock);
  const live = b.rows.filter((r) => r.live).length;
  L(`  ${live} of ${b.rows.length} rows carry a snapshot price (${((live / b.rows.length) * 100).toFixed(0)}%)`);
  // ⚠️ THE BOARD CLAIMS TO BE A MARKET SNAPSHOT, SO MOST OF IT HAD BETTER BE ONE. Before the
  // chunking fix this read 98/500 — the strip said "market snapshot" over a board that was 80%
  // completed-session closes. Not every symbol will quote (thin names, halts), so this is a
  // coverage floor rather than a demand for 100%.
  expect('⚠️ the great majority of the board is a live snapshot, not 100 rows of 500',
    live > b.rows.length * 0.75, `${live}/${b.rows.length}`);
}

L('\n=== 5. THE NUMBERS ===');
{
  const b = await board(sessionClock);
  const { getQuotes } = await import('../src/lib/market-data.js');
  const syms = ['NVDA', 'AAPL', 'MSFT'].filter((s) => b.rows.some((r) => r.ticker === s));
  const q = await getQuotes(syms, { realtime: true });

  // ⚠️ TWO DIFFERENT QUESTIONS, AND CONFLATING THEM PRODUCED A FALSE FAILURE ON THE FIRST RUN.
  //
  //   (a) ARITHMETIC — is the tile's % exactly (its own price − previous close) / previous close?
  //       This must hold to floating-point precision. It is the bug that shipped once already,
  //       when the numerator moved to a live price and the denominator stayed on an older close.
  //
  //   (b) DRIFT — how far is the snapshot from a quote taken right now? By DESIGN this is
  //       non-zero: the board is refreshed every 15 minutes, so the price legitimately moved
  //       since capture. Asserting it near zero would be asserting that the feature does not
  //       work the way it is specified to. Reported, and bounded only loosely as a sanity check.
  L(`  ${'ticker'.padEnd(7)}|${'board %'.padStart(9)} |${'own calc'.padStart(9)} |${'spot now'.padStart(9)} | drift`);
  for (const s of syms) {
    const row = b.rows.find((r) => r.ticker === s);
    const quote = q[s];
    const spot = quote?.price != null && quote?.prevClose ? ((quote.price - quote.prevClose) / quote.prevClose) * 100 : null;
    // The board states what it measured from; recompute the tile from its own two numbers.
    const base = quote?.prevClose ?? null;
    const recomputed = row?.price != null && base ? ((row.price - base) / base) * 100 : null;
    const arithmetic = row?.pct != null && recomputed != null ? Math.abs(row.pct - recomputed) : null;
    const drift = row?.pct != null && spot != null ? Math.abs(row.pct - spot) : null;
    L(`  ${s.padEnd(7)}|${(row?.pct?.toFixed(3) ?? '—').padStart(9)} |${(recomputed?.toFixed(3) ?? '—').padStart(9)} |${(spot?.toFixed(3) ?? '—').padStart(9)} | ${drift?.toFixed(3) ?? '—'}pp`);
    if (arithmetic != null) {
      expect(`  ${s}: the tile equals (its price − prev close) / prev close`,
        arithmetic < 1e-9, arithmetic.toExponential(2));
    }
    if (drift != null) {
      expect(`  ${s}: drift from a spot quote is within a 15-minute move`, drift < 2, `${drift}pp`);
    }
  }
}

L(`\ntotal tiingo requests this run: ${tiingo}`);
L(`${fails ? `${fails} FAILED` : 'all measurements as expected'}`);
process.exit(fails ? 1 : 0);
