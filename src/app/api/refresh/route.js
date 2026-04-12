export const runtime = 'nodejs';
export const maxDuration = 60;

const KV_TOKEN      = process.env.KV_REST_API_TOKEN;
const CRON_SECRET   = process.env.CRON_SECRET;
const GNEWS_KEY     = process.env.GNEWS_KEY;
const POLYGON_KEY   = process.env.POLYGON_KEY; // polygon.io — Starter $29/mo for real-time

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

// ── Polygon.io ────────────────────────────────────────────────────────────
const P = (path) => `https://api.polygon.io${path}${path.includes('?')?'&':'?'}apiKey=${POLYGON_KEY}`;

async function polygonGet(path) {
  const res = await fetch(P(path));
  if (!res.ok) throw new Error(`Polygon ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchPolygonStockPrices(tickers) {
  // Snapshot endpoint — returns latest price, change, changePct for all tickers at once
  const syms = tickers.join(',');
  const data = await polygonGet(`/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${syms}`);
  const results = {};
  for (const t of (data.tickers || [])) {
    const day   = t.day   || {};
    const prevD = t.prevDay || {};
    const price = t.lastTrade?.p || day.c || 0;
    const prev  = prevD.c || price;
    const chg   = price - prev;
    const pct   = prev ? (chg / prev) * 100 : 0;
    results[t.ticker] = {
      price:     +price.toFixed(2),
      change:    +chg.toFixed(2),
      changePct: +pct.toFixed(2),
    };
  }
  return results;
}

async function fetchPolygonCryptoPrices(pairs) {
  // pairs like ['BTC-USD','ETH-USD'] → Polygon uses X:BTCUSD format
  const polyPairs = pairs.map(p => `X:${p.replace('-','')}`).join(',');
  const data = await polygonGet(`/v2/snapshot/locale/global/markets/crypto/tickers?tickers=${polyPairs}`);
  const results = {};
  for (const t of (data.tickers || [])) {
    const day  = t.day   || {};
    const prev = t.prevDay?.c || day.o || day.c || 0;
    const price = day.c || t.lastTrade?.p || 0;
    const chg  = price - prev;
    const pct  = prev ? (chg / prev) * 100 : 0;
    // Convert X:BTCUSD back to BTC-USD
    const sym = t.ticker.replace('X:','').replace(/([A-Z]+)(USD)/, '$1-$2');
    results[sym] = {
      price:     +price.toFixed(2),
      change:    +chg.toFixed(2),
      changePct: +pct.toFixed(2),
    };
  }
  return results;
}

async function fetchPolygonMovers() {
  const [gainData, loseData] = await Promise.all([
    polygonGet('/v2/snapshot/locale/us/markets/stocks/gainers'),
    polygonGet('/v2/snapshot/locale/us/markets/stocks/losers'),
  ]);
  const gainers = (gainData.tickers || []).slice(0, 3).map(t => ({
    ticker:    t.ticker,
    company:   t.ticker,
    price:     +(t.day?.c || 0).toFixed(2),
    changePct: +(t.todaysChangePerc || 0).toFixed(2),
  }));
  const losers = (loseData.tickers || []).slice(0, 3).map(t => ({
    ticker:    t.ticker,
    company:   t.ticker,
    price:     +(t.day?.c || 0).toFixed(2),
    changePct: +(t.todaysChangePerc || 0).toFixed(2),
  }));
  return [...gainers, ...losers];
}

// ── SEC EDGAR Form 4 ──────────────────────────────────────────────────────
async function fetchSECInsiders() {
  const res = await fetch(
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=30&output=atom',
    { headers:{ 'User-Agent':'CatalystPit contact@catalystpit.com' } }
  );
  if (!res.ok) throw new Error(`SEC ${res.status}`);
  const xml     = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m=>m[1]);
  return entries.slice(0,12).map(e => {
    const title = e.match(/<title>(.*?)<\/title>/)?.[1]||'';
    const date  = (e.match(/<updated>(.*?)<\/updated>/)?.[1]||'').split('T')[0];
    const m     = title.match(/4 - (.+?) \((\w{1,5})\)/);
    return { company:m?.[1]?.trim()||title, ticker:m?.[2]?.toUpperCase()||'', date };
  }).filter(t=>t.ticker && t.ticker.length<=5).slice(0,6);
}

// ── GNews ─────────────────────────────────────────────────────────────────
async function fetchGNews() {
  if (!GNEWS_KEY) return null;
  const res = await fetch(`https://gnews.io/api/v4/top-headlines?category=business&lang=en&max=10&apikey=${GNEWS_KEY}`);
  if (!res.ok) return null;
  return (await res.json()).articles?.filter(a=>a.image&&a.title).map(a=>({
    title:a.title, source:a.source?.name||'News', url:a.url, image_url:a.image, published:a.publishedAt
  })) || null;
}

// ── MAIN ──────────────────────────────────────────────────────────────────
export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron')==='1';
  if (!isVercelCron && request.headers.get('authorization')!==`Bearer ${CRON_SECRET}`)
    return Response.json({ error:'Unauthorized' }, { status:401 });

  const results = { refreshed:[], failed:[], timestamp:new Date().toISOString() };
  const ok   = k     => { results.refreshed.push(k); console.log(`✅ ${k}`); };
  const fail = (k,e) => { results.failed.push({key:k,error:e.message}); console.error(`❌ ${k}:`,e.message); };

  // ── 1. Real-time prices — Polygon.io ──────────────────────────────────
  try {
    const STOCK_SYMS  = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','DIA','VIX','GLD','USO'];
    const CRYPTO_SYMS = ['BTC-USD','ETH-USD'];

    const [stockPrices, cryptoPrices] = await Promise.all([
      fetchPolygonStockPrices(STOCK_SYMS),
      fetchPolygonCryptoPrices(CRYPTO_SYMS),
    ]);

    const prices = { ...stockPrices, ...cryptoPrices };

    // Ticker tape — 12 core symbols
    const TAPE_SYMS = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','BTC-USD','ETH-USD'];
    const tape = TAPE_SYMS.map(s => ({ symbol:s, ...(prices[s] || {price:0,change:0,changePct:0}) }));
    await kvSet('catalystpit:ticker_tape', JSON.stringify(tape)); ok('catalystpit:ticker_tape');

    // Market snapshot — full set
    const SNAP_SYMS = ['SPY','QQQ','DIA','VIX','GLD','USO','BTC-USD','ETH-USD','AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD'];
    const snapshot  = Object.fromEntries(SNAP_SYMS.map(s => [s, prices[s] || {price:0,change:0,changePct:0}]));
    await kvSet('catalystpit:market_snapshot', JSON.stringify(snapshot)); ok('catalystpit:market_snapshot');
  } catch(e) { fail('prices',e); }

  // ── 2. Real movers — Polygon gainers/losers ───────────────────────────
  await sleep(300);
  try {
    const base = await fetchPolygonMovers();
    const enriched = await claude(`Today is ${today()}. These stocks are the top movers right now: ${JSON.stringify(base)}. Add a "reason" and "name" field to each (full company name, and brief reason why it's moving today). Return ONLY the same JSON array with "name" and "reason" added. No markdown.`);
    await kvSet('catalystpit:why_moving', JSON.stringify(enriched)); ok('catalystpit:why_moving');
  } catch(e) { fail('catalystpit:why_moving',e); }

  // ── 3. Insider trades — SEC EDGAR + Claude enrichment ─────────────────
  await sleep(500);
  try {
    const raw      = await fetchSECInsiders();
    const enriched = await claude(`Today is ${today()}. These are real SEC Form 4 filings from the last 24 hours: ${JSON.stringify(raw)}. For each add: executive name, title, Buy or Sell action, and transaction value. Return ONLY JSON array: [{"ticker","company","executive","title","action":"Buy"|"Sell","value":number,"date"}]. No markdown.`);
    await kvSet('catalystpit:insider_trades', JSON.stringify(enriched)); ok('catalystpit:insider_trades');
  } catch(e) { fail('catalystpit:insider_trades',e); }

  // ── 4. Politician trades — Claude (upgrade to QuiverQuant in Phase 2) ──
  await sleep(500);
  try {
    const politicians = await claude(`Today is ${today()}. Return ONLY a JSON array of 5 real recent congressional stock trades from the last 30 days based on actual STOCK Act disclosures. Use real politician names and real tickers. Each: {"politician":string,"party":"D"|"R","chamber":"House"|"Senate","ticker":string,"company":string,"action":"Purchase"|"Sale","amount":string,"date":string}. No markdown.`);
    await kvSet('catalystpit:politician_trades', JSON.stringify(politicians)); ok('catalystpit:politician_trades');
  } catch(e) { fail('catalystpit:politician_trades',e); }

  // ── 5. News — GNews + Claude enrichment ──────────────────────────────
  await sleep(300);
  try {
    const raw    = await fetchGNews();
    const stories = raw?.length
      ? await claude(`Enrich these real news articles with finance metadata. For each add: "ticker","category"(Earnings|Macro|Insider|Squeeze|Crypto|Options|Tech|Markets|FED),"headline"(punchy max 12 words),"summary"(1 analyst sentence). Keep source,url,image_url,published unchanged. Return ONLY valid JSON array. No markdown. Articles: ${JSON.stringify(raw)}`, 3000)
      : await claude(`Today is ${today()}. Return ONLY a JSON array of 6 top financial news stories. Each: {"headline","summary","ticker","source","category","image_url":null}. No markdown.`);
    await kvSet('catalystpit:top_stories', JSON.stringify(stories)); ok('catalystpit:top_stories');
  } catch(e) { fail('catalystpit:top_stories',e); }

  // ── 6. Claude-only feeds ──────────────────────────────────────────────
  const FEEDS = [
    { key:'catalystpit:short_squeeze',         prompt:`Today is ${today()}. Return ONLY a JSON array of 8 stocks with high short squeeze potential right now. Each: {"ticker","company","price":number,"shortFloat":number,"daysToCover":number,"borrowRate":number,"squeezeScore":number,"catalyst":string}. No markdown.` },
    { key:'catalystpit:earnings_intelligence',  prompt:`Today is ${today()}. Return ONLY a JSON object: "upcoming":[5 companies reporting earnings in next 5 days, each {"ticker","company","reportDate","timing":"BMO"|"AMC","epsEstimate":number,"revenueEstimate":string,"whisperNumber":number,"impliedMove":string}],"recent":[3 that just reported, each {"ticker","company","epsActual":number,"epsEstimate":number,"beat":bool,"revenueActual":string,"reaction":number}]. No markdown.` },
    { key:'catalystpit:institutional_moves',    prompt:`Today is ${today()}. Return ONLY a JSON array of 6 notable institutional position changes from recent 13F filings. Each: {"fund","manager","ticker","company","action":"New Position"|"Added"|"Reduced"|"Exited","shares":number,"value":number,"portfolioPct":number,"quarter":string}. No markdown.` },
  ];

  for (const { key, prompt } of FEEDS) {
    await sleep(1500);
    try {
      const data = await claude(prompt);
      await kvSet(key, JSON.stringify(data)); ok(key);
    } catch(e) { fail(key,e); }
  }

  await kvSet('catalystpit:last_refresh', results.timestamp);
  return Response.json(results, { status:200 });
}
