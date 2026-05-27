import { db } from '../../../lib/db';
import { insiderTrades as insiderTradesTable } from '../../../lib/schema';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com' };

const KV_TOKEN     = process.env.KV_REST_API_TOKEN;
const CRON_SECRET  = process.env.CRON_SECRET;
const POLYGON_KEY  = process.env.POLYGON_KEY;
const GNEWS_KEY    = process.env.GNEWS_KEY;
const NEWSAPI_KEY  = process.env.NEWSAPI_KEY;
const FINNHUB_KEY  = process.env.FINNHUB_KEY;

const NEWS_TICKERS = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','NFLX','GOOG','JPM','BAC','XOM','WMT','COIN','PLTR','BA','DIS','UBER','SHOP'];

async function kvSet(key, value) {
  await fetch(
    `https://powerful-grouper-86116.upstash.io/set/${encodeURIComponent(key)}?ex=14400`,
    { method:'POST', headers:{ Authorization:`Bearer ${KV_TOKEN}`, 'Content-Type':'text/plain' }, body:value }
  );
  console.log(`✅ ${key}`);
}

async function fetchStockPrices(tickers) {
  const results = await throttledBatch(tickers, 5, 200, async (sym) => {
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`
      );
      if (!res.ok) return [sym, null];
      const data = await res.json();
      if (!data || !data.c) return [sym, null];
      const price = +data.c.toFixed(2);
      const change = +(data.d ?? 0).toFixed(2);
      const changePct = +(data.dp ?? 0).toFixed(2);
      return [sym, { price, change, changePct }];
    } catch { return [sym, null]; }
  });
  return Object.fromEntries(results.filter(([, v]) => v && v.price > 0));
}

async function fetchCrypto() {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true');
  const data = await res.json();
  return {
    'BTC-USD': { price:+(data.bitcoin?.usd||0).toFixed(2), change:0, changePct:+(data.bitcoin?.usd_24h_change||0).toFixed(2) },
  };
}

// ─── Form 4 helpers ─────────────────────────────────────────────────────────
const extractFormValue = (xml, tag) =>
  xml.match(new RegExp(`<${tag}>\\s*<value>([\\s\\S]*?)</value>`))?.[1]?.trim();

const extractFormText = (xml, tag) =>
  xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();

const decodeEntities = (s) => {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
};

async function throttledBatch(items, concurrency, gapMs, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(worker));
    out.push(...results);
    if (i + concurrency < items.length) await new Promise(r => setTimeout(r, gapMs));
  }
  return out;
}

function parseForm4(xml, filing) {
  if (extractFormText(xml, 'documentType') !== '4') return [];

  const ticker  = extractFormText(xml, 'issuerTradingSymbol')?.toUpperCase();
  const company = decodeEntities(extractFormText(xml, 'issuerName'));
  if (!ticker) return [];

  const executive = decodeEntities(extractFormText(xml, 'rptOwnerName') || '');
  const isDirector   = ['true','1'].includes(extractFormText(xml, 'isDirector'));
  const isOfficer    = ['true','1'].includes(extractFormText(xml, 'isOfficer'));
  const isTenPercent = ['true','1'].includes(extractFormText(xml, 'isTenPercentOwner'));
  const officerTitle = decodeEntities(extractFormText(xml, 'officerTitle') || '');
  let title;
  if (isOfficer && officerTitle) title = officerTitle;
  else if (isOfficer)            title = 'Officer';
  else if (isDirector)           title = 'Director';
  else if (isTenPercent)         title = '10% Owner';
  else                           title = 'Other';

  // Only parse <nonDerivativeTable> — derivatives belong to /options-flow, not /insiders
  const ndtMatch = xml.match(/<nonDerivativeTable>([\s\S]*?)<\/nonDerivativeTable>/);
  if (!ndtMatch) return [];
  const txns = [...ndtMatch[1].matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)]
    .map(m => m[1]);

  return txns.map(txn => {
    const transactionCode = extractFormText(txn, 'transactionCode') || '';
    const transactionDate = extractFormValue(txn, 'transactionDate') || '';
    const shares          = parseFloat(extractFormValue(txn, 'transactionShares'))        || 0;
    const pricePerShare   = parseFloat(extractFormValue(txn, 'transactionPricePerShare')) || 0;
    const securityTitle   = decodeEntities(extractFormValue(txn, 'securityTitle') || '');
    const rawSOA          = extractFormValue(txn, 'sharesOwnedFollowingTransaction');
    const sharesOwnedAfter = rawSOA ? parseFloat(rawSOA) : null;

    let action;
    if      (transactionCode === 'P') action = 'BUY';
    else if (transactionCode === 'S') action = 'SELL';
    else                              action = 'OTHER';

    return {
      ticker, company, executive, title,
      transactionCode, action,
      shares, pricePerShare,
      totalValue: shares * pricePerShare,
      sharesOwnedAfter,
      securityTitle,
      transactionDate,
      filingDate: filing.filingDate,
      accession:  filing.accession,
      filingUrl:  filing.indexUrl,
    };
  });
}

async function fetchForm4Trades() {
  try {
    const atomRes = await fetch(
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=100&output=atom',
      { headers: SEC_HEADERS }
    );
    if (!atomRes.ok) {
      console.log(`❌ SEC atom feed: HTTP ${atomRes.status}`);
      return [];
    }
    const atomXml = await atomRes.text();

    // Each filing appears twice in the atom feed (Issuer + Reporting Owner views).
    // De-dupe by accession#, keep only Issuer entries for clean ticker source.
    const entries = [...atomXml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
    const filings = new Map();
    for (const entry of entries) {
      const title = entry.match(/<title>(.*?)<\/title>/)?.[1] || '';
      if (!title.includes('(Issuer)')) continue;
      const link = entry.match(/<link[^>]+href="([^"]+)"/)?.[1] || '';
      const lm = link.match(/\/data\/(\d+)\/(\d+)\/([\d-]+)-index\.htm/);
      if (!lm) continue;
      const [, cik, accessionNoDashes, accessionWithDashes] = lm;
      const filingDate = entry.match(/<updated>(.*?)<\/updated>/)?.[1]?.split('T')[0] || '';
      filings.set(accessionWithDashes, {
        accession: accessionWithDashes,
        cik, accessionNoDashes,
        indexUrl: link,
        filingDate,
      });
    }

    console.log(`📋 SEC: ${entries.length} atom entries → ${filings.size} unique Form 4 filings`);

    // Two requests per filing (index.json + ownership xml) throttled to stay under SEC's 10 req/sec.
    const results = await throttledBatch(Array.from(filings.values()), 5, 600, async (f) => {
      try {
        const idxRes = await fetch(
          `https://www.sec.gov/Archives/edgar/data/${f.cik}/${f.accessionNoDashes}/index.json`,
          { headers: SEC_HEADERS }
        );
        if (!idxRes.ok) return [];
        const idx = await idxRes.json();
        const xmlFile = idx.directory?.item?.find(i => i.name.endsWith('.xml'));
        if (!xmlFile) return [];

        const xmlRes = await fetch(
          `https://www.sec.gov/Archives/edgar/data/${f.cik}/${f.accessionNoDashes}/${xmlFile.name}`,
          { headers: SEC_HEADERS }
        );
        if (!xmlRes.ok) return [];
        return parseForm4(await xmlRes.text(), f);
      } catch (e) {
        console.log(`⚠️ Filing ${f.accession}: ${e.message}`);
        return [];
      }
    });

    const flat = results.flat();
    const codeCounts = flat.reduce((acc, t) => {
      acc[t.transactionCode || '?'] = (acc[t.transactionCode || '?'] || 0) + 1;
      return acc;
    }, {});
    console.log(`📊 Form 4 transactions: ${flat.length} total · codes=${JSON.stringify(codeCounts)}`);
    return flat;
  } catch (e) {
    console.log(`❌ fetchForm4Trades: ${e.message}`);
    return [];
  }
}

