export const runtime = 'nodejs';
export const maxDuration = 30;

const KV_TOKEN     = process.env.KV_REST_API_TOKEN;
const CRON_SECRET  = process.env.CRON_SECRET;
const POLYGON_KEY  = process.env.POLYGON_KEY;
const GNEWS_KEY    = process.env.GNEWS_KEY;
const NEWSAPI_KEY  = process.env.NEWSAPI_KEY;
const FINNHUB_KEY  = process.env.FINNHUB_KEY;

const NEWS_TICKERS = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','NFLX','GOOG','JPM','BAC','XOM','WMT','COIN','PLTR','BA','DIS','UBER','SHOP'];

async function kvSet(key, value) {
  await fetch(
    `https://powerful-grouper-86116.upstash.io/set/${encodeURIComponent(key)}?ex=3600`,
    { method:'POST', headers:{ Authorization:`Bearer ${KV_TOKEN}`, 'Content-Type':'text/plain' }, body:value }
  );
  console.log(`✅ ${key}`);
}

async function fetchStockPrices(tickers) {
  const results = await Promise.all(
    tickers.map(async sym => {
      try {
        const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/prev?adjusted=true&apiKey=${POLYGON_KEY}`);
        if (!res.ok) return null;
        const data = await res.json();
        const r = data.results?.[0];
        if (!r) return null;
        return { sym, price: +r.c.toFixed(2), change: +(r.c-r.o).toFixed(2), changePct: +(((r.c-r.o)/r.o)*100).toFixed(2) };
      } catch { return null; }
    })
  );
  return Object.fromEntries(results.filter(Boolean).map(r => [r.sym, { price:r.price, change:r.change, changePct:r.changePct }]));
}

async function fetchCrypto() {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true');
  const data = await res.json();
  return {
    'BTC-USD': { price:+(data.bitcoin?.usd||0).toFixed(2), change:0, changePct:+(data.bitcoin?.usd_24h_change||0).toFixed(2) },
    'ETH-USD': { price:+(data.ethereum?.usd||0).toFixed(2), change:0, changePct:+(data.ethereum?.usd_24h_change||0).toFixed(2) },
  };
}

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

// ── Finnhub PER-TICKER news (the right way) ──────────────────────────────
async function fetchFinnhubPerTicker() {
  if (!FINNHUB_KEY) return [];
  // Date range: last 3 days
  const to = new Date();
  const from = new Date(to.getTime() - 3 * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().split('T')[0];

  try {
    const results = await Promise.all(
      NEWS_TICKERS.map(async ticker => {
        try {
          const res = await fetch(
            `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fmt(from)}&to=${fmt(to)}&token=${FINNHUB_KEY}`
          );
          if (!res.ok) return [];
          const data = await res.json();
          return (data || []).slice(0, 3).map(a => ({
            title: a.headline,
            source: a.source || 'Finnhub',
            url: a.url,
            image_url: a.image || null,
            published: new Date(a.datetime * 1000).toISOString(),
            ticker, // we KNOW the ticker because we asked for it
            _provider: 'finnhub-ticker',
            _rank: 1,
          })).filter(a => a.title && a.url);
        } catch { return []; }
      })
    );
    return results.flat();
  } catch (e) {
    console.log(`❌ Finnhub per-ticker: ${e.message}`);
    return [];
  }
}

// ── Finnhub general market news (Fed, macro, broad) ──────────────────────
async function fetchFinnhubMarket() {
  if (!FINNHUB_KEY) return [];
  try {
    const res = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data || [])
      .filter(a => a.headline && a.url)
      .slice(0, 30)
      .map(a => ({
        title: a.headline,
        source: a.source || 'Finnhub',
        url: a.url,
        image_url: a.image || null,
        published: new Date(a.datetime * 1000).toISOString(),
        ticker: null,
        _provider: 'finnhub-market',
        _rank: 2,
      }));
  } catch (e) {
    console.log(`❌ Finnhub market: ${e.message}`);
    return [];
  }
}

// ── GNews business ───────────────────────────────────────────────────────
async function fetchGNews() {
  if (!GNEWS_KEY) return [];
  try {
    const res = await fetch(`https://gnews.io/api/v4/top-headlines?category=business&lang=en&country=us&max=20&apikey=${GNEWS_KEY}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.articles || [])
      .filter(a => a.title && a.url && a.title !== '[Removed]')
      .map(a => ({
        title: a.title,
        source: a.source?.name || 'News',
        url: a.url,
        image_url: a.image || null,
        published: a.publishedAt,
        ticker: null,
        _provider: 'gnews',
        _rank: 4,
      }));
  } catch { return []; }
}

// ── NewsAPI business ─────────────────────────────────────────────────────
async function fetchNewsAPI() {
  if (!NEWSAPI_KEY) return [];
  try {
    const res = await fetch(`https://newsapi.org/v2/top-headlines?category=business&language=en&country=us&pageSize=20&apiKey=${NEWSAPI_KEY}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.articles || [])
      .filter(a => a.title && a.url && a.title !== '[Removed]')
      .map(a => ({
        title: a.title,
        source: a.source?.name || 'News',
        url: a.url,
        image_url: a.urlToImage || null,
        published: a.publishedAt,
        ticker: null,
        _provider: 'newsapi',
        _rank: 3,
      }));
  } catch { return []; }
}

// ── HARD BLOCKLIST — these die regardless of source ──────────────────────
const HARD_BLOCK = [
  // Sports
  'ufc','mma','nfl','nba','nhl','mlb','wnba','ncaa','espn','fight night',
  'super bowl','world cup','olympic','olympics','playoff','playoffs','draft pick',
  'football','basketball','baseball','soccer','tennis','golf tournament','pga','formula 1','f1 race',
  'mcgregor','ngannou','khabib','jon jones',
  // Entertainment & celebrities
  'taylor swift','travis kelce','kardashian','kanye','beyonce','drake',
  'oscar','grammy','emmy','cannes','met gala','red carpet',
  'movie review','box office','netflix series','tv show','reality tv',
  // Lifestyle / non-finance
  'recipe','restaurant review','travel destination','vacation','lounge review',
  'horoscope','astrology','dating',
  // Local US politics that isn't markets-related
  'gubernatorial','school board','mayor election','city council',
];

function hasBlockedTerm(article) {
  const t = (article.title || '').toLowerCase();
  return HARD_BLOCK.some(b => t.includes(b));
}

// Strict finance whitelist for non-Finnhub sources
const FINANCE_KEYWORDS = [
  'stock','stocks','shares','equity','bond','treasury','etf','futures','option','options',
  'crypto','bitcoin','ethereum',
  'earnings','revenue','eps','guidance','quarterly','beats','misses','q1','q2','q3','q4',
  'nyse','nasdaq','dow','s&p','wall street','sec','fdic','ipo',
  'merger','acquisition','buyback','dividend','spinoff','bankruptcy',
  'fed','federal reserve','powell','rate hike','rate cut','interest rate','inflation','cpi','ppi','gdp',
  'recession','yield','jobs report','unemployment',
  'rally','plunge','surge','soar','tumble','crash','jumps','slides','climbs',
  'bull','bear','bullish','bearish',
  'billion','trillion','market cap','valuation',
];

const TRUSTED_SOURCES = [
  'reuters','bloomberg','cnbc','wsj','wall street journal','financial times','ft.com',
  'marketwatch','yahoo finance','investing.com','seeking alpha','barron',
  'forbes','fortune','business insider','thestreet',
  'benzinga','zacks','morningstar','motley fool','investorplace',
  'kitco','coindesk','cointelegraph','finnhub',
];

function isFinanceRelevant(article) {
  // Hard block always wins
  if (hasBlockedTerm(article)) return false;
  // Finnhub per-ticker is always relevant (we asked about a specific ticker)
  if (article._provider === 'finnhub-ticker') return true;
  // For all other sources, require BOTH a trusted source OR a finance keyword in the title
  const title = (article.title || '').toLowerCase();
  const source = (article.source || '').toLowerCase();
  const trustedSource = TRUSTED_SOURCES.some(s => source.includes(s));
  const financeKw = FINANCE_KEYWORDS.some(k => title.includes(k));
  // For Finnhub general market, require finance keyword (their general feed has noise)
  if (article._provider === 'finnhub-market') return financeKw;
  // For NewsAPI/GNews business category, require trusted source AND finance keyword (strictest)
  return trustedSource && financeKw;
}

function mergeNews(...sources) {
  const all = sources.flat();
  const seen = new Map();
  for (const story of all) {
    if (!story.title) continue;
    if (!isFinanceRelevant(story)) continue;
    const key = story.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
    if (!seen.has(key)) {
      seen.set(key, story);
    } else {
      const existing = seen.get(key);
      if (story._rank < existing._rank || (!existing.image_url && story.image_url)) {
        seen.set(key, story);
      }
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => {
      if (a._rank !== b._rank) return a._rank - b._rank;
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
  const [stockPrices, crypto, secRaw, finnhubTickerRaw, finnhubMarketRaw, gnewsRaw, newsapiRaw] = await Promise.allSettled([
    fetchStockPrices(STOCKS),
    fetchCrypto(),
    fetchSECInsiders(),
    fetchFinnhubPerTicker(),
    fetchFinnhubMarket(),
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

  try {
    const sec = secRaw.status === 'fulfilled' ? secRaw.value : [];
    await kvSet('catalystpit:_raw_sec', JSON.stringify(sec));
    results.refreshed.push('catalystpit:_raw_sec');

    const finnhubTicker = finnhubTickerRaw.status === 'fulfilled' ? finnhubTickerRaw.value : [];
    const finnhubMarket = finnhubMarketRaw.status === 'fulfilled' ? finnhubMarketRaw.value : [];
    const gnews   = gnewsRaw.status   === 'fulfilled' ? gnewsRaw.value   : [];
    const newsapi = newsapiRaw.status === 'fulfilled' ? newsapiRaw.value : [];

    const mergedNews = mergeNews(finnhubTicker, finnhubMarket, newsapi, gnews).slice(0, 20);
    console.log(`📰 News raw: ${finnhubTicker.length} Finnhub-ticker + ${finnhubMarket.length} Finnhub-market + ${newsapi.length} NewsAPI + ${gnews.length} GNews → ${mergedNews.length} merged after filter`);
    await kvSet('catalystpit:_raw_news', JSON.stringify(mergedNews));
    results.refreshed.push('catalystpit:_raw_news');
  } catch(e) { fail('raw_news_sec', e); }

  await kvSet('catalystpit:last_refresh', results.timestamp);
  return Response.json(results, { status:200 });
}
