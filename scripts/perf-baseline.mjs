// CRITICAL-ROUTE PERFORMANCE BASELINE — the repeatable before/after check.
//
//   node scripts/perf-baseline.mjs [--base https://www.catalystpit.com] [--runs 3] [--json out.json]
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
//
// Not a benchmark to win. A baseline to compare against, so a performance regression is noticed by
// a command rather than by a customer. Run it before a change and after, and diff.
//
// ── COLD AND WARM ARE MEASURED SEPARATELY ────────────────────────────────────
//
// A cached route measured warm tells you almost nothing about what a first visitor sees, and a cold
// number averaged together with warm ones hides both. The first request to each route is reported as
// COLD and excluded from the warm statistics.
//
// ── WHY MEDIAN, AND WHY p95 IS REPORTED BESIDE IT ────────────────────────────
//
// Mean latency over a handful of samples is dominated by whichever one hit a cold lambda. Median is
// what a typical request sees; p95 is what an unlucky one sees, and a route whose p95 is far from its
// median is unpredictable even when its average looks fine — which users feel as jank.
//
// ⚠️ THIS MEASURES OVER THE PUBLIC INTERNET. Absolute numbers include network latency from wherever
// it runs and are NOT suitable as a CI gate — asserting on them would produce a flaky build that
// teams learn to ignore. Use it for comparison, and keep deterministic budgets on server-side work.

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = String(argOf('base', 'https://www.catalystpit.com')).replace(/\/+$/, '');
const RUNS = Math.max(1, parseInt(argOf('runs', '3'), 10) || 3);
const JSON_OUT = argOf('json', '');

// The customer-facing surfaces and the APIs behind them. Kept short on purpose: a baseline nobody
// runs because it takes ten minutes is worth nothing.
const ROUTES = [
  ['page  homepage', '/'],
  ['page  screener', '/screener'],
  ['page  heatmap', '/heatmap'],
  ['page  insiders', '/insiders'],
  ['page  institutions', '/institutions'],
  ['page  congress', '/politicians'],
  ['page  ticker AAPL', '/ticker/AAPL'],
  ['api   market kv', '/api/market?key=pit_snapshot'],
  ['api   insiders', '/api/insiders?view=transactions&limit=25'],
  ['api   cluster buys', '/api/insiders?view=cluster_buys'],
  ['api   politicians', '/api/politicians?view=feed&limit=10'],
  ['api   screener', '/api/screener?limit=100'],
  ['api   heatmap', '/api/heatmap?top=500'],
  ['api   news', '/api/news'],
  ['api   quotes', '/api/quotes?symbols=SPY,QQQ,DIA,VIX'],
];

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const med = (xs) => pct(xs, 0.5);

async function timed(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
    const body = await r.arrayBuffer();          // include transfer, not just headers
    return { ms: Date.now() - t0, status: r.status, bytes: body.byteLength, cache: r.headers.get('x-vercel-cache') || r.headers.get('cf-cache-status') || '' };
  } catch (e) {
    return { ms: Date.now() - t0, status: 0, bytes: 0, cache: '', error: String(e.message).slice(0, 60) };
  }
}

console.log(`PERFORMANCE BASELINE — ${BASE}`);
console.log(`${RUNS} warm samples per route, after one cold request. ${new Date().toISOString()}\n`);
console.log('route                    cold    med    p95   size     status  cache');
console.log('─'.repeat(78));

const results = [];
for (const [label, path] of ROUTES) {
  const url = `${BASE}${path}`;
  const cold = await timed(url);
  const warm = [];
  for (let i = 0; i < RUNS; i++) warm.push(await timed(url));
  const ok = warm.filter((w) => w.status > 0);
  const times = ok.length ? ok.map((w) => w.ms) : [0];
  const row = {
    label, path, coldMs: cold.ms, medMs: med(times), p95Ms: pct(times, 0.95),
    bytes: ok[0]?.bytes ?? 0, status: cold.status, cache: ok[ok.length - 1]?.cache || cold.cache || '',
    error: cold.error || ok.find((w) => w.error)?.error || null,
  };
  results.push(row);
  const kb = row.bytes >= 1024 ? `${(row.bytes / 1024).toFixed(0)}KB` : `${row.bytes}B`;
  console.log(
    label.padEnd(24) +
    `${row.coldMs}`.padStart(5) + `${row.medMs}`.padStart(7) + `${row.p95Ms}`.padStart(7) +
    kb.padStart(8) + `${row.status}`.padStart(8) + '  ' + (row.cache || '-') +
    (row.error ? `  ERR ${row.error}` : ''));
}

console.log('\n─── slowest by median ───');
for (const r of [...results].sort((a, b) => b.medMs - a.medMs).slice(0, 6)) {
  console.log(`  ${r.label.padEnd(24)} ${r.medMs}ms   (cold ${r.coldMs}ms, p95 ${r.p95Ms}ms)`);
}

console.log('\n─── unpredictable (p95 more than 2x median, and median over 300ms) ───');
const jittery = results.filter((r) => r.medMs > 300 && r.p95Ms > r.medMs * 2);
if (!jittery.length) console.log('  none');
for (const r of jittery) console.log(`  ${r.label.padEnd(24)} med ${r.medMs}ms  p95 ${r.p95Ms}ms`);

console.log('\n─── heaviest payloads ───');
for (const r of [...results].sort((a, b) => b.bytes - a.bytes).slice(0, 5)) {
  console.log(`  ${r.label.padEnd(24)} ${(r.bytes / 1024).toFixed(0)}KB`);
}

if (JSON_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
  console.log(`\nwritten: ${JSON_OUT}`);
}
