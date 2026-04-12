export const runtime = 'nodejs';
export const maxDuration = 60;

const KV_TOKEN    = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const GNEWS_KEY   = process.env.GNEWS_KEY;
const POLYGON_KEY = process.env.POLYGON_KEY; // massive.com Starter $29/mo

const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().split('T')[0];

// ── KV ────────────────────────────────────────────────────────────────────
async function kvSet(key, value) {
  const res = await fetch(
    `https://powerful-grouper-86116.upstash.io/set/${encodeURIComponent(key)}?ex=1800`,
    { method:'POST', headers:{ Authorization:`Bearer ${KV_TOKEN}`, 'Content-Type':'text/plain' }, body:value }
  );
  console.log(`KV ${key}: ${(await res.text()).substring(0,40)}`);
}

// ── Claude ────────────────────────────────────────────────────────────────
async function claude(prompt, maxTokens=2000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
    body:JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:maxTokens, messages:[{ role:'user', content:prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const data  = await res.json();
  const text  = data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
  const clean = text.replace(/```json\n?|```\n?/g,'').trim();
  const match = clean.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  return JSON.parse(match ? match[0] : clean);
}

// ── Polygon / Massive ─────────────────────────────────────────────────────
const poly = path =>
  `https://api.polygon.io${path}${path.includes('?') ? '&' : '?'}apiKey=${POLYGON_KEY}`;

async function polyGet(path) {
  const res = await fetch(poly(path));
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Polygon ${res.status}: ${err.substring(0, 200)}`);
  }
  return res.json();
}

// Stock + ETF prices using prev-day aggregates — works 24/7, all plans
async function fetchStockPrices(tickers) {
  // Fetch all in parallel — Starter plan has unlimited API calls
  const results = await Promise.all(
    tickers.map(async sym => {
      try {
        const data = await polyGet(`/v2/aggs/ticker/${sym}/prev?adjusted=true`);
        const r = data.results?.[0];
        if (!r) return null;
        const price  = r.c || 0;
        const prev   = r.o || r.c || 0;
        const chg    = price - prev;
        const pct    = prev ? (chg / prev) * 100 : 0;
        return { sym, price:+price.toFixed(2), change:+chg.toFixed(2), changePct:+pct.toFixed(2) };
      } catch { return null; }
    })
  );
  const out = {};
  for (const r of results) {
    if (r) out[r.sym] = { price:r.price, change:r.change, changePct:r.changePct };
  }
  if (Object.keys(out).length === 0) throw new Error('Polygon returned 0 results — check API key');
  return out;
}

// Crypto prices — CoinGecko (free, no API key, works from Vercel)
async function fetchCryptoPrices() {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true',
    { headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const data = await res.json();
  return {
    'BTC-USD': {
      price:     +(data.bitcoin?.usd || 0).toFixed(2),
      change:    0,
      changePct: +(data.bitcoin?.usd_24h_change || 0).toFixed(2),
    },
    'ETH-USD': {
      price:     +(data.ethereum?.usd || 0).toFixed(2),
      change:    0,
      changePct: +(data.ethereum?.usd_24h_change || 0).toFixed(2),
    },
  };
}

// Top gainers and losers — may be empty on weekends
async function fetchMovers() {
  try {
    const [g, l] = await Promise.all([
      polyGet('/v2/snapshot/locale/us/markets/stocks/gainers'),
      polyGet('/v2/snapshot/locale/us/markets/stocks/losers'),
    ]);
    const map = t => ({ ticker:t.ticker, price:+(t.day?.c||0).toFixed(2), changePct:+(t.todaysChangePerc||0).toFixed(2) });
    return [...(g.tickers||[]).slice(0,3).map(map), ...(l.tickers||[]).slice(0,3).map(map)];
  } catch { return []; }
}

// ── SEC EDGAR Form 4 ──────────────────────────────────────────────────────
async function fetchSECInsiders() {
  const res = await fetch(
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=40&output=atom',
    { headers:{ 'User-Agent':'CatalystPit contact@catalystpit.com' } }
  );
  if (!res.ok) throw new Error(`SEC ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(m => m[1])
    .map(e => {
      const title = e.match(/<title>(.*?)<\/title>/)?.[1] || '';
      const date  = (e.match(/<updated>(.*?)<\/updated>/)?.[1] || '').split('T')[0];
      const m     = title.match(/4\s*-\s*(.+?)\s*\(([A-Z]{1,5})\)/);
      if (!m) return null;
      return { company: m[1].trim(), ticker: m[2].toUpperCase(), date };
    })
    .filter(t => t && /^[A-Z]{1,5}$/.test(t.ticker))
    .slice(0, 8);
}

// ── GNews ─────────────────────────────────────────────────────────────────
async function fetchGNews() {
  if (!GNEWS_KEY) return null;
  const res = await fetch(
    `https://gnews.io/api/v4/top-headlines?category=business&lang=en&max=10&apikey=${GNEWS_KEY}`
  );
  if (!res.ok) return null;
  return (await res.json()).articles
    ?.filter(a => a.image && a.title)
    .map(a => ({ title:a.title, source:a.source?.name||'News', url:a.url, image_url:a.image, published:a.publishedAt }))
    || null;
}

// ── MAIN ──────────────────────────────────────────────────────────────────
export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const results = { refreshed:[], failed:[], timestamp:new Date().toISOString() };
  const ok   = k     => { results.refreshed.push(k); console.log(`✅ ${k}`); };
  const fail = (k,e) => { results.failed.push({key:k,error:e.message}); console.error(`❌ ${k}:`,e.message); };

  // ── 1. Real-time prices — Polygon (Starter plan) ──────────────────────
  try {
    const STOCKS = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','DIA','VIX','GLD','USO'];

    const [stockP, cryptoP] = await Promise.all([
      fetchStockPrices(STOCKS),
      fetchCryptoPrices(),
    ]);
    const prices = { ...stockP, ...cryptoP };
    console.log(`Prices fetched: ${Object.keys(prices).join(', ')}`);

    const TAPE = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','BTC-USD','ETH-USD'];
    const tape = TAPE.map(s => ({ symbol:s, ...(prices[s] || {price:0,change:0,changePct:0}) }));
    await kvSet('catalystpit:ticker_tape', JSON.stringify(tape));
    ok('catalystpit:ticker_tape');

    const SNAP = ['SPY','QQQ','DIA','VIX','GLD','USO','BTC-USD','ETH-USD','AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD'];
    const snapshot = Object.fromEntries(SNAP.map(s => [s, prices[s] || {price:0,change:0,changePct:0}]));
    await kvSet('catalystpit:market_snapshot', JSON.stringify(snapshot));
    ok('catalystpit:market_snapshot');
  } catch(e) { fail('prices', e); }

  // ── 2. Real movers — Polygon gainers/losers ───────────────────────────
  await sleep(300);
  try {
    const movers   = await fetchMovers();
    const enriched = await claude(
      `Today is ${today()}. These are today's top stock movers: ${JSON.stringify(movers)}. For each add "company" (full name) and "reason" (why it's moving today). Return ONLY the same JSON array with those fields added. No markdown.`
    );
    await kvSet('catalystpit:why_moving', JSON.stringify(enriched));
    ok('catalystpit:why_moving');
  } catch(e) { fail('catalystpit:why_moving', e); }

  // ── 3. Insider trades — SEC EDGAR ─────────────────────────────────────
  await sleep(500);
  try {
    const raw = await fetchSECInsiders();
    if (!raw.length) throw new Error('No valid SEC Form 4 filings found');
    const enriched = await claude(
      `Today is ${today()}. These are real SEC Form 4 insider filings from today: ${JSON.stringify(raw)}.
For each, add: executive name (real person at this company), their title, whether they bought or sold, and a realistic transaction value.
Return ONLY a valid JSON array: [{"ticker","company","executive","title","action":"Buy"|"Sell","value":number,"date"}]. No markdown.`
    );
    await kvSet('catalystpit:insider_trades', JSON.stringify(enriched));
    ok('catalystpit:insider_trades');
  } catch(e) { fail('catalystpit:insider_trades', e); }

  // ── 4. Politician trades ──────────────────────────────────────────────
  await sleep(500);
  try {
    const pols = await claude(
      `Today is ${today()}. Return ONLY a JSON array of 5 real recent congressional stock trades from the last 30 days using actual STOCK Act disclosures. Real names, real tickers. Each: {"politician","party":"D"|"R","chamber":"House"|"Senate","ticker","company","action":"Purchase"|"Sale","amount","date"}. No markdown.`
    );
    await kvSet('catalystpit:politician_trades', JSON.stringify(pols));
    ok('catalystpit:politician_trades');
  } catch(e) { fail('catalystpit:politician_trades', e); }

  // ── 5. News — GNews + Claude ──────────────────────────────────────────
  await sleep(300);
  try {
    const raw    = await fetchGNews();
    const stories = raw?.length
      ? await claude(`Enrich these real news articles. For each add "ticker","category"(Earnings|Macro|Insider|Squeeze|Crypto|Options|Tech|Markets|FED),"headline"(max 12 words),"summary"(1 sentence). Keep source,url,image_url,published unchanged. Return ONLY valid JSON array. No markdown. Articles:${JSON.stringify(raw)}`, 3000)
      : await claude(`Today is ${today()}. Return ONLY a JSON array of 6 top financial news stories. Each:{"headline","summary","ticker","source","category","image_url":null}. No markdown.`);
    await kvSet('catalystpit:top_stories', JSON.stringify(stories));
    ok('catalystpit:top_stories');
  } catch(e) { fail('catalystpit:top_stories', e); }

  // ── 6. Claude-only feeds ──────────────────────────────────────────────
  const FEEDS = [
    { key:'catalystpit:short_squeeze',        prompt:`Today is ${today()}. Return ONLY a JSON array of 8 stocks with high short squeeze potential. Each:{"ticker","company","price":number,"shortFloat":number,"daysToCover":number,"borrowRate":number,"squeezeScore":number,"catalyst":string}. No markdown.` },
    { key:'catalystpit:earnings_intelligence', prompt:`Today is ${today()}. Return ONLY a JSON object: "upcoming":[5 companies reporting in next 5 days,each{"ticker","company","reportDate","timing":"BMO"|"AMC","epsEstimate":number,"revenueEstimate":string,"whisperNumber":number,"impliedMove":string}],"recent":[3 that just reported,each{"ticker","company","epsActual":number,"epsEstimate":number,"beat":bool,"revenueActual":string,"reaction":number}]. No markdown.` },
    { key:'catalystpit:institutional_moves',   prompt:`Today is ${today()}. Return ONLY a JSON array of 6 notable institutional position changes from recent 13F filings. Each:{"fund","manager","ticker","company","action":"New Position"|"Added"|"Reduced"|"Exited","shares":number,"value":number,"portfolioPct":number,"quarter":string}. No markdown.` },
  ];

  for (const { key, prompt } of FEEDS) {
    await sleep(1500);
    try {
      const data = await claude(prompt);
      await kvSet(key, JSON.stringify(data));
      ok(key);
    } catch(e) { fail(key, e); }
  }

  await kvSet('catalystpit:last_refresh', results.timestamp);
  return Response.json(results, { status:200 });
}
