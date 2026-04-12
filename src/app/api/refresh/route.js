export const runtime = 'nodejs';
export const maxDuration = 60;

const KV_TOKEN        = process.env.KV_REST_API_TOKEN;
const CRON_SECRET     = process.env.CRON_SECRET;
const GNEWS_KEY       = process.env.GNEWS_KEY;
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY; // twelvedata.com free — 800 req/day

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

// ── Twelve Data — works from Vercel, free 800 req/day ─────────────────────
async function fetchTwelveDataPrices(symbols) {
  if (!TWELVE_DATA_KEY) throw new Error('TWELVE_DATA_KEY not set');

  // Twelve Data supports batch requests — one call for all symbols
  const stockSyms  = symbols.filter(s => !s.includes('-'));
  const cryptoSyms = symbols.filter(s => s.includes('-'));

  const results = {};

  // Fetch stocks
  if (stockSyms.length) {
    const url = `https://api.twelvedata.com/quote?symbol=${stockSyms.join(',')}&apikey=${TWELVE_DATA_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Twelve Data ${res.status}`);
    const data = await res.json();

    // Single symbol returns object directly; multiple returns object keyed by symbol
    const items = stockSyms.length === 1 ? { [stockSyms[0]]: data } : data;
    for (const [sym, q] of Object.entries(items)) {
      if (q.status === 'error') continue;
      results[sym] = {
        price:     +parseFloat(q.close || q.price || 0).toFixed(2),
        change:    +parseFloat(q.change || 0).toFixed(2),
        changePct: +parseFloat(q.percent_change || 0).toFixed(2),
      };
    }
  }

  // Fetch crypto pairs (BTC-USD → BTC/USD format for Twelve Data)
  for (const sym of cryptoSyms) {
    try {
      const tdSym = sym.replace('-','/');
      const url   = `https://api.twelvedata.com/quote?symbol=${tdSym}&apikey=${TWELVE_DATA_KEY}`;
      const res   = await fetch(url);
      const q     = await res.json();
      if (q.status !== 'error') {
        results[sym] = {
          price:     +parseFloat(q.close || q.price || 0).toFixed(2),
          change:    +parseFloat(q.change || 0).toFixed(2),
          changePct: +parseFloat(q.percent_change || 0).toFixed(2),
        };
      }
    } catch {}
    await sleep(200); // small delay between crypto calls
  }

  return results;
}

// ── Yahoo Finance screener — for movers (this endpoint works from Vercel) ──
async function fetchYFMovers() {
  const YF = { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept:'application/json', Referer:'https://finance.yahoo.com/' };
  const [gRes, lRes] = await Promise.all([
    fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=4', { headers:YF }),
    fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_losers&count=2',  { headers:YF }),
  ]);
  const g = (await gRes.json())?.finance?.result?.[0]?.quotes || [];
  const l = (await lRes.json())?.finance?.result?.[0]?.quotes || [];
  return [...g,...l];
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

  // ── 1. Real-time prices — Twelve Data ─────────────────────────────────
  try {
    const TAPE = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','BTC-USD','ETH-USD'];
    const SNAP = ['SPY','QQQ','DIA','VIX','BTC-USD','ETH-USD','GLD','USO','AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD'];
    const qMap = await fetchTwelveDataPrices([...new Set([...TAPE,...SNAP])]);

    const tape = TAPE.map(s=>({ symbol:s, price:qMap[s]?.price||0, changePct:qMap[s]?.changePct||0 }));
    await kvSet('catalystpit:ticker_tape', JSON.stringify(tape)); ok('catalystpit:ticker_tape');

    const snapshot = Object.fromEntries(SNAP.map(s=>[s, qMap[s]||{price:0,change:0,changePct:0}]));
    await kvSet('catalystpit:market_snapshot', JSON.stringify(snapshot)); ok('catalystpit:market_snapshot');
  } catch(e) {
    fail('prices',e);
    // Claude fallback for prices if Twelve Data not set up yet
    try {
      const t = await claude(`Today is ${today()}. Return ONLY a JSON array with TODAY's real market prices for: AAPL,MSFT,NVDA,TSLA,AMZN,META,GOOGL,AMD,SPY,QQQ,BTC-USD,ETH-USD. Each: {"symbol":string,"price":number,"changePct":number}. No markdown.`);
      await kvSet('catalystpit:ticker_tape', JSON.stringify(t)); ok('ticker_tape (fallback)');
    } catch(e2) { fail('catalystpit:ticker_tape',e2); }
  }

  // ── 2. Movers — Yahoo screener (works from Vercel) + Claude reasons ───
  try {
    const movers = await fetchYFMovers();
    const base   = movers.map(q=>({ ticker:q.symbol, company:q.shortName||q.symbol, price:+(q.regularMarketPrice||0).toFixed(2), changePct:+(q.regularMarketChangePercent||0).toFixed(2) }));
    await sleep(300);
    const enriched = await claude(`Today is ${today()}. These stocks are moving right now: ${JSON.stringify(base)}. Add a "reason" explaining why each is moving today. Return ONLY the same JSON array with "reason" added. No markdown.`);
    await kvSet('catalystpit:why_moving', JSON.stringify(enriched)); ok('catalystpit:why_moving');
  } catch(e) { fail('catalystpit:why_moving',e); }

  // ── 3. Insider trades — SEC EDGAR + Claude enrichment ─────────────────
  await sleep(500);
  try {
    const raw      = await fetchSECInsiders();
    const enriched = await claude(`Today is ${today()}. These are real SEC Form 4 filings from last 24 hours: ${JSON.stringify(raw)}. Add executive name, title, Buy/Sell action, and transaction value for each. Return ONLY JSON array: [{"ticker","company","executive","title","action":"Buy"|"Sell","value":number,"date"}]. No markdown.`);
    await kvSet('catalystpit:insider_trades', JSON.stringify(enriched)); ok('catalystpit:insider_trades');
  } catch(e) { fail('catalystpit:insider_trades',e); }

  // ── 4. Politician trades — Claude (QuiverQuant upgrade path in Phase 2) ─
  await sleep(500);
  try {
    const politicians = await claude(`Today is ${today()}. Return ONLY a JSON array of 5 real recent congressional stock trades from the last 30 days based on actual STOCK Act disclosures. Use real politician names. Each: {"politician":string,"party":"D"|"R","chamber":"House"|"Senate","ticker":string,"company":string,"action":"Purchase"|"Sale","amount":string,"date":string}. No markdown.`);
    await kvSet('catalystpit:politician_trades', JSON.stringify(politicians)); ok('catalystpit:politician_trades');
  } catch(e) { fail('catalystpit:politician_trades',e); }

  // ── 5. News — GNews + Claude enrichment ──────────────────────────────
  await sleep(300);
  try {
    const raw    = await fetchGNews();
    const stories = raw?.length
      ? await claude(`Enrich these real news articles with finance metadata. For each add: "ticker","category" (Earnings|Macro|Insider|Squeeze|Crypto|Options|Tech|Markets|FED),"headline" (punchy max 12 words),"summary" (1 analyst sentence). Keep source,url,image_url,published unchanged. Return ONLY valid JSON array. No markdown. Articles: ${JSON.stringify(raw)}`, 3000)
      : await claude(`Today is ${today()}. Return ONLY a JSON array of 6 top financial news stories right now. Each: {"headline","summary","ticker","source","category","image_url":null}. No markdown.`);
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
