// Probe: Polygon intraday aggregates (Stocks Starter tier).
// Run: node --env-file=.env.local scripts/probe-polygon.mjs
const KEY = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY;
if (!KEY) { console.error('POLYGON_API_KEY / POLYGON_KEY missing — add it to .env.local'); process.exit(1); }

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date();
const daysAgo = (n) => ymd(new Date(today.getTime() - n * 864e5));

// case: human label, multiplier, timespan, from, to  (mirrors planned 1D=5min, 5D=15min)
const cases = [
  { label: '1D (5-min bars, last ~4 calendar days)', mult: 5, span: 'minute', from: daysAgo(4), to: daysAgo(0) },
  { label: '5D (15-min bars, last ~8 calendar days)', mult: 15, span: 'minute', from: daysAgo(8), to: daysAgo(0) },
];

async function probe(ticker, c) {
  const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/${c.mult}/${c.span}/${c.from}/${c.to}`
    + `?adjusted=true&sort=asc&limit=50000&apiKey=${KEY}`;
  const t0 = Date.now();
  const r = await fetch(url);
  const ms = Date.now() - t0;
  const body = await r.text();
  console.log(`\n===== ${ticker} | ${c.label} =====  HTTP ${r.status}  (${ms}ms)`);
  let data;
  try { data = JSON.parse(body); } catch { console.log('non-JSON:', body.slice(0, 500)); return; }
  // print top-level shape minus the bulky results array
  const { results, ...meta } = data;
  console.log('top-level keys:', Object.keys(data).join(', '));
  console.log('meta:', JSON.stringify(meta));
  if (Array.isArray(results)) {
    console.log('results count:', results.length);
    if (results.length) {
      console.log('keys on results[0]:', Object.keys(results[0]).join(', '));
      const fmt = (b) => ({ ...b, t_iso: new Date(b.t).toISOString() });
      console.log('first bar:', JSON.stringify(fmt(results[0])));
      console.log('last  bar:', JSON.stringify(fmt(results[results.length - 1])));
    }
  } else {
    console.log('no results array. full body:', body.slice(0, 500));
  }
}

for (const t of ['AAPL', 'STT']) {
  for (const c of cases) {
    try { await probe(t, c); } catch (e) { console.log(`${t} ${c.label} threw:`, e.message); }
  }
}
