// AI bull/bear synthesis from the 6 real data sources. Cron-precomputed + KV-cached
// (~6s Haiku latency makes on-demand generation a non-starter — see scripts/probe-bullsbears.mjs).
// Aggregates the EXISTING internal routes (no new upstream fetches): /api/ticker (hero+news),
// /api/earnings, /api/insiders, /api/politicians, /api/short-interest. Every source item carries
// its real date so the model never improvises one. 8-K is not wired anywhere yet → passed empty.

export const runtime = 'nodejs';
export const maxDuration = 30;

const MODEL = 'claude-haiku-4-5-20251001';      // same as refresh-content + the probe
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const TTL_OK = 6 * 60 * 60;          // 6h for a good synthesis
const TTL_EMPTY = 15 * 60;           // 15m negative-cache for junk/dead/failed tickers
const TTL_LASTREFRESH = 30 * 60;     // 30m per-ticker manual-refresh throttle

const SYSTEM = 'You are a balanced financial analyst writing for retail traders. You synthesize bull and bear cases from REAL provided data. You NEVER invent numbers, never speculate beyond what the data supports, and you cite the source of every claim. If data is insufficient for either side, you provide fewer bullets rather than padding.';

// ── KV (REST), mirrors the other routes ──
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    const { result } = await r.json();
    return result ? JSON.parse(result) : null;
  } catch { return null; }
}
async function kvSet(key, value, ttl) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?EX=${ttl}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch { /* non-fatal */ }
}
async function kvExists(key) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return false;
    const { result } = await r.json();
    return result != null;
  } catch { return false; }
}

// Fetch an internal route on the same origin; null on any failure (null discipline).
async function internal(origin, path) {
  try {
    const r = await fetch(`${origin}${path}`, { headers: { 'x-internal': '1' } });
    if (!r.ok) return null;
    const j = await r.json();
    return j && !j.error ? j : null;
  } catch { return null; }
}

const num = (n) => (n == null || isNaN(Number(n)) ? null : Number(n));
const within = (dateStr, days) => {
  if (!dateStr) return false;
  const t = Date.parse(dateStr);
  if (isNaN(t)) return false;
  return (Date.now() - t) <= days * 86_400_000;
};

// ── assemble the 6 sources from existing routes; each item keeps its real date ──
async function assembleContext(origin, ticker) {
  const [tk, earn, ins, gov, si] = await Promise.all([
    internal(origin, `/api/ticker?symbol=${encodeURIComponent(ticker)}`),
    internal(origin, `/api/earnings?ticker=${encodeURIComponent(ticker)}`),
    internal(origin, `/api/insiders?ticker=${encodeURIComponent(ticker)}`),
    internal(origin, `/api/politicians?ticker=${encodeURIComponent(ticker)}`),
    internal(origin, `/api/short-interest?ticker=${encodeURIComponent(ticker)}`),
  ]);

  if (!tk || !tk.valid) return null;   // not a real ticker → caller negative-caches

  // Earnings: last 4 quarters with their REAL 10-Q/10-K report_date.
  const last4Quarters = (earn?.earnings || []).slice(0, 4).map((q) => ({
    quarter: q.quarter, reportDate: q.report_date || null, form: q.form || null,
    revenue: num(q.revenue), eps: num(q.eps_basic),
  }));

  // Form 4: aggregate last 90 days. Each exec keeps its date.
  const f4 = (ins?.trades || []).filter((t) => within(t.transactionDate || t.filingDate, 90));
  const totalBuyUSD = f4.filter((t) => t.action === 'BUY').reduce((s, t) => s + (num(t.totalValue) || 0), 0);
  const totalSellUSD = f4.filter((t) => t.action === 'SELL').reduce((s, t) => s + (num(t.totalValue) || 0), 0);
  const distinctBuyers = new Set(f4.filter((t) => t.action === 'BUY').map((t) => t.executive)).size;
  const form4Activity = {
    totalBuyUSD, totalSellUSD,
    clusterNote: distinctBuyers >= 3 ? `Cluster buying: ${distinctBuyers} distinct insiders bought in 90d` : 'No cluster buying',
    execs: f4.slice(0, 8).map((t) => ({ name: t.executive, role: t.title || null, action: t.action, date: t.transactionDate || t.filingDate || null })),
  };

  // FINRA short interest (latest settlement).
  const L = si?.latest || null;
  const finraShortInterest = L ? {
    pct: num(si.float?.free_float_pct) != null ? null : null,   // % of shares short not in payload; use days/float below
    pctOfFloat: (L.short_int_shares != null && si.float?.float_shares > 0)
      ? +((L.short_int_shares / si.float.float_shares) * 100).toFixed(2) : null,
    daysToCover: num(L.days_to_cover),
    changeVsPrior: num(L.change_percent),
    settlementDate: L.settlement_date || null,
  } : null;

  // News: top ~10 by publisher diversity, last 14 days. tk.news items are {headline, source, datetime}.
  const newsRaw = (tk.news || []).filter((n) => within(n.datetime, 14));
  const seenPub = new Set();
  const newsHeadlines = [];
  for (const n of newsRaw) {                       // first pass: one per publisher (diversity)
    const pub = n.source || 'News';
    if (seenPub.has(pub)) continue;
    seenPub.add(pub);
    newsHeadlines.push({ headline: n.headline, publisher: pub, date: (n.datetime || '').slice(0, 10) });
    if (newsHeadlines.length >= 10) break;
  }
  if (newsHeadlines.length < 10) {                 // backfill with remaining recents
    for (const n of newsRaw) {
      if (newsHeadlines.length >= 10) break;
      if (newsHeadlines.some((x) => x.headline === n.headline)) continue;
      newsHeadlines.push({ headline: n.headline, publisher: n.source || 'News', date: (n.datetime || '').slice(0, 10) });
    }
  }

  // Congress: last 90 days.
  const congressTrades = (gov?.trades || [])
    .filter((t) => within(t.transactionDate, 90))
    .slice(0, 6)
    .map((t) => ({ name: t.representative, party: t.party, chamber: t.chamber, amountRange: t.amountRange, action: t.action, date: t.transactionDate }));

  const m = tk.metric || {};
  const heroStats = {
    peTTM: num(m.peTTM), epsTTM: num(m.epsTTM), beta: num(m.beta), ma50: num(tk.fiftyDayMA),
    marketCap: m.marketCap != null ? m.marketCap : null,
    dayRange: (tk.quote?.l != null && tk.quote?.h != null) ? `$${tk.quote.l} - $${tk.quote.h}` : null,
    week52Range: (m.low52 != null && m.high52 != null) ? `$${m.low52} - $${m.high52}` : null,
  };

  return {
    ticker, companyName: tk.name || ticker, sector: null, industry: tk.industry || null,
    last4Quarters, recent8K: [],   // 8-K not wired anywhere yet → empty per null discipline
    form4Activity, finraShortInterest, newsHeadlines, congressTrades, heroStats,
  };
}

