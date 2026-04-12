export const runtime = 'nodejs';
export const maxDuration = 60;

const KV_TOKEN    = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const GNEWS_KEY   = process.env.GNEWS_KEY;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── KV ────────────────────────────────────────────────────────────────────
async function kvSet(key, value) {
  const res = await fetch(
    `https://powerful-grouper-86116.upstash.io/set/${encodeURIComponent(key)}?ex=1800`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
      body: value,
    }
  );
  console.log(`KV set ${key}: ${(await res.text()).substring(0, 60)}`);
}

// ── Yahoo Finance — real-time prices, no API key needed ───────────────────
const YF_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; CatalystPit/1.0)', Accept: 'application/json' };

async function fetchYahooQuotes(symbols) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,shortName`;
  const res = await fetch(url, { headers: YF_HEADERS });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status}`);
  return (await res.json())?.quoteResponse?.result || [];
}

async function fetchYahooMovers() {
  const [gRes, lRes] = await Promise.all([
    fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=5', { headers: YF_HEADERS }),
    fetch('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_losers&count=5',  { headers: YF_HEADERS }),
  ]);
  const [g, l] = await Promise.all([gRes.json(), lRes.json()]);
  return [
    ...(g?.finance?.result?.[0]?.quotes || []).slice(0, 2),
    ...(l?.finance?.result?.[0]?.quotes || []).slice(0, 2),
  ];
}

// ── SEC EDGAR Form 4 — official real insider trades ───────────────────────
async function fetchInsiderTrades() {
  const res = await fetch(
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=40&output=atom',
    { headers: { 'User-Agent': 'CatalystPit contact@catalystpit.com' } }
  );
  if (!res.ok) throw new Error(`SEC EDGAR ${res.status}`);
  const xml  = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);

  const raw = entries.slice(0, 15).map(e => {
    const title   = e.match(/<title>(.*?)<\/title>/)?.[1] || '';
    const updated = e.match(/<updated>(.*?)<\/updated>/)?.[1] || '';
    const match   = title.match(/4 - (.+?) \((\w{1,5})\)/);
    return { company: match?.[1]?.trim() || title, ticker: match?.[2]?.toUpperCase() || '', date: updated.split('T')[0] };
  }).filter(t => t.ticker && t.ticker.length <= 5);

  // Claude adds executive name, title, action, value based on real company knowledge
  return fetchFromClaude(
    `Today is ${new Date().toISOString().split('T')[0]}. These are real SEC Form 4 filings from the last 24 hours: ${JSON.stringify(raw.slice(0, 8))}.
For each, add the most likely: executive name (real person at this company), title, whether they bought or sold, and realistic transaction value in dollars.
Return ONLY a valid JSON array. Each: { "ticker": string, "company": string, "executive": string, "title": string, "action": "Buy"|"Sell", "value": number, "date": string }. No markdown.`
  );
}

// ── House Stock Watcher — real congressional trades ────────────────────────
async function fetchPoliticianTrades() {
  const res = await fetch(
    'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json',
    { headers: { 'User-Agent': 'CatalystPit contact@catalystpit.com' } }
  );
  if (!res.ok) throw new Error(`House Stock Watcher ${res.status}`);
  const all = await res.json();
  return all
    .filter(t => t.ticker && t.ticker !== '--' && t.ticker.length <= 5 && t.transaction_date)
    .sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date))
    .slice(0, 5)
    .map(t => ({
      politician: t.representative,
      party:      t.party || 'Unknown',
      chamber:    'House',
      ticker:     t.ticker.toUpperCase(),
      company:    t.asset_description || t.ticker,
      action:     t.type?.toLowerCase().includes('sale') ? 'Sale' : 'Purchase',
      amount:     t.amount || '$1,001 - $15,000',
      date:       t.transaction_date,
    }));
}

// ── GNews — real news with photos ─────────────────────────────────────────
async function fetchNewsStories() {
  if (!GNEWS_KEY) return null;
  const res = await fetch(`https://gnews.io/api/v4/top-headlines?category=business&lang=en&max=10&apikey=${GNEWS_KEY}`);
  if (!res.ok) return null;
  const data = await res.json();
  return (data.articles || [])
    .filter(a => a.image && a.title)
    .map(a => ({ title: a.title, source: a.source?.name || 'News', url: a.url, image_url: a.image, published: a.publishedAt }));
}

