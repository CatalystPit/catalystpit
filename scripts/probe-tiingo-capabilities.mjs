// WHAT THIS TIINGO ACCOUNT CAN ACTUALLY DO — the capability matrix, from real responses.
//
//   node --env-file=.env.local scripts/probe-tiingo-capabilities.mjs
//
// Every Catalyst Pit requirement is classified PASS / PARTIAL / UNAVAILABLE / ENTITLEMENT REQUIRED
// from an actual HTTP response, never from documentation and never from assumption. An endpoint that
// 403s because the plan excludes it and an endpoint that 404s because the symbol is wrong are
// different answers, and building on the wrong one wastes a sprint.
//
// DELIBERATELY GENTLE. A handful of symbols, one request at a time, paced. The point is to learn the
// shape of what we can have, not to exercise the rate limiter — and an account that gets throttled
// during discovery tells us nothing except that we were rude.

const KEY = process.env.TIINGO_API_KEY;
if (!KEY) { console.error('TIINGO_API_KEY missing — cannot probe'); process.exit(1); }

const H = { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const daysAgo = (n) => ymd(new Date(today.getTime() - n * 864e5));

let calls = 0;
async function get(url, label) {
  await sleep(350);                       // ~3/s, well under any documented limit
  calls += 1;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: H });
    const ms = Date.now() - t0;
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep raw */ }
    return { ok: r.ok, status: r.status, ms, json, raw: text.slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, json: null, raw: String(e.message).slice(0, 120) };
  }
}

// PASS / PARTIAL / UNAVAILABLE / ENTITLEMENT REQUIRED — decided from the response, not from hope.
const results = [];
function classify(name, res, { needs = [], note = '' } = {}) {
  let verdict;
  if (res.status === 401) verdict = 'AUTH FAILED';
  else if (res.status === 403) verdict = 'ENTITLEMENT REQUIRED';
  else if (res.status === 404) verdict = 'UNAVAILABLE';
  else if (!res.ok) verdict = `UNAVAILABLE (HTTP ${res.status})`;
  else {
    const body = res.json;
    const empty = body == null || (Array.isArray(body) && body.length === 0);
    if (empty) verdict = 'UNAVAILABLE (empty)';
    else {
      const sample = Array.isArray(body) ? body[0] : body;
      const missing = needs.filter((f) => sample == null || sample[f] === undefined);
      verdict = missing.length ? `PARTIAL (missing: ${missing.join(', ')})` : 'PASS';
    }
  }
  results.push({ name, verdict, status: res.status, ms: res.ms, note });
  console.log(`  ${verdict.padEnd(34)} ${name}  [HTTP ${res.status}, ${res.ms}ms]${note ? '  — ' + note : ''}`);
  return verdict;
}

console.log('TIINGO CAPABILITY PROBE');
console.log(`token: ...${String(KEY).slice(-4)}   ${new Date().toISOString()}\n`);

// ── 1. AUTH + ACCOUNT ────────────────────────────────────────────────────────
console.log('AUTH / ACCOUNT');
const acct = await get('https://api.tiingo.com/api/test', 'auth');
classify('authentication', acct);
if (acct.status === 401) { console.error('\nToken rejected — everything below would be noise. Stopping.'); process.exit(1); }

// ── 2. SECURITY / SYMBOL MASTER ──────────────────────────────────────────────
console.log('\nSECURITY MASTER');
const meta = await get('https://api.tiingo.com/tiingo/daily/AAPL', 'meta');
classify('security metadata (ticker, name, exchange, dates)', meta,
  { needs: ['ticker', 'name', 'exchangeCode', 'startDate', 'endDate'] });
if (meta.json) console.log(`      AAPL → ${meta.json.name} · ${meta.json.exchangeCode} · ${meta.json.startDate}..${meta.json.endDate}`);

// ── 3. DAILY OHLCV (EOD) — the composite-volume source ───────────────────────
console.log('\nDAILY OHLCV (composite EOD)');
for (const t of ['SPY', 'AAPL', 'UVXY']) {
  const r = await get(`https://api.tiingo.com/tiingo/daily/${t}/prices?startDate=${daysAgo(10)}&endDate=${daysAgo(0)}`, t);
  classify(`daily OHLCV ${t}`, r, { needs: ['date', 'open', 'high', 'low', 'close', 'volume'] });
  if (r.json?.length) {
    const b = r.json[r.json.length - 1];
    console.log(`      last ${String(b.date).slice(0, 10)}  O${b.open} H${b.high} L${b.low} C${b.close}  vol ${Number(b.volume).toLocaleString()}` +
      `  adjClose ${b.adjClose}  splitFactor ${b.splitFactor}  divCash ${b.divCash}`);
  }
}

