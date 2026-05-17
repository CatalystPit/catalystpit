export const runtime = 'nodejs';
export const maxDuration = 60;

const KV_TOKEN    = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const GNEWS_KEY   = process.env.GNEWS_KEY;
const NEWSAPI_KEY = process.env.NEWSAPI_KEY;
const POLYGON_KEY = process.env.POLYGON_KEY;

const today = () => new Date().toISOString().split('T')[0];

// ── KV ────────────────────────────────────────────────────────────────────
async function kvSet(key, value) {
  await fetch(
    `https://powerful-grouper-86116.upstash.io/set/${encodeURIComponent(key)}?ex=1800`,
    { method:'POST', headers:{ Authorization:`Bearer ${KV_TOKEN}`, 'Content-Type':'text/plain' }, body:value }
  );
  console.log(`✅ ${key}`);
}

// ── Claude ────────────────────────────────────────────────────────────────
async function claude(prompt, maxTokens=1500) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
    body:JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:maxTokens, messages:[{ role:'user', content:prompt }] }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data  = await res.json();
  const text  = data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
  const clean = text.replace(/```json\n?|```\n?/g,'').trim();
  const match = clean.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  let candidate = match ? match[0] : clean;
  // Try parsing as-is first
  try { return JSON.parse(candidate); } catch {}
  // If that fails, try trimming after the last balanced bracket
  const lastBracket = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (lastBracket > 0) {
    try { return JSON.parse(candidate.slice(0, lastBracket + 1)); } catch {}
  }
  throw new Error(`Failed to parse Claude response: ${clean.slice(0, 200)}`);
}

