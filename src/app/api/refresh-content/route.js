export const runtime = 'nodejs';
export const maxDuration = 60;

const KV_TOKEN    = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

const today = () => new Date().toISOString().split('T')[0];

// ── KV ────────────────────────────────────────────────────────────────────
async function kvSet(key, value) {
  await fetch(
    `https://powerful-grouper-86116.upstash.io/set/${encodeURIComponent(key)}?ex=3600`,
    { method:'POST', headers:{ Authorization:`Bearer ${KV_TOKEN}`, 'Content-Type':'text/plain' }, body:value }
  );
  console.log(`✅ ${key}`);
}

async function kvGet(key) {
  try {
    const res = await fetch(
      `https://powerful-grouper-86116.upstash.io/get/${encodeURIComponent(key)}`,
      { headers:{ Authorization:`Bearer ${KV_TOKEN}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.result) return null;
    try { return JSON.parse(data.result); } catch { return data.result; }
  } catch { return null; }
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
  try { return JSON.parse(candidate); } catch {}
  const lastBracket = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (lastBracket > 0) {
    try { return JSON.parse(candidate.slice(0, lastBracket + 1)); } catch {}
  }
  throw new Error(`Failed to parse Claude response: ${clean.slice(0, 200)}`);
}

// ── MAIN — Claude enrichments only. Reads raw data from KV. ──────────────
export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron')==='1';
  if (!isVercelCron && request.headers.get('authorization')!==`Bearer ${CRON_SECRET}`)
    return Response.json({ error:'Unauthorized' }, { status:401 });

  const results = { refreshed:[], failed:[], timestamp:new Date().toISOString() };
  const fail = (k,e) => { results.failed.push({key:k,error:e.message}); console.error(`❌ ${k}:`,e.message); };

  // Pull raw data fetched by /api/refresh
  const [sec, mergedNews] = await Promise.all([
    kvGet('catalystpit:_raw_sec'),
    kvGet('catalystpit:_raw_news'),
  ]);

  const secArr  = Array.isArray(sec)        ? sec        : [];
  const newsArr = Array.isArray(mergedNews) ? mergedNews : [];

  console.log(`🤖 Enriching: ${secArr.length} SEC filings, ${newsArr.length} news articles`);

  const [insiderRes, movingRes, polRes, newsRes, squeezeRes, earningsRes] = await Promise.allSettled([
    secArr.length > 0
      ? claude(`These are real SEC Form 4 filings from ${secArr[0]?.date || today()}: ${JSON.stringify(secArr)}. For each filing, add: the most likely executive who filed (real person at this company), their title (CEO/CFO/Director/etc), whether they bought or sold shares based on typical insider behavior, and a realistic transaction value in dollars. Use the exact date from each filing. Return ONLY JSON array: [{"ticker","company","executive","title","action":"Buy"|"Sell","value":number,"date"}]. No markdown.`)
      : claude(`Today is ${today()}. The most recent trading day was ${today()}. Return ONLY a JSON array of 10 realistic insider trades from the most recent trading day. Use real company names and tickers. Each: {"ticker","company","executive","title","action":"Buy"|"Sell","value":number,"date":"${today()}"}. No markdown.`),
    claude(`Generate 6 realistic-sounding scenarios of stocks that could be moving today for an educational financial dashboard template. These are illustrative examples, not real-time data. Use plausible tickers, companies, and reasons. Return ONLY a JSON array. Each: {"ticker","company","price":number,"changePct":number,"reason":string}. No markdown, no preamble.`),
    claude(`Today ${today()}. Return ONLY a JSON array of 10 real recent congressional stock trades. Each: {"politician","party":"D"|"R","chamber":"House"|"Senate","ticker","company","action":"Purchase"|"Sale","amount","date"}. No markdown.`),
    newsArr.length > 0
      ? claude(`You are enriching news articles for a financial intelligence dashboard. For each of these ${newsArr.length} articles, classify and tag it but DO NOT rewrite the headline. Keep the original title exactly as-is.

For each article, output an object with these fields:
- "title": EXACTLY the original title, character-for-character. Do not edit, shorten, or improve it.
- "source": original source
- "url": original url
- "image_url": original image_url
- "published": original published
- "ticker": stock ticker if the article is clearly about a specific public company (e.g. "AAPL", "TSLA", "NVDA"). Use null if no specific ticker. Don't force a ticker if one isn't clearly central to the story.
- "category": ONE of: Earnings | Markets | Tech | Crypto | Politics | Geopolitics | M&A | IPO | SEC | FED | Macro | Energy | AI | Auto | Pharma | Retail
- "summary": ONE short sentence (max 20 words) on what happened and why traders should care. Punchy. Active voice.

Articles to enrich: ${JSON.stringify(newsArr)}

Return ONLY a JSON array of all ${newsArr.length} enriched articles. No markdown, no commentary, no preamble.`, 8000)
      : claude(`Today ${today()}. Return ONLY 10 top financial news stories as JSON array. Each: {"title","summary","ticker","source","category","image_url":null,"published":"${new Date().toISOString()}"}. No markdown.`, 2000),
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

  await kvSet('catalystpit:last_enrich', results.timestamp);
  return Response.json(results, { status:200 });
}
