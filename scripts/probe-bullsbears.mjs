// THROWAWAY DIAGNOSTIC — Bulls/Bears Step 1 probe. Not wired to anything.
// Run: node --env-file=.env.local scripts/probe-bullsbears.mjs
// Validates Haiku output shape, JSON validity, token cost, and latency on a
// hand-built AAPL context BEFORE we design the real route.
//
// Uses the SAME mechanism as src/app/api/refresh-content/route.js: raw fetch to
// the Anthropic Messages API (the repo has no @anthropic-ai/sdk dep), the same
// model string, x-api-key header, and anthropic-version.

const MODEL = 'claude-haiku-4-5-20251001';   // identical to refresh-content/route.js:32
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Claude Haiku 4.5 list pricing (USD per million tokens). EDIT if rates differ.
const PRICE_IN_PER_MTOK = 1.00;
const PRICE_OUT_PER_MTOK = 5.00;

// ── hand-built, plausible AAPL context (NOT live data — testing the prompt) ──
const ctx = {
  ticker: 'AAPL',
  companyName: 'Apple Inc.',
  sector: 'Technology',
  industry: 'Consumer Electronics',
  last4Quarters: [
    { quarter: 'Q1 FY2026', revenue: 124300000000, eps: 2.41 },
    { quarter: 'Q4 FY2025', revenue: 94900000000,  eps: 1.64 },
    { quarter: 'Q3 FY2025', revenue: 85800000000,  eps: 1.40 },
    { quarter: 'Q2 FY2025', revenue: 95400000000,  eps: 1.53 },
  ],
  recent8K: [
    { headline: 'Apple announces $110B share repurchase authorization', date: '2026-05-08' },
    { headline: 'Apple appoints new CFO effective Q3', date: '2026-05-20' },
  ],
  form4Activity: {
    totalBuyUSD: 0,
    totalSellUSD: 41200000,
    clusterNote: 'No cluster buying; sells are routine 10b5-1 scheduled dispositions',
    execs: [
      { name: 'Timothy Cook', role: 'CEO', action: 'SELL' },
      { name: 'Luca Maestri', role: 'CFO', action: 'SELL' },
      { name: 'Katherine Adams', role: 'SVP General Counsel', action: 'SELL' },
    ],
  },
  finraShortInterest: { latestPct: 0.74, pctOfFloat: 0.95, daysToCover: 2.74, changeVsPrior: 3.05 },
  newsHeadlines: [
    { headline: 'Apple Vision Pro 2 reportedly entering production', publisher: 'Bloomberg', date: '2026-05-28' },
    { headline: 'iPhone demand in China rebounds in April, analysts say', publisher: 'Reuters', date: '2026-05-27' },
    { headline: 'Apple AI features delayed to fall, sources say', publisher: 'The Information', date: '2026-05-26' },
    { headline: 'EU regulators open fresh App Store probe', publisher: 'Financial Times', date: '2026-05-25' },
    { headline: 'Apple services revenue hits record in latest quarter', publisher: 'CNBC', date: '2026-05-22' },
    { headline: 'Berkshire trims Apple stake further in Q1 filing', publisher: 'WSJ', date: '2026-05-21' },
    { headline: 'Apple supplier TSMC raises capex on AI chip demand', publisher: 'Nikkei', date: '2026-05-20' },
    { headline: 'Analyst lifts Apple price target to $260 on services strength', publisher: 'MarketWatch', date: '2026-05-19' },
    { headline: "Apple faces softer iPad sales amid PC competition", publisher: "Barron's", date: '2026-05-18' },
  ],
  congressTrades: [
    { name: 'Nancy Pelosi', party: 'Democrat', chamber: 'House', amountRange: '$1,000,001 - $5,000,000', action: 'BUY', date: '2026-04-30' },
    { name: 'Ro Khanna', party: 'Democrat', chamber: 'House', amountRange: '$15,001 - $50,000', action: 'SELL', date: '2026-04-22' },
  ],
  heroStats: {
    peTTM: 37.36, epsTTM: 8.27, beta: 1.09, ma50: 273.86,
    marketCap: '4.58T', dayRange: '$254.10 - $258.90', week52Range: '$195.07 - $315.00',
  },
};

const SYSTEM = 'You are a balanced financial analyst writing for retail traders. You synthesize bull and bear cases from REAL provided data. You NEVER invent numbers, never speculate beyond what the data supports, and you cite the source of every claim. If data is insufficient for either side, you provide fewer bullets rather than padding.';

