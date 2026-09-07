export const runtime = 'nodejs';
export const maxDuration = 60;

const KV_TOKEN    = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

async function kvSet(key, value) {
  await fetch(
    `https://powerful-grouper-86116.upstash.io/set/${encodeURIComponent(key)}?ex=14400`,
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

async function enrichNewsInBatches(articles) {
  const half = Math.ceil(articles.length / 2);
  const batch1 = articles.slice(0, half);
  const batch2 = articles.slice(half);

  const buildPrompt = (batch) => `You are enriching news articles for a financial intelligence dashboard. For each of these ${batch.length} articles, classify and tag it but DO NOT rewrite the headline. Keep the original title exactly as-is.

For each article, output an object with these fields:
- "title": EXACTLY the original title, character-for-character. Do not edit, shorten, or improve it.
- "source": original source
- "url": original url
- "image_url": original image_url
- "published": original published
- "ticker": stock ticker if the article is clearly about a specific public company (e.g. "AAPL", "TSLA", "NVDA"). Use null if no specific ticker.
- "category": ONE of: Earnings | Markets | Tech | Crypto | Politics | Geopolitics | M&A | IPO | SEC | FED | Macro | Energy | AI | Auto | Pharma | Retail
- "summary": ONE short sentence (max 20 words) on what happened and why traders should care. Punchy. Active voice.

Articles to enrich: ${JSON.stringify(batch)}

Return ONLY a JSON array of all ${batch.length} enriched articles. No markdown, no commentary, no preamble.`;

  const [r1, r2] = await Promise.allSettled([
    claude(buildPrompt(batch1), 4000),
    batch2.length > 0 ? claude(buildPrompt(batch2), 4000) : Promise.resolve([]),
  ]);

  const enriched1 = r1.status === 'fulfilled' ? r1.value : [];
  const enriched2 = r2.status === 'fulfilled' ? r2.value : [];

  if (r1.status === 'rejected' && r2.status === 'rejected') {
    throw new Error(`Both news batches failed: ${r1.reason?.message} | ${r2.reason?.message}`);
  }

  console.log(`📰 Enriched batches: ${enriched1.length} + ${enriched2.length} = ${enriched1.length + enriched2.length}`);
  return [...enriched1, ...enriched2];
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron')==='1';
  if (!isVercelCron && request.headers.get('authorization')!==`Bearer ${CRON_SECRET}`)
    return Response.json({ error:'Unauthorized' }, { status:401 });

  const results = { refreshed:[], failed:[], timestamp:new Date().toISOString() };

  const mergedNews = await kvGet('catalystpit:_raw_news');
  const newsArr = Array.isArray(mergedNews) ? mergedNews : [];

  console.log(`🤖 Enriching: ${newsArr.length} news articles`);

  if (newsArr.length === 0) {
    results.failed.push({ key:'catalystpit:top_stories', error:'No raw news in cache — run /api/refresh first' });
    console.error('❌ catalystpit:top_stories: No raw news in cache');
  } else {
    try {
      const enriched = await enrichNewsInBatches(newsArr);
      // Claude is unreliable at echoing long image URLs — re-attach media/links from the ORIGINAL
      // raw articles (matched on the verbatim title) so images/urls always survive enrichment.
      const norm = (t) => String(t || '').trim().toLowerCase();
      const origByTitle = new Map(newsArr.map((a) => [norm(a.title || a.headline), a]));
      const merged = enriched.map((e) => {
        const o = origByTitle.get(norm(e.title)) || {};
        return {
          ...e,
          url: o.url || e.url || null,
          image_url: o.image_url || o.imageUrl || o.image || e.image_url || null,
          source: e.source || o.source || 'Market News',
          published: o.published || e.published || null,
        };
      });
      const withImg = merged.filter((m) => m.image_url).length;
      console.log(`🖼️ top_stories: ${withImg}/${merged.length} have images after re-attach`);
      await kvSet('catalystpit:top_stories', JSON.stringify(merged));
      results.refreshed.push('catalystpit:top_stories');
    } catch (e) {
      results.failed.push({ key:'catalystpit:top_stories', error:e.message });
      console.error(`❌ catalystpit:top_stories:`, e.message);
    }
  }

  await kvSet('catalystpit:last_enrich', results.timestamp);
  return Response.json(results, { status:200 });
}
