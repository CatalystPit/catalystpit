import { kv } from '@vercel/kv';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;

const DATA_FEEDS = [
  {
    key: 'catalystpit:top_stories',
    prompt: `You are a financial news aggregator. Return ONLY a valid JSON array of exactly 6 top market-moving financial news stories from the last 4 hours. Each object must have: { "headline": string, "summary": string (2 sentences max), "ticker": string (primary ticker or empty string), "source": string, "url": string, "category": "Earnings"|"Macro"|"Insider"|"Squeeze"|"Crypto"|"Options" }. No markdown, no explanation, just the JSON array.`,
  },
  {
    key: 'catalystpit:market_snapshot',
    prompt: `You are a live market data provider. Return ONLY a valid JSON object with current approximate prices for: { "SPY": { "price": number, "change": number, "changePct": number }, "QQQ": { "price": number, "change": number, "changePct": number }, "DIA": { "price": number, "change": number, "changePct": number }, "VIX": { "price": number, "change": number, "changePct": number }, "BTC": { "price": number, "change": number, "changePct": number }, "ETH": { "price": number, "change": number, "changePct": number }, "GLD": { "price": number, "change": number, "changePct": number }, "USO": { "price": number, "change": number, "changePct": number } }. Use real-time web data. No markdown, no explanation, just the JSON object.`,
  },
  {
    key: 'catalystpit:ticker_tape',
    prompt: `You are a market data provider. Return ONLY a valid JSON array of 12 objects, one per major ticker: AAPL, MSFT, NVDA, TSLA, AMZN, META, GOOGL, AMD, SPY, QQQ, BTC-USD, ETH-USD. Each object: { "symbol": string, "price": number, "change": number, "changePct": number }. Use current approximate prices from web search. No markdown, no explanation, just the JSON array.`,
  },
  {
    key: 'catalystpit:insider_trades',
    prompt: `You are an SEC filing analyst. Return ONLY a valid JSON array of 5 recent insider trades filed in the last 48 hours. Each object: { "executive": string, "title": string, "company": string, "ticker": string, "action": "Buy"|"Sell", "shares": number, "value": number, "date": string (YYYY-MM-DD), "formType": "Form 4" }. Sort by dollar value descending. No markdown, no explanation, just the JSON array.`,
  },
  {
    key: 'catalystpit:politician_trades',
    prompt: `You are a STOCK Act compliance analyst. Return ONLY a valid JSON array of 5 recent congressional stock trades disclosed in the last 2 weeks. Each object: { "politician": string, "party": "D"|"R"|"I", "chamber": "House"|"Senate", "ticker": string, "company": string, "action": "Purchase"|"Sale", "amount": string (e.g. "$15,001 - $50,000"), "date": string (YYYY-MM-DD) }. No markdown, no explanation, just the JSON array.`,
  },
  {
    key: 'catalystpit:why_moving',
    prompt: `You are a market analyst. Return ONLY a valid JSON array of 4 stocks with significant price moves today (up or down 3%+). Each object: { "ticker": string, "company": string, "price": number, "changePct": number, "reason": string (1 sentence, specific catalyst), "category": "Earnings"|"News"|"Upgrade"|"Downgrade"|"Squeeze"|"Macro" }. No markdown, no explanation, just the JSON array.`,
  },
  {
    key: 'catalystpit:short_squeeze',
    prompt: `You are a short interest analyst. Return ONLY a valid JSON array of 8 stocks with high short squeeze potential right now. Each object: { "ticker": string, "company": string, "price": number, "shortFloat": number (percentage), "daysToCover": number, "borrowRate": number (percentage), "squeezeScore": number (1-100), "catalyst": string (brief reason why a squeeze could happen) }. Sort by squeezeScore descending. No markdown, no explanation, just the JSON array.`,
  },
  {
    key: 'catalystpit:earnings_intelligence',
    prompt: `You are an earnings analyst. Return ONLY a valid JSON object with two arrays. "upcoming": 5 companies reporting earnings in the next 5 trading days, each: { "ticker": string, "company": string, "reportDate": string (YYYY-MM-DD), "timing": "BMO"|"AMC", "epsEstimate": number, "revenueEstimate": string, "whisperNumber": number, "impliedMove": string (e.g. "±8%") }. "recent": 3 companies that just reported in the last 24 hours, each: { "ticker": string, "company": string, "epsActual": number, "epsEstimate": number, "beat": boolean, "revenueActual": string, "reaction": number (stock % move) }. No markdown, no explanation, just the JSON object.`,
  },
  {
    key: 'catalystpit:institutional_moves',
    prompt: `You are a 13F filing analyst. Return ONLY a valid JSON array of 6 notable institutional position changes from the most recent 13F filings (last 45 days). Each object: { "fund": string, "manager": string, "ticker": string, "company": string, "action": "New Position"|"Added"|"Reduced"|"Exited", "shares": number, "value": number, "portfolioPct": number, "quarter": string (e.g. "Q1 2025") }. Sort by value descending. No markdown, no explanation, just the JSON array.`,
  },
];

async function fetchFromClaude(prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-02-04',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const textContent = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const clean = textContent.replace(/```json\n?|```\n?/g, '').trim();
  return JSON.parse(clean);
}

export async function GET(request) {
  const authHeader = request.headers.get('authorization');
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';

  if (!isVercelCron && authHeader !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = {
    refreshed: [],
    failed: [],
    timestamp: new Date().toISOString(),
  };

  await Promise.allSettled(
    DATA_FEEDS.map(async ({ key, prompt }) => {
      try {
        const data = await fetchFromClaude(prompt);
        await kv.set(key, JSON.stringify(data), { ex: 1800 });
        results.refreshed.push(key);
        console.log(`✅ Refreshed ${key}`);
      } catch (error) {
        results.failed.push({ key, error: error.message });
        console.error(`❌ Failed ${key}:`, error.message);
      }
    })
  );

  await kv.set('catalystpit:last_refresh', results.timestamp);
  return Response.json(results, { status: 200 });
}
