// WHAT THE COMMERCIAL TIINGO KEY ACTUALLY SERVES — raw payloads, not a summary.
//
//   node --env-file=.env.local scripts/probe-tiingo-entitlement-2026.mjs
//
// The existing capability probe answers PASS/FAIL per endpoint. This one answers "what fields, with
// what values, right now" — because the questions on the table (can we show a live price? is that
// volume consolidated? are all four dividend dates present?) are answered by the payload, not by
// the status code. Every claim in the report that follows has to be traceable to a line printed
// here.
//
// DELIBERATELY GENTLE: one request at a time, paced, a handful of symbols.

const KEY = process.env.TIINGO_API_KEY;
if (!KEY) { console.error('TIINGO_API_KEY missing'); process.exit(1); }
const H = { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (s = '') => console.log(s);
const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => ymd(new Date(Date.now() - n * 864e5));

// Never print the key, even inside an echoed URL.
const safe = (u) => u.replace(/token=[^&]*/gi, 'token=REDACTED');

async function get(url, label) {
  await sleep(400);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: H });
    const ms = Date.now() - t0;
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    L(`\n── ${label}  [HTTP ${r.status}, ${ms}ms]`);
    L(`   ${safe(url)}`);
    if (!r.ok) { L(`   body: ${text.slice(0, 240)}`); return null; }
    return json;
  } catch (e) {
    L(`\n── ${label}  [NETWORK ERROR] ${e.message}`);
    return null;
  }
}

const SYMS = ['AAPL', 'NVDA', 'SPY', 'AMD'];
L(`PROBE RUN ${new Date().toISOString()}  (local ${new Date().toString().slice(16, 24)})`);

// ── A. END OF DAY ───────────────────────────────────────────────────────────
L('\n\n=============== A. END OF DAY ===============');
{
  const j = await get(`https://api.tiingo.com/tiingo/daily/AAPL/prices?startDate=${daysAgo(10)}&token=${KEY}`, 'EOD history AAPL');
  if (Array.isArray(j) && j.length) {
    L(`   bars=${j.length}  fields on a bar: ${Object.keys(j[j.length - 1]).join(', ')}`);
    const b = j[j.length - 1];
    L(`   latest ${b.date?.slice(0, 10)}  close=${b.close} adjClose=${b.adjClose} volume=${b.volume?.toLocaleString()} adjVolume=${b.adjVolume?.toLocaleString()} divCash=${b.divCash} splitFactor=${b.splitFactor}`);
  }
  // A dividend-paying name, to see divCash actually populated on the ex-date bar.
  const k = await get(`https://api.tiingo.com/tiingo/daily/KO/prices?startDate=${daysAgo(120)}&token=${KEY}`, 'EOD history KO (divCash check)');
  if (Array.isArray(k)) {
    const withDiv = k.filter((b) => Number(b.divCash) > 0);
    L(`   bars=${k.length}  bars carrying divCash>0: ${withDiv.length}`);
    for (const b of withDiv.slice(0, 3)) L(`     ${b.date?.slice(0, 10)}  divCash=${b.divCash}  splitFactor=${b.splitFactor}`);
  }
}

// ── B. IEX INTRADAY ─────────────────────────────────────────────────────────
L('\n\n=============== B. IEX INTRADAY ===============');
{
  const j = await get(`https://api.tiingo.com/iex/?tickers=${SYMS.join(',')}&token=${KEY}`, 'IEX batch quote');
  if (Array.isArray(j)) for (const q of j) {
    L(`   ${String(q.ticker).padEnd(5)} keys: ${Object.keys(q).join(', ')}`);
    L(`         last=${q.last} tngoLast=${q.tngoLast} prevClose=${q.prevClose} mid=${q.mid} bid=${q.bidPrice}/${q.bidSize} ask=${q.askPrice}/${q.askSize}`);
    L(`         volume=${q.volume} open=${q.open} high=${q.high} low=${q.low} ts=${q.timestamp} quoteTs=${q.quoteTimestamp} lastSaleTs=${q.lastSaleTimeStamp}`);
  }
  const bars = await get(`https://api.tiingo.com/iex/AAPL/prices?startDate=${daysAgo(1)}&resampleFreq=5min&columns=open,high,low,close,volume&token=${KEY}`, 'IEX intraday bars 5min (explicit volume column)');
  if (Array.isArray(bars) && bars.length) {
    L(`   bars=${bars.length}  fields: ${Object.keys(bars[bars.length - 1]).join(', ')}`);
    L(`   last bar: ${JSON.stringify(bars[bars.length - 1])}`);
  }
  const ext = await get(`https://api.tiingo.com/iex/AAPL/prices?startDate=${daysAgo(1)}&resampleFreq=5min&afterHours=true&token=${KEY}`, 'IEX intraday bars incl. extended hours');
  if (Array.isArray(ext) && ext.length) {
    L(`   bars=${ext.length}  first=${ext[0].date}  last=${ext[ext.length - 1].date}`);
  }
}

