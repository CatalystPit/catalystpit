export const runtime = 'nodejs';
export const maxDuration = 60;

const KV_TOKEN    = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const GNEWS_KEY   = process.env.GNEWS_KEY;
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
  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const data  = await res.json();
  const text  = data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
  const clean = text.replace(/```json\n?|```\n?/g,'').trim();
  const match = clean.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  return JSON.parse(match ? match[0] : clean);
}

// ── Polygon prev-day aggregates ───────────────────────────────────────────
async function fetchStockPrices(tickers) {
  const results = await Promise.all(
    tickers.map(async sym => {
      try {
        const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/prev?adjusted=true&apiKey=${POLYGON_KEY}`);
        const data = await res.json();
        const r = data.results?.[0];
        if (!r) return null;
        return { sym, price:+r.c.toFixed(2), change:+(r.c-r.o).toFixed(2), changePct:+(((r.c-r.o)/r.o)*100).toFixed(2) };
      } catch { return null; }
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
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=40&output=atom',
    { headers:{ 'User-Agent':'CatalystPit contact@catalystpit.com' } }
  );
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(m => m[1])
    .map(e => {
      const title = e.match(/<title>(.*?)<\/title>/)?.[1]||'';
      const date  = (e.match(/<updated>(.*?)<\/updated>/)?.[1]||'').split('T')[0];
      const m     = title.match(/4\s*-\s*(.+?)\s*\(([A-Z]{1,5})\)/);
      if (!m) return null;
      return { company:m[1].trim(), ticker:m[2].toUpperCase(), date };
    })
    .filter(t => t && /^[A-Z]{1,5}$/.test(t.ticker))
    .slice(0, 8);
}

// ── GNews ─────────────────────────────────────────────────────────────────
async function fetchGNews() {
  if (!GNEWS_KEY) return null;
  try {
    const res = await fetch(`https://gnews.io/api/v4/top-headlines?category=business&lang=en&max=8&apikey=${GNEWS_KEY}`);
    const data = await res.json();
    return data.articles?.filter(a=>a.image&&a.title).map(a=>({
      title:a.title, source:a.source?.name||'News', url:a.url, image_url:a.image, published:a.publishedAt
    })) || null;
  } catch { return null; }
}

// ── MAIN ──────────────────────────────────────────────────────────────────
export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron')==='1';
  if (!isVercelCron && request.headers.get('authorization')!==`Bearer ${CRON_SECRET}`)
    return Response.json({ error:'Unauthorized' }, { status:401 });

  const results = { refreshed:[], failed:[], timestamp:new Date().toISOString() };
  const fail = (k,e) => { results.failed.push({key:k,error:e.message}); console.error(`❌ ${k}:`,e.message); };

  // ── PHASE 1: Fetch all raw data in parallel ───────────────────────────
  const STOCKS = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','DIA','VIX','GLD','USO'];
  const [stockPrices, crypto, secRaw, gnewsRaw] = await Promise.allSettled([
    fetchStockPrices(STOCKS),
    fetchCrypto(),
    fetchSECInsiders(),
    fetchGNews(),
  ]);

  // ── PHASE 2: Store prices immediately ────────────────────────────────
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

  // ── PHASE 3: All Claude calls in parallel ─────────────────────────────
  const sec    = secRaw.status==='fulfilled'   ? secRaw.value   : [];
  const gnews  = gnewsRaw.status==='fulfilled' ? gnewsRaw.value : null;

  const [insiderRes, movingRes, polRes, newsRes, squeezeRes, earningsRes] = await Promise.allSettled([

    // Insider trades
    sec.length > 0
      ? claude(`Today ${today()}. Real SEC Form 4 filings: ${JSON.stringify(sec)}. For each add executive name, title, Buy or Sell action, dollar value. Return ONLY JSON array: [{"ticker","company","executive","title","action":"Buy"|"Sell","value":number,"date"}]. No markdown.`)
      : claude(`Today ${today()}. Return ONLY a JSON array of 6 realistic recent insider trades. Each: {"ticker","company","executive","title","action":"Buy"|"Sell","value":number,"date"}. No markdown.`),

    // Why moving
    claude(`Today ${today()}. Return ONLY a JSON array of 6 top-moving stocks right now with reasons. Each: {"ticker","company","price":number,"changePct":number,"reason":string}. No markdown.`),

    // Politician trades
    claude(`Today ${today()}. Return ONLY a JSON array of 5 real recent congressional stock trades. Each: {"politician","party":"D"|"R","chamber":"House"|"Senate","ticker","company","action":"Purchase"|"Sale","amount","date"}. No markdown.`),

    // News
    gnews?.length
      ? claude(`Enrich these news articles: ${JSON.stringify(gnews.slice(0,6))}. For each add "ticker","category"(Earnings|Macro|Crypto|Tech|Markets|FED),"headline"(max 10 words),"summary"(1 sentence). Keep source,url,image_url,published. Return ONLY JSON array. No markdown.`, 2000)
      : claude(`Today ${today()}. Return ONLY 6 top financial news stories as JSON array. Each: {"headline","summary","ticker","source","category","image_url":null}. No markdown.`),

    // Short squeeze
    claude(`Today ${today()}. Return ONLY a JSON array of 6 short squeeze candidates. Each: {"ticker","company","price":number,"shortFloat":number,"daysToCover":number,"squeezeScore":number,"catalyst":string}. No markdown.`),

    // Earnings
    claude(`Today ${today()}. Return ONLY JSON: {"upcoming":[4 companies reporting in next 5 days, each {"ticker","company","reportDate","timing":"BMO"|"AMC","epsEstimate":number,"impliedMove":string}],"recent":[2 that just reported, each {"ticker","company","epsActual":number,"epsEstimate":number,"beat":bool,"reaction":number}]}. No markdown.`),
  ]);

  // ── PHASE 4: Store all results ────────────────────────────────────────
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
