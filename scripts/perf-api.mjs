// API TIMINGS — cold and warm, against production. Measure before changing anything.
//
//   node scripts/perf-api.mjs [--runs 3] [--base https://www.catalystpit.com]
//
// ⚠️ COLD AND WARM ARE DIFFERENT PRODUCTS. A serverless route that takes 12s on its first call and
// 200ms afterwards has a cold-start problem; one that takes 3s every time has a query problem. They
// need opposite fixes, so the first call is reported separately and never averaged into the rest.
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'https://www.catalystpit.com');
const RUNS = Number(arg('runs', 3));

const ENDPOINTS = [
  ['/api/quotes?symbols=AAPL,MSFT,NVDA,TSLA,SPY', 'quotes (homepage tape)'],
  ['/api/movers', 'movers'],
  ['/api/market-movers', 'market movers'],
  ['/api/market-breadth', 'market breadth'],
  ['/api/news?limit=20', 'news'],
  ['/api/consensus-board', 'consensus board'],
  ['/api/insiders?view=rows&limit=25', 'insiders rows'],
  ['/api/congress-trades?limit=25', 'congress trades'],
  ['/api/politicians?limit=25', 'politicians'],
  ['/api/institutions?limit=25', 'institutions'],
  ['/api/chart-daily?ticker=AAPL&range=1Y', 'chart daily 1Y'],
  ['/api/chart-intraday?ticker=AAPL&range=1D', 'chart intraday 1D'],
  ['/api/bulls-bears?ticker=AAPL', 'bulls & bears'],
  ['/api/structure?ticker=AAPL', 'structure'],
  ['/api/confluence?ticker=AAPL', 'confluence (ticker)'],
  ['/api/heatmap/performance?range=1D', 'heatmap performance'],
  ['/api/screener?limit=50', 'screener'],
  ['/api/me/plan', 'me/plan'],
  ['/api/health', 'health'],
];

const time = async (path) => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}${path}`, { headers: { 'cache-control': 'no-cache' } });
    const buf = await r.arrayBuffer();
    return { ms: Date.now() - t0, status: r.status, bytes: buf.byteLength,
      cache: r.headers.get('x-vercel-cache') || r.headers.get('cf-cache-status') || '-' };
  } catch (e) { return { ms: Date.now() - t0, status: 0, bytes: 0, cache: '-', err: e.message }; }
};

console.log(`base ${BASE} · ${RUNS} warm runs each\n`);
console.log('endpoint                          cold      warm(min/med)   status  bytes    cache');
const rows = [];
for (const [path, label] of ENDPOINTS) {
  const cold = await time(path);
  const warm = [];
  for (let i = 0; i < RUNS; i++) warm.push(await time(path));
  const ok = warm.filter((w) => w.status === 200).map((w) => w.ms).sort((a, b) => a - b);
  const min = ok[0] ?? null;
  const med = ok.length ? ok[Math.floor(ok.length / 2)] : null;
  const last = warm[warm.length - 1];
  rows.push({ label, path, cold: cold.ms, coldStatus: cold.status, min, med, status: last.status, bytes: last.bytes, cache: last.cache });
  const flag = (med == null || med > 1500) ? ' ⚠️' : (med > 500 ? ' ·' : '');
  console.log(
    label.padEnd(32)
    + String(cold.ms + 'ms').padStart(8)
    + String(`${min ?? '—'}/${med ?? '—'}ms`).padStart(16)
    + String(last.status).padStart(8)
    + String(last.bytes > 1024 ? Math.round(last.bytes / 1024) + 'kb' : last.bytes + 'b').padStart(9)
    + String(last.cache).padStart(8) + flag,
  );
}
console.log('\nslowest warm (median):');
for (const r of [...rows].filter((r) => r.med != null).sort((a, b) => b.med - a.med).slice(0, 8)) {
  console.log(`  ${String(r.med + 'ms').padStart(8)}  ${r.label}`);
}
const broken = rows.filter((r) => r.status !== 200);
if (broken.length) console.log(`\nnon-200: ${broken.map((r) => `${r.label}=${r.status}`).join(', ')}`);