// ── Detect generic placeholder images (Yahoo's purple "fi" thing, etc.) ──
function isPlaceholderImage(url) {
  if (!url || typeof url !== 'string') return true;
  const u = url.toLowerCase();
  // Yahoo Finance generic placeholders (exact + pattern)
  if (u.includes('yahoo_finance_en-us_h_p_finance')) return true;
  if (u.includes('s.yimg.com/rz/stage/')) return true;
  if (u.includes('s.yimg.com/cv/apiv2/default')) return true;
  if (u.includes('s.yimg.com/os/creatr-uploaded-images/finance')) return true;
  if (u.match(/s\.yimg\.com.*\/api\/res\/.*\/finance/)) return true;
  // Generic share-images known to be placeholders
  if (u.includes('default-share-image')) return true;
  if (u.includes('logo-placeholder')) return true;
  if (u.includes('default_thumbnail')) return true;
  if (u.includes('default-image')) return true;
  if (u.includes('og-default')) return true;
  // Tiny images (often placeholders / icons)
  if (u.match(/\b(1x1|pixel|spacer|blank)\.(gif|png|jpg)\b/)) return true;
  // Stock photo agencies — common in API-republished wire stories
  if (u.includes('gettyimages')) return true;
  if (u.includes('istockphoto')) return true;
  if (u.includes('shutterstock')) return true;
  if (u.includes('dreamstime')) return true;
  if (u.includes('123rf')) return true;
  if (u.includes('alamy')) return true;
  if (u.includes('depositphotos')) return true;
  // SeekingAlpha CDN — images uniformly low quality
  if (u.includes('seekingalpha')) return true;
  return false;
}

