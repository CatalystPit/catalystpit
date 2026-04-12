export const runtime = 'nodejs';
export const maxDuration = 60;

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

async function kvSet(key, value) {
  const encodedKey = encodeURIComponent(key);
  const encodedValue = encodeURIComponent(value);
  const res = await fetch(`${KV_URL}/set/${encodedKey}/${encodedValue}?ex=1800`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
    },
  });
  const data = await res.text();
  console.log(`KV set ${key}: ${data}`);
}

const DATA_FEEDS = [
  {
    key: 'catalystpit:top_stories',
    prompt: `You are a financial news aggregator. Return ONLY a valid JSON array of exactly 6 top market-moving financial news stories from the last 4 hours. Each object: { "headline": string, "summary": string (2 sentences max), "ticker": string, "source": string, "url": string, "category": "Earnings"|"Macro"|"Insider"|"Squeeze"|"Crypto"|"Options" }. No markdown, just the JSON array.`,
  },
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
      'anthropic-beta': 'web-search-2025-02-04',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`Claude API error ${response.status}`);

  const data = await response.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();
  return JSON.parse(clean);
}

export async function GET(request) {
  const authHeader = request.headers.get('authorization');
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';

  if (!isVercelCron && authHeader !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = { refreshed: [], failed: [], timestamp: new Date().toISOString() };

  await Promise.allSettled(
    DATA_FEEDS.map(async ({ key, prompt }) => {
      try {
        const data = await fetchFromClaude(prompt);
        const value = JSON.stringify(data);
        await kvSet(key, value);
        results.refreshed.push(key);
        console.log(`✅ Refreshed ${key}`);
      } catch (error) {
        results.failed.push({ key, error: error.message });
        console.error(`❌ Failed ${key}:`, error.message);
      }
    })
  );

  await kvSet('catalystpit:last_refresh', results.timestamp);
  return Response.json(results, { status: 200 });
}