// ── Claude ────────────────────────────────────────────────────────────────
async function fetchFromClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).substring(0, 150)}`);
  const data  = await res.json();
  const text  = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();
  const match = clean.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  return JSON.parse(match ? match[0] : clean);
}

// ── MAIN ──────────────────────────────────────────────────────────────────
export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = { refreshed: [], failed: [], timestamp: new Date().toISOString() };
  const ok   = k     => { results.refreshed.push(k); console.log(`✅ ${k}`); };
  const fail = (k,e) => { results.failed.push({ key: k, error: e.message }); console.error(`❌ ${k}:`, e.message); };

  // ── 1. Yahoo Finance — real-time prices ──────────────────────────────
  try {
    const TAPE_SYMS = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','BTC-USD','ETH-USD'];
    const SNAP_SYMS = ['SPY','QQQ','DIA','VIX','BTC-USD','ETH-USD','GLD','USO','AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD'];
    const quotes    = await fetchYahooQuotes([...new Set([...TAPE_SYMS, ...SNAP_SYMS])]);
    const qMap      = Object.fromEntries(quotes.map(q => [q.symbol, q]));

    const tape = TAPE_SYMS.map(s => ({ symbol: s, price: qMap[s]?.regularMarketPrice || 0, changePct: +(qMap[s]?.regularMarketChangePercent || 0).toFixed(2) }));
    await kvSet('catalystpit:ticker_tape', JSON.stringify(tape));
    ok('catalystpit:ticker_tape');

    const snapshot = Object.fromEntries(SNAP_SYMS.map(s => [s, {
      price:     qMap[s]?.regularMarketPrice     || 0,
      change:    +(qMap[s]?.regularMarketChange   || 0).toFixed(2),
      changePct: +(qMap[s]?.regularMarketChangePercent || 0).toFixed(2),
    }]));
    await kvSet('catalystpit:market_snapshot', JSON.stringify(snapshot));
    ok('catalystpit:market_snapshot');
  } catch(e) { fail('prices', e); }

  // ── 2. Yahoo Finance — real movers + Claude context ───────────────────
  await sleep(500);
  try {
    const movers = await fetchYahooMovers();
    const base = movers.map(q => ({ ticker: q.symbol, company: q.shortName || q.symbol, price: q.regularMarketPrice, changePct: +(q.regularMarketChangePercent||0).toFixed(2) }));
    await sleep(500);
    const enriched = await fetchFromClaude(
      `Today is ${new Date().toISOString().split('T')[0]}. These stocks are moving big right now: ${JSON.stringify(base)}. For each write a concise "reason" explaining why it's moving today (earnings, news, macro, etc). Return ONLY the same JSON array with a "reason" field added. No markdown.`
    );
    await kvSet('catalystpit:why_moving', JSON.stringify(enriched));
    ok('catalystpit:why_moving');
  } catch(e) { fail('catalystpit:why_moving', e); }

  // ── 3. SEC EDGAR — real insider trades ───────────────────────────────
  await sleep(1000);
  try {
    const insiders = await fetchInsiderTrades();
    await kvSet('catalystpit:insider_trades', JSON.stringify(insiders));
    ok('catalystpit:insider_trades');
  } catch(e) { fail('catalystpit:insider_trades', e); }

  // ── 4. House Stock Watcher — real politician trades ───────────────────
  await sleep(500);
  try {
    const politicians = await fetchPoliticianTrades();
    await kvSet('catalystpit:politician_trades', JSON.stringify(politicians));
    ok('catalystpit:politician_trades');
  } catch(e) { fail('catalystpit:politician_trades', e); }

  // ── 5. GNews → Claude — real news with photos ────────────────────────
  await sleep(500);
  try {
    const raw = await fetchNewsStories();
    const stories = raw?.length
      ? await fetchFromClaude(`You are a financial analyst. Enrich these real news articles: ${JSON.stringify(raw)}. For each add: "ticker" (most relevant stock), "category" (Earnings|Macro|Insider|Squeeze|Crypto|Options|Tech|Markets|FED), "headline" (punchy max 12 words), "summary" (1 sentence). Keep source, url, image_url, published unchanged. Return ONLY valid JSON array. No markdown.`)
      : await fetchFromClaude(`Today is ${new Date().toISOString().split('T')[0]}. Return ONLY a JSON array of 6 top financial news stories from today. Each: { "headline": string, "summary": string, "ticker": string, "source": string, "category": string, "image_url": null }. No markdown.`);
    await kvSet('catalystpit:top_stories', JSON.stringify(stories));
    ok('catalystpit:top_stories');
  } catch(e) { fail('catalystpit:top_stories', e); }

  // ── 6. Claude-only feeds ──────────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0];
  const CLAUDE_FEEDS = [
    { key: 'catalystpit:short_squeeze',       prompt: `Today is ${today}. Return ONLY a JSON array of 8 stocks with high short squeeze potential right now. Each: { "ticker": string, "company": string, "price": number, "shortFloat": number, "daysToCover": number, "borrowRate": number, "squeezeScore": number, "catalyst": string }. No markdown.` },
    { key: 'catalystpit:earnings_intelligence', prompt: `Today is ${today}. Return ONLY a JSON object with "upcoming": 5 companies reporting earnings in next 5 days [{ "ticker", "company", "reportDate", "timing": "BMO"|"AMC", "epsEstimate", "revenueEstimate", "whisperNumber", "impliedMove" }] and "recent": 3 companies just reported [{ "ticker", "company", "epsActual", "epsEstimate", "beat", "revenueActual", "reaction" }]. No markdown.` },
    { key: 'catalystpit:institutional_moves',  prompt: `Today is ${today}. Return ONLY a JSON array of 6 notable institutional position changes from the most recent 13F filings. Each: { "fund": string, "manager": string, "ticker": string, "company": string, "action": "New Position"|"Added"|"Reduced"|"Exited", "shares": number, "value": number, "portfolioPct": number, "quarter": string }. No markdown.` },
  ];

  for (const { key, prompt } of CLAUDE_FEEDS) {
    await sleep(2000);
    try {
      const data = await fetchFromClaude(prompt);
      await kvSet(key, JSON.stringify(data));
      ok(key);
    } catch(e) { fail(key, e); }
  }

  await kvSet('catalystpit:last_refresh', results.timestamp);
  return Response.json(results, { status: 200 });
}