// ─── RSS helpers (no XML parser dep; mirrors fetchSECInsiders' regex approach) ─
function extractTag(itemXml, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`);
  const m = itemXml.match(re);
  if (!m) return null;
  let content = m[1].trim();
  const cdata = content.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) content = cdata[1].trim();
  return content
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'").replace(/&#x2014;/g, '—').replace(/&#x2019;/g, "'");
}

function extractAttr(itemXml, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*\\b${attrName}="([^"]*)"`);
  const m = itemXml.match(re);
  return m ? m[1] : null;
}

async function fetchRSS(url, sourceName, rank, opts = {}) {
  const { cap = null } = opts;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CatalystPit/1.0; +contact@catalystpit.com)' },
    });
    if (!res.ok) {
      console.log(`❌ RSS ${sourceName}: HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(m => m[0]);

    const articles = items.map(item => {
      const title = extractTag(item, 'title');
      const link  = extractTag(item, 'link');
      if (!title || !link) return null;

      const image_url =
        extractAttr(item, 'media:content',   'url') ||
        extractAttr(item, 'media:thumbnail', 'url') ||
        extractAttr(item, 'enclosure',       'url') ||
        null;

      let published = null;
      const pubDate = extractTag(item, 'pubDate');
      if (pubDate) {
        const d = new Date(pubDate);
        if (!isNaN(d.getTime())) published = d.toISOString();
      }

      return {
        title,
        source: sourceName,
        url: link,
        image_url, // RSS sources skip isPlaceholderImage — publisher CDNs are trusted
        published,
        ticker: null,
        _provider: `rss-${sourceName.toLowerCase().replace(/\s+/g, '-')}`,
        _rank: rank,
      };
    }).filter(Boolean);

    return cap ? articles.slice(0, cap) : articles;
  } catch (e) {
    console.log(`❌ RSS ${sourceName}: ${e.message}`);
    return [];
  }
}

async function fetchFinnhubPerTicker() {
  if (!FINNHUB_KEY) return [];
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
            image_url: isPlaceholderImage(a.image) ? null : a.image,
            published: new Date(a.datetime * 1000).toISOString(),
            ticker,
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
        image_url: isPlaceholderImage(a.image) ? null : a.image,
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
        image_url: isPlaceholderImage(a.image) ? null : a.image,
        published: a.publishedAt,
        ticker: null,
        _provider: 'gnews',
        _rank: 4,
      }));
  } catch { return []; }
}

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
        image_url: isPlaceholderImage(a.urlToImage) ? null : a.urlToImage,
        published: a.publishedAt,
        ticker: null,
        _provider: 'newsapi',
        _rank: 3,
      }));
  } catch { return []; }
}

const HARD_BLOCK = [
  'ufc','mma','nfl','nba','nhl','mlb','wnba','ncaa','espn','fight night',
  'super bowl','world cup','olympic','olympics','playoff','playoffs','draft pick',
  'football','basketball','baseball','soccer','tennis','golf tournament','pga','formula 1','f1 race',
  'mcgregor','ngannou','khabib','jon jones',
  'taylor swift','travis kelce','kardashian','kanye','beyonce','drake',
  'oscar','grammy','emmy','cannes','met gala','red carpet',
  'movie review','box office','netflix series','tv show','reality tv',
  'recipe','restaurant review','travel destination','vacation','lounge review',
  'horoscope','astrology','dating',
  'gubernatorial','school board','mayor election','city council',
];

function hasBlockedTerm(article) {
  const t = (article.title || '').toLowerCase();
  return HARD_BLOCK.some(b => t.includes(b));
}

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

// Sources known to give great article images
const SOURCES_WITH_GOOD_IMAGES = [
  'reuters','bloomberg','cnbc','wsj','financial times','ft.com','marketwatch','barron',
  'forbes','fortune','business insider','thestreet','benzinga','seeking alpha',
];

// Sources known for generic placeholder images
const SOURCES_WITH_BAD_IMAGES = ['yahoo','yahoo finance','aol','msn'];

function isFinanceRelevant(article) {
  if (hasBlockedTerm(article)) return false;
  if (article._provider === 'finnhub-ticker') return true;
  const title = (article.title || '').toLowerCase();
  const source = (article.source || '').toLowerCase();
  const trustedSource = TRUSTED_SOURCES.some(s => source.includes(s));
  const financeKw = FINANCE_KEYWORDS.some(k => title.includes(k));
  if (article._provider === 'finnhub-market') return financeKw;
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
      // Prefer better rank, then with-image over without
      if (story._rank < existing._rank || (!existing.image_url && story.image_url)) {
        seen.set(key, story);
      }
    }
  }
  // Computed image quality score for sorting
  const imgScore = (a) => {
    if (!a.image_url) return 0;
    const src = (a.source || '').toLowerCase();
    if (SOURCES_WITH_GOOD_IMAGES.some(s => src.includes(s))) return 2;
    if (SOURCES_WITH_BAD_IMAGES.some(s => src.includes(s))) return 0; // treat as no image
    return 1;
  };
  return Array.from(seen.values())
    .sort((a, b) => {
      // First by image quality (real images first)
      const ia = imgScore(a), ib = imgScore(b);
      if (ia !== ib) return ib - ia;
      // Then by rank (lower is better)
      if (a._rank !== b._rank) return a._rank - b._rank;
      // Then by recency
      return new Date(b.published || 0) - new Date(a.published || 0);
    });
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron')==='1';
  if (!isVercelCron && request.headers.get('authorization')!==`Bearer ${CRON_SECRET}`)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const results = { refreshed:[], failed:[], timestamp:new Date().toISOString() };
  const fail = (k,e) => { results.failed.push({key:k,error:e.message}); console.error(`❌ ${k}:`,e.message); };

  const STOCKS = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','DIA','GLD','USO','UVXY'];
  const [stockPrices, crypto, insiderRaw, finnhubTickerRaw, finnhubMarketRaw, gnewsRaw, newsapiRaw, rssWSJRaw, rssMWRaw, rssBBRaw] = await Promise.allSettled([
    fetchStockPrices(STOCKS),
    fetchCrypto(),
    fetchForm4Trades(),
    fetchFinnhubPerTicker(),
    fetchFinnhubMarket(),
    fetchGNews(),
    fetchNewsAPI(),
    fetchRSS('https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', 'WSJ',         0, { cap: 30 }),
    fetchRSS('https://feeds.content.dowjones.io/public/rss/mw_topstories',  'MarketWatch', 0),
    fetchRSS('https://feeds.bloomberg.com/markets/news.rss',                'Bloomberg',   0),
  ]);

  try {
    const stocks = stockPrices.status==='fulfilled' ? stockPrices.value : {};
    const btc    = crypto.status==='fulfilled'      ? crypto.value      : {};
    const prices = { ...stocks, ...btc };

    const TAPE = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','DIA','UVXY','BTC-USD'];
    const tape = TAPE
      .filter(s => prices[s]?.price > 0)
      .map(s => ({ symbol:s, ...prices[s] }));
    if (tape.length > 0) {
      await kvSet('catalystpit:ticker_tape', JSON.stringify(tape));
      results.refreshed.push('catalystpit:ticker_tape');
    } else {
      console.log('⚠ ticker_tape: no price data, skipping write to preserve last good value');
    }

    const SNAP = ['SPY','QQQ','DIA','GLD','USO','UVXY','BTC-USD','AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD'];
    const snap = Object.fromEntries(
      SNAP.filter(s => prices[s]?.price > 0).map(s => [s, prices[s]])
    );
    if (Object.keys(snap).length > 0) {
      await kvSet('catalystpit:market_snapshot', JSON.stringify(snap));
      results.refreshed.push('catalystpit:market_snapshot');
    } else {
      console.log('⚠ market_snapshot: no price data, skipping write to preserve last good value');
    }
  } catch(e) { fail('prices', e); }

  try {
    const insiderTrades = insiderRaw.status === 'fulfilled' ? insiderRaw.value : [];
    await kvSet('catalystpit:insider_trades', JSON.stringify(insiderTrades));
    results.refreshed.push('catalystpit:insider_trades');

    // Dual-write to Postgres. KV remains the safety net during cutover.
    if (insiderTrades.length > 0) {
      try {
        const rows = insiderTrades
          .filter(r => r.filingDate)
          .map(r => ({
            ...r,
            transactionCode: r.transactionCode || null,
            transactionDate: r.transactionDate || null,
          }));
        const skipped = insiderTrades.length - rows.length;
        const inserted = await db.insert(insiderTradesTable)
          .values(rows)
          .onConflictDoNothing({
            target: [
              insiderTradesTable.accession,
              insiderTradesTable.transactionDate,
              insiderTradesTable.transactionCode,
              insiderTradesTable.securityTitle,
              insiderTradesTable.shares,
              insiderTradesTable.pricePerShare,
              insiderTradesTable.sharesOwnedAfter,
            ],
          })
          .returning({ id: insiderTradesTable.id });
        console.log(`[insider_pg] ${inserted.length} new · ${rows.length - inserted.length} dupes${skipped ? ` · ${skipped} skipped (missing filingDate)` : ''}`);
        results.refreshed.push('catalystpit:postgres:insider_trades');
      } catch (e) {
        console.log(`[insider_pg] insert failed: ${e.message}`);
      }
    }

    const finnhubTicker = finnhubTickerRaw.status === 'fulfilled' ? finnhubTickerRaw.value : [];
    const finnhubMarket = finnhubMarketRaw.status === 'fulfilled' ? finnhubMarketRaw.value : [];
    const gnews   = gnewsRaw.status   === 'fulfilled' ? gnewsRaw.value   : [];
    const newsapi = newsapiRaw.status === 'fulfilled' ? newsapiRaw.value : [];
    const rssWSJ  = rssWSJRaw.status  === 'fulfilled' ? rssWSJRaw.value  : [];
    const rssMW   = rssMWRaw.status   === 'fulfilled' ? rssMWRaw.value   : [];
    const rssBB   = rssBBRaw.status   === 'fulfilled' ? rssBBRaw.value   : [];

    const mergedNews = mergeNews(rssWSJ, rssMW, rssBB, finnhubTicker, finnhubMarket, newsapi, gnews).slice(0, 20);
    const withImages = mergedNews.filter(a => a.image_url).length;
    console.log(`📰 News: ${rssWSJ.length} WSJ + ${rssMW.length} MW + ${rssBB.length} BB + ${finnhubTicker.length} F-tkr + ${finnhubMarket.length} F-mkt + ${newsapi.length} NewsAPI + ${gnews.length} GNews → ${mergedNews.length} merged (${withImages} with real images)`);
    await kvSet('catalystpit:_raw_news', JSON.stringify(mergedNews));
    results.refreshed.push('catalystpit:_raw_news');
  } catch(e) { fail('raw_news_sec', e); }

  await kvSet('catalystpit:last_refresh', results.timestamp);
  return Response.json(results, { status:200 });
}