// ── 4. INTRADAY (IEX) — the participating-venue source ───────────────────────
console.log('\nINTRADAY / IEX (participating venues)');
const iexQuote = await get('https://api.tiingo.com/iex/?tickers=SPY,AAPL,UVXY', 'iex quote');
classify('IEX reference quote (batch)', iexQuote,
  { needs: ['ticker', 'last', 'prevClose', 'open', 'high', 'low', 'volume', 'timestamp'] });
if (Array.isArray(iexQuote.json)) {
  for (const q of iexQuote.json.slice(0, 3)) {
    console.log(`      ${String(q.ticker).padEnd(6)} last=${q.last} prevClose=${q.prevClose} open=${q.open} ` +
      `H=${q.high} L=${q.low} vol=${q.volume == null ? 'null' : Number(q.volume).toLocaleString()} ts=${q.timestamp}`);
    if (q.askPrice !== undefined || q.bidPrice !== undefined) console.log(`             bid=${q.bidPrice} ask=${q.askPrice}`);
  }
}

const iexIntraday = await get(`https://api.tiingo.com/iex/AAPL/prices?startDate=${daysAgo(3)}&resampleFreq=5min`, 'iex intraday');
classify('intraday historical bars (5min)', iexIntraday, { needs: ['date', 'open', 'high', 'low', 'close'] });
if (Array.isArray(iexIntraday.json) && iexIntraday.json.length) {
  const b = iexIntraday.json[iexIntraday.json.length - 1];
  console.log(`      bars=${iexIntraday.json.length}  last ${b.date}  O${b.open} H${b.high} L${b.low} C${b.close} vol=${b.volume ?? 'ABSENT'}`);
  console.log(`      volume field present on intraday bars: ${b.volume !== undefined}`);
}

const iex1min = await get(`https://api.tiingo.com/iex/AAPL/prices?startDate=${daysAgo(1)}&resampleFreq=1min`, 'iex 1min');
classify('intraday historical bars (1min)', iex1min, { needs: ['date', 'open', 'high', 'low', 'close'] });

// ── 5. EXTENDED HOURS ────────────────────────────────────────────────────────
console.log('\nEXTENDED HOURS');
const ext = await get(`https://api.tiingo.com/iex/AAPL/prices?startDate=${daysAgo(3)}&resampleFreq=5min&afterHours=true`, 'ext');
classify('extended-hours intraday (afterHours=true)', ext, { needs: ['date', 'open', 'close'] });

// ── 6. ALL-TICKER SNAPSHOT — what Tiingo recommended for scanning ────────────
console.log('\nMARKET-WIDE SNAPSHOT');
const all = await get('https://api.tiingo.com/iex', 'all tickers');
classify('all-ticker snapshot (/iex)', all, { needs: ['ticker', 'last', 'prevClose'] });
if (Array.isArray(all.json)) {
  const withLast = all.json.filter((x) => x.last != null).length;
  const withVol = all.json.filter((x) => x.volume != null && x.volume > 0).length;
  console.log(`      rows=${all.json.length.toLocaleString()}  with last=${withLast.toLocaleString()}  with volume>0=${withVol.toLocaleString()}`);
  console.log(`      payload≈${Math.round(all.raw.length ? JSON.stringify(all.json).length / 1024 : 0).toLocaleString()}KB`);
}

// ── 7. CORPORATE ACTIONS ─────────────────────────────────────────────────────
console.log('\nCORPORATE ACTIONS');
const ca = await get(`https://api.tiingo.com/tiingo/corporate-actions/AAPL/distributions?startDate=${daysAgo(400)}`, 'distributions');
classify('corporate actions — distributions', ca);
const splits = await get(`https://api.tiingo.com/tiingo/corporate-actions/AAPL/splits?startDate=${daysAgo(1500)}`, 'splits');
classify('corporate actions — splits', splits);
console.log('      (daily prices also carry divCash + splitFactor per bar — a usable fallback)');

// ── 8. FUNDAMENTALS (not required, but worth knowing) ────────────────────────
console.log('\nFUNDAMENTALS (informational)');
const fund = await get('https://api.tiingo.com/tiingo/fundamentals/AAPL/daily', 'fundamentals');
classify('fundamentals daily', fund);

// ── SUMMARY ──────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(74)}`);
console.log(`SUMMARY — ${calls} requests total\n`);
const byVerdict = new Map();
for (const r of results) {
  const key = r.verdict.split(' (')[0];
  if (!byVerdict.has(key)) byVerdict.set(key, []);
  byVerdict.get(key).push(r.name);
}
for (const [v, names] of [...byVerdict].sort()) {
  console.log(`${v} (${names.length})`);
  for (const n of names) console.log(`    · ${n}`);
}
