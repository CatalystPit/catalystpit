// MEASURED UPSTREAM COST OF THE FREE DELAYED ARCHITECTURE.
//
//   CP_HEATMAP_KV_NAMESPACE=probe TIINGO_REALTIME_ENABLED=true node --env-file=.env.local \
//     --experimental-loader ./scripts/ext-resolve-loader.mjs scripts/probe-delayed-economics.mjs
//
// Wraps global fetch and calls the production collector, so every number below is a request that
// actually left the building.

process.env.CP_HEATMAP_KV_NAMESPACE = process.env.CP_HEATMAP_KV_NAMESPACE || 'probe';

const L = (s = '') => console.log(s);
const D = await import('../src/lib/market/delayed-store.mjs');
const { marketPhase } = await import('../src/lib/market/market-session.mjs');
if (!D.kvNamespace()) { console.error('REFUSING — not isolated from production keys'); process.exit(2); }
L(`kv namespace: ${D.kvNamespace()}  (production delayed keys unreachable)`);

const realFetch = globalThis.fetch;
let tiingo = 0, bytes = 0;
globalThis.fetch = async (...a) => {
  const u = String(a[0]?.url ?? a[0] ?? '');
  const r = await realFetch(...a);
  if (u.includes('api.tiingo.com')) { tiingo += 1; const c = r.clone(); bytes += (await c.arrayBuffer()).byteLength; }
  return r;
};
let fails = 0;
const expect = (l, c, d = '') => { if (c) L(`  ok   ${l}`); else { fails++; L(`  FAIL ${l}${d ? ' — ' + d : ''}`); } };

const U = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const T = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const del = (k) => realFetch(`${U}/del/${encodeURIComponent(k)}`, { method: 'POST', headers: { Authorization: `Bearer ${T}` }, cache: 'no-store' });

L(`\nnow: ${new Date().toISOString()}  phase: ${marketPhase().phase}`);

L('\n=== 1. ONE CAPTURE COSTS ONE REQUEST ===');
for (const k of [D.latestKey(), D.releasedKey(), D.lockKey()]) await del(k);
const t0 = Date.now(); const before = tiingo;
const cap = await D.captureIfDue({ force: true });
L(`  captured=${cap.captured} reason=${cap.reason} kept=${cap.kept}/${cap.considered} in ${Date.now() - t0}ms`);
L(`  snapshot size: ${(cap.bytes / 1024).toFixed(0)}KB   upstream response: ${(bytes / 1048576).toFixed(2)}MB`);
expect('⚠️ a full-market capture is ONE Tiingo request', tiingo - before === 1, `${tiingo - before}`);
const perCapture = { requests: 1, responseBytes: bytes };

L('\n=== 2. VIEWER COUNT DOES NOT MULTIPLY UPSTREAM USAGE ===');
for (const n of [1, 100, 1000]) {
  await del(D.lockKey());                       // a fresh window; the interval gate still applies
  const b = tiingo;
  await Promise.all(Array.from({ length: n }, () => D.captureIfDue()));
  L(`  ${String(n).padStart(4)} simultaneous Free viewers  ->  ${tiingo - b} Tiingo request(s)`);
  expect(`⚠️ ${n} viewers add ZERO requests inside the window`, tiingo - b === 0, `${tiingo - b}`);
}

L('\n=== 3. OUTSIDE THE BELLS THE COLLECTOR DOES NOT RUN ===');
for (const [label, iso] of [
  ['after the close  (Tue 16:15 ET)', '2026-09-22T20:15:00Z'],
  ['after-hours      (Tue 18:00 ET)', '2026-09-22T22:00:00Z'],
  ['overnight        (Wed 03:00 ET)', '2026-09-23T07:00:00Z'],
  ['premarket        (Wed 08:00 ET)', '2026-09-23T12:00:00Z'],
  ['Saturday         (Sat 12:00 ET)', '2026-09-19T16:00:00Z'],
  ['Sunday           (Sun 12:00 ET)', '2026-09-20T16:00:00Z'],
  ['Thanksgiving     (Thu 12:00 ET)', '2026-11-26T17:00:00Z'],
  ['half-day 14:00ET (past 13:00)  ', '2026-11-27T19:00:00Z'],
]) {
  const b = tiingo;
  // Forced AND concurrent — if anything could get through the session gate, this is where.
  await Promise.all(Array.from({ length: 25 }, () => D.captureIfDue({ now: Date.parse(iso), force: true })));
  L(`  ${label}  25 forced viewers -> ${tiingo - b} request(s)`);
  expect(`  ⚠️ ${label.trim()} costs ZERO`, tiingo - b === 0, `${tiingo - b}`);
}

L('\n=== 4. THE RELEASED SNAPSHOT IS GENUINELY BEHIND ===');
{
  const released = await D.readDelayed();
  if (!released) {
    L('  (nothing released yet — a second capture 15 minutes after the first promotes one)');
    expect('a viewer with no released snapshot gets NOTHING delayed, not something fresh', released === null);
  } else {
    const age = D.snapshotAgeMs(released) / 60000;
    L(`  released snapshot is ${age.toFixed(1)} minutes old, ${released.count} symbols`);
    expect('⚠️ it is at least 15 minutes behind', age >= 15, `${age.toFixed(1)}min`);
  }
  // The fresh capture must NOT be readable by a Free viewer.
  const latestRaw = await realFetch(`${U}/get/${encodeURIComponent(D.latestKey())}`,
    { method: 'POST', headers: { Authorization: `Bearer ${T}` }, cache: 'no-store' }).then((r) => r.json());
  const latest = latestRaw?.result ? JSON.parse(latestRaw.result) : null;
  expect('a capture exists', Boolean(latest));
  expect('⚠️ and the FRESH capture is refused to Free', latest ? D.servableToFree(latest) === false : false,
    latest ? `${(D.snapshotAgeMs(latest) / 60000).toFixed(1)}min old` : 'none');
}

L('\n=== PROJECTED COST ===');
{
  // 09:30–16:00 is 390 minutes; a 15-minute cadence is 26 captures on a full session.
  const perDay = 26, perMonth = perDay * 21;
  const mb = perCapture.responseBytes / 1048576;
  L(`  requests per capture        : ${perCapture.requests}`);
  L(`  captures per hour           : 4`);
  L(`  requests/hour (Free arch)   : 4        of 30,000 budget = ${(4 / 30000 * 100).toFixed(3)}%`);
  L(`  requests per trading day    : ${perDay}       of 400,000 budget = ${(perDay / 400000 * 100).toFixed(3)}%`);
  L(`  requests per month (21d)    : ${perMonth}`);
  L(`  bytes per capture           : ${mb.toFixed(2)}MB`);
  L(`  bandwidth per trading day   : ${(mb * perDay / 1024).toFixed(2)}GB`);
  L(`  bandwidth per month (21d)   : ${(mb * perMonth / 1024).toFixed(2)}GB   of 1,000GB = ${(mb * perMonth / 1024 / 1000 * 100).toFixed(2)}%`);
}

L(`\ntotal tiingo requests this run: ${tiingo}`);
L(fails ? `${fails} FAILED` : 'all measurements as expected');
process.exit(fails ? 1 : 0);