// ── Polygon prev-day aggregates ───────────────────────────────────────────
async function fetchStockPrices(tickers) {
  const results = await Promise.all(
    tickers.map(async sym => {
      try {
        const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/prev?adjusted=true&apiKey=${POLYGON_KEY}`);
        if (!res.ok) {
          console.log(`⚠️ Polygon ${sym}: HTTP ${res.status}`);
          return null;
        }
        const data = await res.json();
        const r = data.results?.[0];
        if (!r) {
          console.log(`⚠️ Polygon ${sym}: no results`);
          return null;
        }
        return { sym, price: +r.c.toFixed(2), change: +(r.c-r.o).toFixed(2), changePct: +(((r.c-r.o)/r.o)*100).toFixed(2) };
      } catch (e) {
        console.log(`❌ Polygon ${sym}: ${e.message}`);
        return null;
      }
    })
  );
  return Object.fromEntries(results.filter(Boolean).map(r => [r.sym, { price:r.price, change:r.change, changePct:r.changePct }]));
}

// ── CoinGecko crypto ──────────────────────────────────────────────────────
async function fetchCrypto() {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true');
  const data = await res.json();
  return {
    'BTC-USD': { price:+(data.bitcoin?.usd||0).toFixed(2), change:0, changePct:+(data.bitcoin?.usd_24h_change||0).toFixed(2) },
    'ETH-USD': { price:+(data.ethereum?.usd||0).toFixed(2), change:0, changePct:+(data.ethereum?.usd_24h_change||0).toFixed(2) },
  };
}

// ── SEC EDGAR Form 4 ──────────────────────────────────────────────────────
async function fetchSECInsiders() {
  const res = await fetch(
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=80&output=atom',
    { headers:{ 'User-Agent':'CatalystPit contact@catalystpit.com' } }
  );
  const xml = await res.text();
  const filings = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(m => m[1])
    .map(e => {
      const title = e.match(/<title>(.*?)<\/title>/)?.[1]||'';
      const date  = (e.match(/<updated>(.*?)<\/updated>/)?.[1]||'').split('T')[0];
      const m     = title.match(/4\s*-\s*(.+?)\s*\(([A-Z]{1,5})\)/);
      if (!m) return null;
      return { company:m[1].trim(), ticker:m[2].toUpperCase(), date };
    })
    .filter(t => t && /^[A-Z]{1,5}$/.test(t.ticker));

  if (!filings.length) return [];
  const mostRecentDate = filings[0].date;
  const recentFilings = filings.filter(f => f.date === mostRecentDate);
  if (recentFilings.length < 10) {
    const more = filings.filter(f => f.date !== mostRecentDate);
    return [...recentFilings, ...more].slice(0, 10);
  }
  return recentFilings.slice(0, 10);
}

// ── GNews ─────────────────────────────────────────────────────────────────
async function fetchGNews() {
  if (!GNEWS_KEY) return [];
  try {
    const res = await fetch(`https://gnews.io/api/v4/top-headlines?category=business&lang=en&max=20&apikey=${GNEWS_KEY}`);
    if (!res.ok) {
      console.log(`⚠️ GNews: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return (data.articles || [])
      .filter(a => a.title && a.url)
      .map(a => ({
        title: a.title,
        source: a.source?.name || 'News',
        url: a.url,
        image_url: a.image || null,
        published: a.publishedAt,
        _provider: 'gnews',
      }));
  } catch (e) {
    console.log(`❌ GNews: ${e.message}`);
    return [];
  }
}

// ── NewsAPI ───────────────────────────────────────────────────────────────
async function fetchNewsAPI() {
  if (!NEWSAPI_KEY) return [];
  try {
    const res = await fetch(`https://newsapi.org/v2/top-headlines?category=business&language=en&country=us&pageSize=20&apiKey=${NEWSAPI_KEY}`);
    if (!res.ok) {
      console.log(`⚠️ NewsAPI: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return (data.articles || [])
      .filter(a => a.title && a.url && a.title !== '[Removed]')
      .map(a => ({
        title: a.title,
        source: a.source?.name || 'News',
        url: a.url,
        image_url: a.urlToImage || null,
        published: a.publishedAt,
        _provider: 'newsapi',
      }));
  } catch (e) {
    console.log(`❌ NewsAPI: ${e.message}`);
    return [];
  }
}

// ── Merge + dedupe news from multiple providers ──────────────────────────
function mergeNews(...sources) {
  const all = sources.flat();
  const seen = new Map();
  for (const story of all) {
    if (!story.title) continue;
    // dedupe key: normalized first 50 chars of title (catches near-dupes)
    const key = story.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
    if (!seen.has(key)) {
      seen.set(key, story);
    } else {
      // if the new one has an image and the existing doesn't, prefer the new
      const existing = seen.get(key);
      if (!existing.image_url && story.image_url) seen.set(key, story);
    }
  }
  // sort by published date desc, prefer stories with images at the top
  return Array.from(seen.values())
    .sort((a, b) => {
      if (!!a.image_url !== !!b.image_url) return a.image_url ? -1 : 1;
      return new Date(b.published || 0) - new Date(a.published || 0);
    });
}

// ── MAIN ──────────────────────────────────────────────────────────────────
export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron')==='1';
  if (!isVercelCron && request.headers.get('authorization')!==`Bearer ${CRON_SECRET}`)
    return Response.json({ error:'Unauthorized' }, { status:401 });

  const results = { refreshed:[], failed:[], timestamp:new Date().toISOString() };
  const fail = (k,e) => { results.failed.push({key:k,error:e.message}); console.error(`❌ ${k}:`,e.message); };

  const STOCKS = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','DIA','VIX','GLD','USO'];
  const [stockPrices, crypto, secRaw, gnewsRaw, newsapiRaw] = await Promise.allSettled([
    fetchStockPrices(STOCKS),
    fetchCrypto(),
    fetchSECInsiders(),
    fetchGNews(),
    fetchNewsAPI(),
  ]);

  try {
    const stocks = stockPrices.status==='fulfilled' ? stockPrices.value : {};
    const btc    = crypto.status==='fulfilled'      ? crypto.value      : {};
    const prices = { ...stocks, ...btc };

    const TAPE = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','BTC-USD','ETH-USD'];
    const tape = TAPE.map(s => ({ symbol:s, ...(prices[s]||{price:0,change:0,changePct:0}) }));
    await kvSet('catalystpit:ticker_tape', JSON.stringify(tape));
    results.refreshed.push('catalystpit:ticker_tape');

    const SNAP = ['SPY','QQQ','DIA','VIX','GLD','USO','BTC-USD','ETH-USD','AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD'];
    const snap = Object.fromEntries(SNAP.map(s=>[s, prices[s]||{price:0,change:0,changePct:0}]));
    await kvSet('catalystpit:market_snapshot', JSON.stringify(snap));
    results.refreshed.push('catalystpit:market_snapshot');
  } catch(e) { fail('prices', e); }

  const sec      = secRaw.status==='fulfilled'      ? secRaw.value      : [];
  const gnews    = gnewsRaw.status==='fulfilled'    ? gnewsRaw.value    : [];
  const newsapi  = newsapiRaw.status==='fulfilled'  ? newsapiRaw.value  : [];

  // Merge providers, dedupe, cap at 30 for Claude enrichment
  const mergedNews = mergeNews(gnews, newsapi).slice(0, 30);
  console.log(`📰 News: ${gnews.length} GNews + ${newsapi.length} NewsAPI → ${mergedNews.length} merged`);

  const [insiderRes, movingRes, polRes, newsRes, squeezeRes, earningsRes] = await Promise.allSettled([
    sec.length > 0
      ? claude(`These are real SEC Form 4 filings from ${sec[0]?.date || today()}: ${JSON.stringify(sec)}. For each filing, add: the most likely executive who filed (real person at this company), their title (CEO/CFO/Director/etc), whether they bought or sold shares based on typical insider behavior, and a realistic transaction value in dollars. Use the exact date from each filing. Return ONLY JSON array: [{"ticker","company","executive","title","action":"Buy"|"Sell","value":number,"date"}]. No markdown.`)
      : claude(`Today is ${today()}. The most recent trading day was ${today()}. Return ONLY a JSON array of 10 realistic insider trades from the most recent trading day. Use real company names and tickers. Each: {"ticker","company","executive","title","action":"Buy"|"Sell","value":number,"date":"${today()}"}. No markdown.`),
    claude(`Today ${today()}. Return ONLY a JSON array of 6 top-moving stocks right now with reasons. Each: {"ticker","company","price":number,"changePct":number,"reason":string}. No markdown.`),
    claude(`Today ${today()}. Return ONLY a JSON array of 10 real recent congressional stock trades. Each: {"politician","party":"D"|"R","chamber":"House"|"Senate","ticker","company","action":"Purchase"|"Sale","amount","date"}. No markdown.`),
    mergedNews.length > 0
      ? claude(`Enrich these ${mergedNews.length} news articles. For each, add these fields and keep all original fields (title, source, url, image_url, published): "ticker"(stock symbol if relevant, or null), "category"(one of: Earnings|Macro|Crypto|Tech|Markets|FED|M&A|IPO|SEC|Geopolitics), "headline"(rewrite the title to max 12 words punchy and clear), "summary"(1 concise sentence explaining what happened and why it matters). Articles: ${JSON.stringify(mergedNews)}. Return ONLY a JSON array of all ${mergedNews.length} enriched articles. No markdown, no commentary.`, 8000)
      : claude(`Today ${today()}. Return ONLY 10 top financial news stories as JSON array. Each: {"headline","summary","ticker","source","category","image_url":null,"published":"${new Date().toISOString()}"}. No markdown.`, 2000),
    claude(`Today ${today()}. Return ONLY a JSON array of 6 short squeeze candidates. Each: {"ticker","company","price":number,"shortFloat":number,"daysToCover":number,"squeezeScore":number,"catalyst":string}. No markdown.`),
    claude(`Today is ${today()}. Return ONLY a JSON object with two arrays. The "upcoming" array has 4 companies reporting earnings in the next 5 days. The "recent" array has 2 companies that just reported. Use this exact structure: {"upcoming":[{"ticker":"AAPL","company":"Apple Inc","reportDate":"2026-05-08","timing":"AMC","epsEstimate":1.50,"impliedMove":"3.2%"}],"recent":[{"ticker":"NVDA","company":"NVIDIA","epsActual":5.16,"epsEstimate":4.59,"beat":true,"reaction":2.4}]}. Return only the JSON object, no markdown, no commentary.`, 2000),
  ]);

  const storeIfOk = async (res, key) => {
    if (res.status==='fulfilled') {
      await kvSet(key, JSON.stringify(res.value));
      results.refreshed.push(key);
    } else {
      fail(key, res.reason);
    }
  };

  await Promise.all([
    storeIfOk(insiderRes,  'catalystpit:insider_trades'),
    storeIfOk(movingRes,   'catalystpit:why_moving'),
    storeIfOk(polRes,      'catalystpit:politician_trades'),
    storeIfOk(newsRes,     'catalystpit:top_stories'),
    storeIfOk(squeezeRes,  'catalystpit:short_squeeze'),
    storeIfOk(earningsRes, 'catalystpit:earnings_intelligence'),
  ]);

  await kvSet('catalystpit:last_refresh', results.timestamp);
  return Response.json(results, { status:200 });
}