// ── build the labeled, sectioned user message (mirrors the validated probe) ──
// marketCap arrives as MILLIONS — format to $T/$B so the haystack and the model speak the
// same magnitude (otherwise a correct "$4.58T" never traces to a bare millions integer).
const fmtCapStr = (millions) => {
  if (millions == null || isNaN(millions)) return 'n/a';
  const v = millions * 1e6;
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(2)}B`;
  return `$${(v / 1e6).toFixed(0)}M`;
};

function buildUserMessage(c) {
  const money = (n) => (typeof n === 'number' ? `$${n.toLocaleString('en-US')}` : (n ?? 'n/a'));
  const L = [];
  L.push(`COMPANY: ${c.ticker} — ${c.companyName}${c.industry ? ` | Industry: ${c.industry}` : ''}`);
  L.push('');
  L.push('=== LAST 4 QUARTERS (source: 10-Q / 10-K) ===');
  if (c.last4Quarters.length) for (const q of c.last4Quarters) L.push(`- ${q.quarter} (filed ${q.reportDate || 'n/a'}, ${q.form || '10-Q'}): revenue ${money(q.revenue)}, EPS ${q.eps != null ? '$' + q.eps : 'n/a'}`);
  else L.push('- (no quarterly data available)');
  L.push('');
  L.push('=== RECENT 8-K FILINGS (last 30 days, source: 8-K) ===');
  if (c.recent8K.length) for (const f of c.recent8K) L.push(`- ${f.date}: ${f.headline}`);
  else L.push('- (no 8-K data available)');
  L.push('');
  L.push('=== INSIDER ACTIVITY — Form 4 (last 90 days, source: Form 4) ===');
  L.push(`- Total insider buys: ${money(c.form4Activity.totalBuyUSD)}`);
  L.push(`- Total insider sells: ${money(c.form4Activity.totalSellUSD)}`);
  L.push(`- ${c.form4Activity.clusterNote}`);
  if (c.form4Activity.execs.length) for (const e of c.form4Activity.execs) L.push(`- ${e.date || 'n/a'}: ${e.name}${e.role ? ` (${e.role})` : ''} ${e.action}`);
  else L.push('- (no insider transactions)');
  L.push('');
  L.push('=== SHORT INTEREST (source: FINRA) ===');
  if (c.finraShortInterest) {
    const s = c.finraShortInterest;
    L.push(`- As of ${s.settlementDate || 'n/a'}: % of float ${s.pctOfFloat != null ? s.pctOfFloat + '%' : 'n/a'}, days to cover ${s.daysToCover ?? 'n/a'}, change vs prior ${s.changeVsPrior != null ? s.changeVsPrior + '%' : 'n/a'}`);
  } else L.push('- (no short interest data available)');
  L.push('');
  L.push('=== RECENT NEWS HEADLINES (last 14 days, source: News) ===');
  if (c.newsHeadlines.length) for (const n of c.newsHeadlines) L.push(`- ${n.date} [${n.publisher}]: ${n.headline}`);
  else L.push('- (no recent news)');
  L.push('');
  L.push('=== CONGRESSIONAL TRADES (last 90 days, source: Congress) ===');
  if (c.congressTrades.length) for (const t of c.congressTrades) L.push(`- ${t.date}: ${t.name} (${t.party}, ${t.chamber}) ${t.action} ${t.amountRange}`);
  else L.push('- (no congressional trades)');
  L.push('');
  L.push('=== KEY STATS (source: Market data) ===');
  const h = c.heroStats;
  L.push(`- P/E (TTM): ${h.peTTM ?? 'n/a'} | EPS (TTM): ${h.epsTTM != null ? '$' + h.epsTTM : 'n/a'} | Beta: ${h.beta ?? 'n/a'} | 50-day MA: ${h.ma50 != null ? '$' + h.ma50 : 'n/a'} | Market cap: ${fmtCapStr(h.marketCap)} | Day range: ${h.dayRange ?? 'n/a'} | 52-wk range: ${h.week52Range ?? 'n/a'}`);
  L.push('');
  L.push('=== INSTRUCTIONS ===');
  L.push('Synthesize the bull and bear case from ONLY the data above. Return ONLY valid JSON — no preamble, no markdown code fences — in EXACTLY this shape:');
  L.push('{ "summary_line": "one sentence capturing the bull-bear tension", "bulls": [ { "text": "...", "source": "10-Q", "date": "YYYY-MM-DD" } ], "bears": [ { "text": "...", "source": "Form 4", "date": "YYYY-MM-DD" } ], "generated_at": "<ISO timestamp>" }');
  L.push('Up to 5 bulls and 5 bears. Every bullet\'s source AND date MUST correspond to a real item in the data above. Fewer bullets is correct if the data is thin — do NOT pad to 5.');
  return L.join('\n');
}

// strip stray ```json ... ``` fences (defensive — prefill should prevent, but guard anyway)
function stripFences(s) {
  return String(s || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

// ── VALIDATION (anti-hallucination, defense-in-depth) ──────────────────────────
// Parse every numeric token in a string into actual VALUES (handling $, %, commas, and
// T/B/M/K magnitude suffixes). Value-based + tolerant matching fixes the magnitude problem
// (model "$124.3B" vs source raw "124300000000") and rounding (model "37.4x" vs source 37.36)
// that pure string-matching silently false-dropped.
function valuesIn(text) {
  const out = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(t|b|m|k)?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const base = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(base)) continue;
    const s = (m[2] || '').toLowerCase();
    const mult = s === 't' ? 1e12 : s === 'b' ? 1e9 : s === 'm' ? 1e6 : s === 'k' ? 1e3 : 1;
    out.push(base * mult);
    if (mult !== 1) out.push(base);   // also allow the bare form to match
  }
  return out;
}

// Numbers a bullet ASSERTS as financial facts — after removing things that aren't claims:
// ISO dates, standalone 4-digit years, ratio constructs (X:1), and small standalone counts.
function claimNumbers(text) {
  let t = String(text || '');
  t = t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');                  // ISO dates
  t = t.replace(/\b(?:19|20)\d{2}\b/g, ' ');                     // standalone years ("since 1945")
  t = t.replace(/\b\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\b/g, ' ');  // ratios ("24.6:1") — analytical, not raw stats
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(t|b|m|k)?/gi;
  const claims = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const raw = m[0].trim();
    const base = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(base)) continue;
    const s = (m[2] || '').toLowerCase();
    // ignore small standalone integers (bullet counts: "5 analysts", "3 insiders", "10 times")
    if (!s && Number.isInteger(base) && base <= 12) continue;
    const mult = s === 't' ? 1e12 : s === 'b' ? 1e9 : s === 'm' ? 1e6 : s === 'k' ? 1e3 : 1;
    claims.push({ raw, value: base * mult });
  }
  return claims;
}

// a claimed value is "traced" if some source value is within 1% (or a tiny absolute epsilon).
function traced(value, hayValues) {
  const tol = Math.max(Math.abs(value) * 0.01, 0.01);
  return hayValues.some((hv) => Math.abs(hv - value) <= tol);
}

// Generic market/macro capitalized terms that are vocabulary, NOT data claims to verify.
const GENERIC_CAPS = new Set([
  'wall street', 'federal reserve', 'the fed', 'main street', 'big tech', 's&p', 'dow jones',
  'new york', 'united states', 'silicon valley', 'free cash', 'price target',
]);
// Real source categories. If a bullet cites one of these but we didn't pass it → fabricated source.
const KNOWN_CATEGORIES = new Set(['10-Q', '10-K', '8-K', 'Form 4', 'FINRA', 'Congress', 'News', 'Market data']);

// Multi-word proper nouns a bullet references (person/org names, publishers). Strips a leading
// article so "The Vision Pro" → "Vision Pro". Used to catch fabricated names not in the sources.
function nameClaims(text) {
  const out = [];
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    let cand = m[1].replace(/^(The|This|These|That|A|An|Its|Their|Our)\s+/i, '').trim();
    if (cand.split(/\s+/).length >= 2) out.push(cand);
  }
  return out;
}

// Role/title words a bullet prepends to a name ("Director Arthur Levinson", "CFO Luca Maestri")
// or generic descriptors — NOT part of the name, so excluded before token matching.
const NAME_NOISE = new Set([
  'the', 'this', 'these', 'that', 'a', 'an', 'its', 'their', 'our',
  'director', 'ceo', 'cfo', 'coo', 'cto', 'president', 'chief', 'executive', 'officer',
  'svp', 'evp', 'vp', 'senior', 'vice', 'general', 'counsel', 'chairman', 'chairwoman',
  'chair', 'founder', 'cofounder', 'treasurer', 'secretary', 'representative', 'senator',
  'congressman', 'congresswoman', 'analyst', 'inc', 'corp', 'co', 'ltd', 'plc',
]);

// Significant tokens of a name: lowercased, role/article words removed, initials (<3 chars)
// dropped. "Director Arthur D. Levinson" → ['arthur','levinson'] so order/format/middle-initial
// differences vs the source feed ("LEVINSON ARTHUR D") don't cause false drops.
function nameTokens(name) {
  return String(name).toLowerCase().replace(/[.'']/g, '').split(/\s+/)
    .filter((w) => w.length >= 3 && !NAME_NOISE.has(w));
}

// Validate one bullet. Returns { ok, reason }: reason ∈ 'number' | 'name' | 'source' when dropped.
function validateBullet(b, companyName, hayValues, hayLower, allowedSources) {
  const text = String(b?.text || '');
  // 1) fabricated SOURCE: cites a known category we never provided (e.g. "8-K" when we passed none)
  const src = String(b?.source || '').trim();
  if (src && KNOWN_CATEGORIES.has(src) && !allowedSources.has(src)) return { ok: false, reason: 'source', detail: src };
  // 2) fabricated NUMBER: a claimed financial value that traces to no source value
  for (const c of claimNumbers(text)) {
    if (!traced(c.value, hayValues)) return { ok: false, reason: 'number', detail: c.raw };
  }
  // 3) fabricated NAME: a multi-word proper noun whose significant tokens are not ALL present
  // as whole words in the sources. Token-subset (not substring) so "Director Arthur Levinson"
  // traces to source "LEVINSON ARTHUR D" (order/format/initial differences ignored), while a
  // fabricated surname still fails because its token is absent from the source word set.
  const companyTokens = new Set(nameTokens(companyName || ''));
  const hayWords = new Set(hayLower.match(/[a-z]{3,}/g) || []);
  for (const nm of nameClaims(text)) {
    if (GENERIC_CAPS.has(nm.toLowerCase())) continue;
    const toks = nameTokens(nm);
    if (!toks.length) continue;
    if (toks.every((t) => companyTokens.has(t))) continue;
    if (toks.every((t) => hayWords.has(t))) continue;
    return { ok: false, reason: 'name', detail: nm };
  }
  return { ok: true };
}

async function generate(origin, ticker) {
  const ctx = await assembleContext(origin, ticker);
  if (!ctx) return { error: 'synthesis_unavailable', reason: 'invalid_ticker' };
  if (!ANTHROPIC_API_KEY) return { error: 'synthesis_unavailable', reason: 'no_api_key' };

  const userMessage = buildUserMessage(ctx);
  let text = '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1024, temperature: 0.2, system: SYSTEM,   // low temp → fewer confabulations
        messages: [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: '{' },          // PREFILL — can't open a ```json fence
        ],
      }),
    });
    if (!res.ok) { console.log(`[bulls_bears] ${ticker} anthropic HTTP ${res.status}`); return { error: 'synthesis_unavailable', reason: `http_${res.status}` }; }
    const data = await res.json();
    text = (data.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    text = '{' + text;                                   // prepend the prefilled '{'
  } catch (e) {
    console.log(`[bulls_bears] ${ticker} anthropic call threw: ${e.message}`);
    return { error: 'synthesis_unavailable', reason: 'fetch_failed' };
  }

  let parsed;
  try { parsed = JSON.parse(stripFences(text)); }
  catch (e) {
    console.log(`[bulls_bears] ${ticker} JSON parse failed: ${e.message} | raw: ${text.slice(0, 200)}`);
    return { error: 'synthesis_unavailable', reason: 'parse_failed' };
  }

  // ── hallucination guard: value-traced numbers + verified names + verified sources ──
  const hayValues = valuesIn(userMessage);
  const hayLower = userMessage.toLowerCase();
  // which source categories did we actually pass (non-empty)? a bullet citing one we didn't → drop.
  const allowedSources = new Set(['Market data']);                 // hero stats always present for a valid ticker
  if (ctx.last4Quarters.length) { allowedSources.add('10-Q'); allowedSources.add('10-K'); }
  if (ctx.recent8K.length) allowedSources.add('8-K');
  if (ctx.form4Activity.execs.length || ctx.form4Activity.totalSellUSD || ctx.form4Activity.totalBuyUSD) allowedSources.add('Form 4');
  if (ctx.finraShortInterest) allowedSources.add('FINRA');
  if (ctx.newsHeadlines.length) allowedSources.add('News');
  if (ctx.congressTrades.length) allowedSources.add('Congress');

  const dropped = [];
  const run = (list, side) => (list || []).filter((b) => {
    const v = validateBullet(b, ctx.companyName, hayValues, hayLower, allowedSources);
    if (!v.ok) { dropped.push({ side, reason: v.reason, detail: v.detail, text: String(b?.text || '').slice(0, 140) }); return false; }
    return true;
  });
  const bulls = run(parsed.bulls, 'bull');
  const bears = run(parsed.bears, 'bear');

  const byReason = dropped.reduce((a, d) => { a[d.reason] = (a[d.reason] || 0) + 1; return a; }, {});
  if (dropped.length) console.log(`[bulls_bears] ${ticker} dropped ${dropped.length} (${JSON.stringify(byReason)}): ${JSON.stringify(dropped)}`);

  return {
    ticker,
    summary_line: parsed.summary_line || null,
    bulls, bears,
    generatedAt: new Date().toISOString(),
    _dropped: dropped,   // included for the curl verification pass; UI ignores it
  };
}

