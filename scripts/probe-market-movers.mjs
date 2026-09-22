// MEASURED TIINGO BEHAVIOUR FOR THE MARKET-WIDE MOVERS.
//
//   CP_HEATMAP_KV_NAMESPACE=probe TIINGO_REALTIME_ENABLED=true node --env-file=.env.local \
//     --experimental-loader ./scripts/ext-resolve-loader.mjs scripts/probe-market-movers.mjs
//
// Wraps global fetch and calls the production marketMovers(), so the request counts below are what
// actually left the building rather than what the code looks like it would do.

process.env.CP_HEATMAP_KV_NAMESPACE = process.env.CP_HEATMAP_KV_NAMESPACE || 'probe';

const L = (s = '') => console.log(s);
const M = await import('../src/lib/movers/movers-store.js');
const { marketPhase } = await import('../src/lib/market/market-session.mjs');
if (!M.kvNamespace()) { console.error('REFUSING TO RUN — not isolated from production keys'); process.exit(2); }
L(`kv namespace: ${M.kvNamespace()}  (production movers keys unreachable)`);

const realFetch = globalThis.fetch;
let tiingo = 0;
globalThis.fetch = (...a) => {
  const u = String(a[0]?.url ?? a[0] ?? '');
  if (u.includes('api.tiingo.com')) tiingo += 1;
  return realFetch(...a);
};
let fails = 0;
const expect = (l, c, d = '') => { if (c) L(`  ok   ${l}`); else { fails++; L(`  FAIL ${l}${d ? ' — ' + d : ''}`); } };
const measure = async (label, fn) => {
  const t = tiingo, t0 = Date.now();
  const out = await fn();
  L(`  ${label.padEnd(46)} tiingo=${String(tiingo - t).padStart(2)}  ${Date.now() - t0}ms`);
  return { out, calls: tiingo - t };
};

const movers = (now, realtime = true) => M.marketMovers({ realtime, limit: 10, now });

L(`\nnow: ${new Date().toISOString()}  phase: ${marketPhase().phase}`);

L('\n=== 1. DURING THE REGULAR SESSION ===');
const openNow = marketPhase().phase === 'regular' ? Date.now() : Date.parse('2026-09-22T16:00:00Z');

// ⚠️ CLEAR THE PROBE'S OWN SNAPSHOT SO THE FIRST LOAD REALLY REBUILDS. Without this the run
// inherits whatever a previous probe left behind and measures a cache hit while claiming to
// measure a rebuild — which is exactly how a "0 upstream requests" result can look like success
// and mean nothing. Only the probe namespace is touched; production keys are unreachable here.
{
  const U = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const T = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  for (const k of [M.snapshotKey(), M.lockKey()]) {
    await realFetch(`${U}/del/${encodeURIComponent(k)}`, { method: 'POST', headers: { Authorization: `Bearer ${T}` }, cache: 'no-store' });
  }
  L(`  (cleared ${M.snapshotKey()} and ${M.lockKey()})`);
}
const first = await measure('first load (rebuilds the shared snapshot)', () => movers(openNow));
L(`     ranked ${first.out.universeCount} of ${first.out.counts?.considered} · baseline ${first.out.baselineDate} · ${first.out.freshness}`);
expect('⚠️ ONE Tiingo request rebuilds the ENTIRE market', first.calls === 1, `${first.calls}`);

let repeats = 0;
for (let i = 0; i < 5; i++) repeats += (await measure(`repeat load #${i + 1}`, () => movers(openNow))).calls;
expect('⚠️ 5 repeat loads inside the window cost ZERO', repeats === 0, `${repeats}`);

const b = tiingo;
const many = await Promise.all(Array.from({ length: 25 }, () => movers(openNow)));
L(`  ${'25 concurrent viewers'.padEnd(46)} tiingo=${String(tiingo - b).padStart(2)}`);
expect('⚠️ 25 concurrent viewers do not cause 25 rebuilds', tiingo - b === 0, `${tiingo - b}`);
expect('…and all see the same snapshot instant', new Set(many.map((m) => m.snapshotAt)).size === 1);
expect('…and the identical ranking',
  new Set(many.map((m) => m.gainers.map((g) => g.ticker).join(','))).size === 1);