// Build a clearly-labeled, sectioned user message (not a raw JSON dump).
function buildUserMessage(c) {
  const money = (n) => (typeof n === 'number' ? `$${n.toLocaleString('en-US')}` : n);
  const L = [];
  L.push(`COMPANY: ${c.ticker} — ${c.companyName} | Sector: ${c.sector} | Industry: ${c.industry}`);
  L.push('');
  L.push('=== LAST 4 QUARTERS (source: 10-Q / 10-K) ===');
  for (const q of c.last4Quarters) L.push(`- ${q.quarter}: revenue ${money(q.revenue)}, EPS $${q.eps}`);
  L.push('');
  L.push('=== RECENT 8-K FILINGS (last 30 days, source: 8-K) ===');
  for (const f of c.recent8K) L.push(`- ${f.date}: ${f.headline}`);
  L.push('');
  L.push('=== INSIDER ACTIVITY — Form 4 (last 90 days, source: Form 4) ===');
  L.push(`- Total insider buys: ${money(c.form4Activity.totalBuyUSD)}`);
  L.push(`- Total insider sells: ${money(c.form4Activity.totalSellUSD)}`);
  L.push(`- Note: ${c.form4Activity.clusterNote}`);
  for (const e of c.form4Activity.execs) L.push(`- ${e.name} (${e.role}): ${e.action}`);
  L.push('');
  L.push('=== SHORT INTEREST (source: FINRA) ===');
  L.push(`- Short interest: ${c.finraShortInterest.latestPct}% | % of float: ${c.finraShortInterest.pctOfFloat}% | days to cover: ${c.finraShortInterest.daysToCover} | change vs prior: ${c.finraShortInterest.changeVsPrior}%`);
  L.push('');
  L.push('=== RECENT NEWS HEADLINES (last 14 days, source: News) ===');
  for (const n of c.newsHeadlines) L.push(`- ${n.date} [${n.publisher}]: ${n.headline}`);
  L.push('');
  L.push('=== CONGRESSIONAL TRADES (last 90 days, source: Congress) ===');
  for (const t of c.congressTrades) L.push(`- ${t.date}: ${t.name} (${t.party}, ${t.chamber}) ${t.action} ${t.amountRange}`);
  L.push('');
  L.push('=== KEY STATS (source: Market data) ===');
  const h = c.heroStats;
  L.push(`- P/E (TTM): ${h.peTTM} | EPS (TTM): $${h.epsTTM} | Beta: ${h.beta} | 50-day MA: $${h.ma50} | Market cap: ${h.marketCap} | Day range: ${h.dayRange} | 52-wk range: ${h.week52Range}`);
  L.push('');
  L.push('=== INSTRUCTIONS ===');
  L.push('Synthesize the bull and bear case from ONLY the data above. Return ONLY valid JSON — no preamble, no markdown code fences — in EXACTLY this shape:');
  L.push('{');
  L.push('  "summary_line": "one sentence capturing the bull-bear tension",');
  L.push('  "bulls": [ { "text": "...", "source": "10-Q", "date": "YYYY-MM-DD" } ],  // up to 5');
  L.push('  "bears": [ { "text": "...", "source": "Form 4", "date": "YYYY-MM-DD" } ],  // up to 5');
  L.push('  "generated_at": "<ISO timestamp>"');
  L.push('}');
  L.push("Every bullet's source AND date MUST correspond to a real item in the data above. Fewer bullets is correct if the data is thin — do NOT pad to 5.");
  return L.join('\n');
}

const userMessage = buildUserMessage(ctx);

if (!API_KEY) { console.error('ANTHROPIC_API_KEY missing from env'); process.exit(1); }

const t0 = Date.now();
const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
  }),
});
const latencyMs = Date.now() - t0;

if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

const data = await res.json();
const text = (data.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');

console.log('========== RAW RESPONSE TEXT ==========');
console.log(text);

console.log('\n========== JSON.parse() CHECK ==========');
let parseOk = false, parseErr = null;
try { JSON.parse(text); parseOk = true; } catch (e) { parseErr = e.message; }
console.log('parses:', parseOk);
if (!parseOk) console.log('error:', parseErr);

const inTok = data.usage?.input_tokens, outTok = data.usage?.output_tokens;
const inCost = (inTok / 1_000_000) * PRICE_IN_PER_MTOK;
const outCost = (outTok / 1_000_000) * PRICE_OUT_PER_MTOK;
console.log('\n========== TOKENS & COST ==========');
console.log('model:', MODEL);
console.log('input_tokens :', inTok);
console.log('output_tokens:', outTok);
console.log(`cost = (${inTok}/1e6 × $${PRICE_IN_PER_MTOK}) + (${outTok}/1e6 × $${PRICE_OUT_PER_MTOK})`);
console.log(`     = $${inCost.toFixed(6)} (in) + $${outCost.toFixed(6)} (out) = $${(inCost + outCost).toFixed(6)}`);

console.log('\n========== LATENCY ==========');
console.log('wall-clock:', latencyMs, 'ms');