export async function GET(request) {
  let ticker = '';
  try {
    const { searchParams } = new URL(request.url);
    ticker = (searchParams.get('ticker') || '').toUpperCase().trim();
    const forceRefresh = searchParams.get('refresh') === '1';
    if (!TICKER_RE.test(ticker)) return Response.json({ error: 'Invalid ticker' }, { status: 400 });

    const origin = new URL(request.url).origin;
    const cacheKey = `bullsbears:${ticker}`;
    const refreshKey = `bullsbears:lastrefresh:${ticker}`;

    // ?refresh=1 — per-ticker 30m throttle. If recently refreshed, serve cache + flag.
    if (forceRefresh) {
      const recentlyRefreshed = await kvExists(refreshKey);
      if (recentlyRefreshed) {
        const cached = await kvGet(cacheKey);
        return Response.json({ ...(cached || { ticker, bulls: [], bears: [] }), cached: true, refreshed_recently: true });
      }
      const fresh = await generate(origin, ticker);
      await kvSet(refreshKey, { at: Date.now() }, TTL_LASTREFRESH);
      await kvSet(cacheKey, fresh, fresh.error ? TTL_EMPTY : TTL_OK);
      return Response.json({ ...fresh, cached: false });
    }

    // normal path: cache hit → serve; miss → generate, cache, return.
    const cached = await kvGet(cacheKey);
    if (cached) return Response.json({ ...cached, cached: true });

    const fresh = await generate(origin, ticker);
    await kvSet(cacheKey, fresh, fresh.error ? TTL_EMPTY : TTL_OK);
    return Response.json({ ...fresh, cached: false });
  } catch (e) {
    console.log(`[bulls_bears] ${ticker} route error: ${e.message}`);
    return Response.json({ error: 'synthesis_unavailable', reason: 'route_error' }, { status: 200 });
  }
}