// ── C. REAL-TIME CONSOLIDATED 24x5 (REST candidates) ────────────────────────
L('\n\n=============== C. REAL-TIME CONSOLIDATED 24x5 (REST candidates) ===============');
{
  // The consolidated product may not live under /iex. Probe the documented candidates rather
  // than assuming which one our entitlement attaches to.
  await get(`https://api.tiingo.com/tiingo/utilities/search?query=AAPL&token=${KEY}`, 'utilities/search (sanity)');
  await get(`https://api.tiingo.com/tiingo/daily/AAPL/prices?token=${KEY}`, 'daily latest (reference close)');
  const c1 = await get(`https://api.tiingo.com/iex/AAPL?token=${KEY}`, 'iex single-symbol');
  if (Array.isArray(c1) && c1[0]) L(`   keys: ${Object.keys(c1[0]).join(', ')}`);
}

// ── D. SECURITY MASTER ──────────────────────────────────────────────────────
L('\n\n=============== D. SECURITY MASTER / META ===============');
for (const s of ['AAPL', 'SPY']) {
  const j = await get(`https://api.tiingo.com/tiingo/daily/${s}?token=${KEY}`, `meta ${s}`);
  if (j) L(`   ${JSON.stringify(j)}`);
}

// ── E. CORPORATE ACTIONS — DIVIDENDS ────────────────────────────────────────
L('\n\n=============== E. CORPORATE ACTIONS — DIVIDENDS ===============');
for (const s of ['KO', 'AAPL', 'MSFT', 'SPY']) {
  const j = await get(
    `https://api.tiingo.com/tiingo/corporate-actions/${s}/distributions?startDate=${daysAgo(400)}&token=${KEY}`,
    `distributions ${s}`);
  if (Array.isArray(j)) {
    L(`   records=${j.length}`);
    if (j.length) {
      L(`   FIELDS: ${Object.keys(j[0]).join(', ')}`);
      for (const d of j.slice(-3)) L(`     ${JSON.stringify(d)}`);
    }
  } else if (j) { L(`   non-array payload: ${JSON.stringify(j).slice(0, 300)}`); }
}
// Forward window — does it carry ANNOUNCED-but-not-yet-ex events?
{
  const j = await get(
    `https://api.tiingo.com/tiingo/corporate-actions/KO/distributions?startDate=${ymd(new Date())}&endDate=${ymd(new Date(Date.now() + 120 * 864e5))}&token=${KEY}`,
    'distributions KO — FORWARD window (declared, not yet ex)');
  if (Array.isArray(j)) { L(`   forward records=${j.length}`); for (const d of j) L(`     ${JSON.stringify(d)}`); }
}

// ── F. CORPORATE ACTIONS — SPLITS ───────────────────────────────────────────
L('\n\n=============== F. CORPORATE ACTIONS — SPLITS ===============');
for (const s of ['NVDA', 'AAPL']) {
  const j = await get(
    `https://api.tiingo.com/tiingo/corporate-actions/${s}/splits?startDate=2019-01-01&token=${KEY}`,
    `splits ${s}`);
  if (Array.isArray(j)) {
    L(`   records=${j.length}`);
    if (j.length) { L(`   FIELDS: ${Object.keys(j[0]).join(', ')}`); for (const d of j.slice(-3)) L(`     ${JSON.stringify(d)}`); }
  }
}

L('\n\nPROBE COMPLETE');
