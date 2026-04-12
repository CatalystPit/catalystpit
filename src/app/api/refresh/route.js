export const runtime = 'nodejs';
export const maxDuration = 60;

const KV_TOKEN    = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const GNEWS_KEY   = process.env.GNEWS_KEY;   // ← gnews.io free key, works server-side

async function kvSet(key, value) {
  const res = await fetch(`https://powerful-grouper-86116.upstash.io/set/${encodeURIComponent(key)}?ex=1800`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'text/plain',
    },
    body: value,
  });
  const text = await res.text();
  console.log(`KV set ${key}: ${text.substring(0, 80)}`);
}

// ── GNews: fetch real financial headlines with photos ─────────────────────
// GNews works in server-side production environments (unlike NewsAPI free tier)
async function fetchNewsAPIStories() {
  if (!GNEWS_KEY) {
    console.warn('GNEWS_KEY not set — skipping real news fetch');
    return null;
  }

  try {
    // Fetch business/finance news with images
    const url = `https://gnews.io/api/v4/top-headlines?category=business&lang=en&max=10&apikey=${GNEWS_KEY}`;
    const res = await fetch(url);

    if (!res.ok) {
      console.error(`GNews error: ${res.status} ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    const articles = data.articles || [];

    console.log(`GNews returned ${articles.length} articles`);

    return articles
      .filter(a => a.image && a.title)
      .map(a => ({
        title:     a.title,
        source:    a.source?.name || 'News',
        url:       a.url,
        image_url: a.image,          // GNews uses "image" not "urlToImage"
        published: a.publishedAt,
      }));
  } catch (err) {
    console.error('GNews fetch failed:', err.message);
    return null;
  }
}

// ── Claude: enrich real headlines with ticker + category ──────────────────
async function enrichStoriesWithClaude(rawStories) {
  const storiesJson = JSON.stringify(rawStories);

  const prompt = `You are a financial analyst. You will receive a list of real news articles.
For each article, add:
- "ticker": the most relevant stock ticker (e.g. "AAPL", "SPY", "BTC-USD"). Use "SPY" for broad market stories.
- "category": one of "Earnings"|"Macro"|"Insider"|"Squeeze"|"Crypto"|"Options"|"Tech"|"Markets"|"FED"
- "headline": rewrite the title to be punchy and finance-focused (max 12 words)
- "summary": 1-sentence analyst take on why this matters to traders

Keep all other fields (source, url, image_url, published) exactly as given.

Return ONLY a valid JSON array of all articles enriched. No markdown.

Articles:
${storiesJson}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude enrichment error ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();
  const match = clean.match(/(\[[\s\S]*\])/);
  return JSON.parse(match ? match[0] : clean);
}

const DATA_FEEDS = [
  // top_stories is handled separately below with NewsAPI
  {
    key: 'catalystpit:market_snapshot',
    prompt: `Return ONLY a valid JSON object with current prices for: { "SPY": { "price": number, "change": number, "changePct": number }, "QQQ": { "price": number, "change": number, "changePct": number }, "DIA": { "price": number, "change": number, "changePct": number }, "VIX": { "price": number, "change": number, "changePct": number }, "BTC": { "price": number, "change": number, "changePct": number }, "ETH": { "price": number, "change": number, "changePct": number }, "GLD": { "price": number, "change": number, "changePct": number }, "USO": { "price": number, "change": number, "changePct": number } }. No markdown, just the JSON object.`,
  },
  {
    key: 'catalystpit:ticker_tape',
    prompt: `Return ONLY a valid JSON array of 12 objects for: AAPL, MSFT, NVDA, TSLA, AMZN, META, GOOGL, AMD, SPY, QQQ, BTC-USD, ETH-USD. Each: { "symbol": string, "price": number, "change": number, "changePct": number }. No markdown, just the JSON array.`,
  },
  {
    key: 'catalystpit:insider_trades',
    prompt: `Return ONLY a valid JSON array of 5 recent insider trades from the last 48 hours. Each: { "executive": string, "title": string, "company": string, "ticker": string, "action": "Buy"|"Sell", "shares": number, "value": number, "date": string, "formType": "Form 4" }. No markdown, just the JSON array.`,
  },
  {
    key: 'catalystpit:politician_trades',
    prompt: `Return ONLY a valid JSON array of 5 recent congressional stock trades from the last 2 weeks. Each: { "politician": string, "party": "D"|"R"|"I", "chamber": "House"|"Senate", "ticker": string, "company": string, "action": "Purchase"|"Sale", "amount": string, "date": string }. No markdown, just the JSON array.`,
  },
  {
    key: 'catalystpit:why_moving',
    prompt: `Return ONLY a valid JSON array of 4 stocks with significant moves today (3%+). Each: { "ticker": string, "company": string, "price": number, "changePct": number, "reason": string, "category": "Earnings"|"News"|"Upgrade"|"Downgrade"|"Squeeze"|"Macro" }. No markdown, just the JSON array.`,
  },
  {
    key: 'catalystpit:short_squeeze',
    prompt: `Return ONLY a valid JSON array of 8 stocks with high short squeeze potential. Each: { "ticker": string, "company": string, "price": number, "shortFloat": number, "daysToCover": number, "borrowRate": number, "squeezeScore": number, "catalyst": string }. No markdown, just the JSON array.`,
  },
  {
    key: 'catalystpit:earnings_intelligence',
    prompt: `Return ONLY a valid JSON object with "upcoming": array of 5 companies reporting in next 5 days each { "ticker": string, "company": string, "reportDate": string, "timing": "BMO"|"AMC", "epsEstimate": number, "revenueEstimate": string, "whisperNumber": number, "impliedMove": string } and "recent": array of 3 companies that just reported each { "ticker": string, "company": string, "epsActual": number, "epsEstimate": number, "beat": boolean, "revenueActual": string, "reaction": number }. No markdown, just the JSON object.`,
  },
  {
    key: 'catalystpit:institutional_moves',
    prompt: `Return ONLY a valid JSON array of 6 notable institutional position changes from recent 13F filings. Each: { "fund": string, "manager": string, "ticker": string, "company": string, "action": "New Position"|"Added"|"Reduced"|"Exited", "shares": number, "value": number, "portfolioPct": number, "quarter": string }. No markdown, just the JSON array.`,
  },
];

async function fetchFromClaude(prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err.substring(0, 300)}`);
  }

  const data = await response.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();
  const match = clean.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  return JSON.parse(match ? match[0] : clean);
}

export async function GET(request) {
  const authHeader    = request.headers.get('authorization');
  const isVercelCron  = request.headers.get('x-vercel-cron') === '1';

  if (!isVercelCron && authHeader !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = { refreshed: [], failed: [], timestamp: new Date().toISOString() };

  // ── 1. Top Stories: NewsAPI → Claude enrichment ──────────────────────────
  try {
    const rawStories = await fetchNewsAPIStories();

    let stories;
    if (rawStories && rawStories.length > 0) {
      // Real headlines — enrich with Claude (ticker, category, rewritten headline)
      stories = await enrichStoriesWithClaude(rawStories);
      console.log(`✅ top_stories: ${stories.length} real articles from NewsAPI`);
    } else {
      // Fallback: Claude invents stories (no API key or fetch failed)
      stories = await fetchFromClaude(
        `Return ONLY a valid JSON array of exactly 6 top market-moving financial news stories from today. Each: { "headline": string, "summary": string, "ticker": string, "source": string, "category": "Earnings"|"Macro"|"Insider"|"Squeeze"|"Crypto"|"Options"|"Tech"|"Markets"|"FED", "image_url": null }. No markdown.`
      );
      console.log('⚠️ top_stories: using Claude fallback (no NewsAPI key)');
    }

    await kvSet('catalystpit:top_stories', JSON.stringify(stories));
    results.refreshed.push('catalystpit:top_stories');
  } catch (error) {
    results.failed.push({ key: 'catalystpit:top_stories', error: error.message });
    console.error('❌ Failed top_stories:', error.message);
  }

  // ── 2. Other feeds — sequential with delay to avoid Claude 429s ─────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  for (const { key, prompt } of DATA_FEEDS) {
    try {
      await sleep(1500); // 1.5s gap between calls — prevents rate limiting
      const data = await fetchFromClaude(prompt);
      await kvSet(key, JSON.stringify(data));
      results.refreshed.push(key);
      console.log(`✅ Refreshed ${key}`);
    } catch (error) {
      results.failed.push({ key, error: error.message });
      console.error(`❌ Failed ${key}:`, error.message);
    }
  }

  await kvSet('catalystpit:last_refresh', results.timestamp);
  return Response.json(results, { status: 200 });
}