L('\n=== 2. OUTSIDE THE REGULAR SESSION — ZERO UPSTREAM ===');
let closed = 0;
for (const [label, iso] of [
  ['after the close  (Tue 17:00 ET)', '2026-09-22T21:00:00Z'],
  ['overnight        (Wed 03:00 ET)', '2026-09-23T07:00:00Z'],
  ['pre-market       (Wed 08:00 ET)', '2026-09-23T12:00:00Z'],
  ['Saturday         (Sat 12:00 ET)', '2026-09-19T16:00:00Z'],
  ['Sunday           (Sun 12:00 ET)', '2026-09-20T16:00:00Z'],
  ['Thanksgiving     (Thu 12:00 ET)', '2026-11-26T17:00:00Z'],
  ['Good Friday      (Fri 12:00 ET)', '2026-04-03T16:00:00Z'],
  ['half-day 14:00ET (Fri, closed)  ', '2026-11-27T19:00:00Z'],
]) {
  const r = await measure(label, () => movers(Date.parse(iso)));
  closed += r.calls;
  if (label.startsWith('after the close')) {
    expect('  …the after-close list is frozen or final, never "updating"',
      r.out.session?.frozen === true || r.out.session?.final === true,
      JSON.stringify(r.out.session));
  }
}
expect('⚠️ every closed-market clock costs ZERO Tiingo requests', closed === 0, `${closed}`);

const b2 = tiingo;
await Promise.all(Array.from({ length: 30 }, () => movers(Date.parse('2026-09-20T16:00:00Z'))));
L(`  ${'30 concurrent weekend viewers'.padEnd(46)} tiingo=${String(tiingo - b2).padStart(2)}`);
expect('⚠️ 30 concurrent weekend viewers cost ZERO', tiingo - b2 === 0, `${tiingo - b2}`);

L('\n=== 3. FREE NEVER TOUCHES THE REALTIME PATH ===');
const b3 = tiingo;
const free = await measure('unentitled caller, market open', () => movers(openNow, false));
expect('⚠️ a Free caller costs ZERO Tiingo requests', tiingo - b3 === 0, `${tiingo - b3}`);
expect('⚠️ …and is never labelled realtime', free.out.freshness === 'eod', String(free.out.freshness));
expect('…but still gets a usable market-wide list', free.out.gainers.length > 0);
expect('…measured between two completed sessions',
  Boolean(free.out.baselineDate && free.out.asOf && free.out.baselineDate < free.out.asOf),
  `${free.out.baselineDate} → ${free.out.asOf}`);
expect('⚠️ the Free list carries no realtime snapshot timestamp', free.out.snapshotAt == null);

L('\n=== 4. THE NUMBERS, VERIFIED AGAINST TIINGO DIRECTLY ===');
{
  const r = await movers(openNow);
  const syms = r.gainers.slice(0, 5).map((g) => g.ticker);
  const KEY = process.env.TIINGO_API_KEY;
  const q = await realFetch(`https://api.tiingo.com/iex/?tickers=${syms.join(',')}&token=${KEY}`,
    { headers: { Authorization: `Token ${KEY}` } }).then((x) => x.json());
  const byT = new Map(q.map((x) => [String(x.ticker).toUpperCase(), x]));
  L(`  ${'TICKER'.padEnd(8)}${'DISPLAYED %'.padStart(12)}${'PREV CLOSE'.padStart(12)}${'SPOT NOW'.padStart(10)}${'RECALC %'.padStart(10)}  BASELINE`);
  for (const g of r.gainers.slice(0, 5)) {
    const spot = byT.get(g.ticker)?.tngoLast;
    const recalc = spot != null ? ((spot - g.prevClose) / g.prevClose) * 100 : null;
    L(`  ${g.ticker.padEnd(8)}${g.pct.toFixed(2).padStart(12)}${String(g.prevClose).padStart(12)}${String(spot ?? '—').padStart(10)}${(recalc?.toFixed(2) ?? '—').padStart(10)}  ${g.baselineDate}`);
    expect(`  ${g.ticker}: displayed % = (its price − its baseline) / baseline`,
      Math.abs(g.pct - ((g.price - g.prevClose) / g.prevClose) * 100) < 1e-9);
  }
  expect('⚠️ every ranked row shares ONE baseline date',
    new Set([...r.gainers, ...r.losers].map((x) => x.baselineDate)).size === 1);
}

L(`\ntotal tiingo requests this run: ${tiingo}`);
L(fails ? `${fails} FAILED` : 'all measurements as expected');
process.exit(fails ? 1 : 0);
