import { kv } from '@vercel/kv';

export const runtime = 'nodejs';

const VALID_KEYS = new Set([
  'top_stories',
  'market_snapshot',
  'ticker_tape',
  'insider_trades',
  'politician_trades',
  'why_moving',
  'short_squeeze',
  'earnings_intelligence',
  'institutional_moves',
]);

async function fetchFreshFromClaude(dataKey) {
  const refreshUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/api/refresh`;
  await fetch(refreshUrl, {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  await new Promise((r) => setTimeout(r, 3000));
  const cached = await kv.get(`catalystpit:${dataKey}`);
  return cached ? JSON.parse(cached) : null;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const dataKey = searchParams.get('key');

  if (!dataKey || !VALID_KEYS.has(dataKey)) {
    return Response.json(
      { error: `Invalid key. Valid keys: ${[...VALID_KEYS].join(', ')}` },
      { status: 400 }
    );
  }

  try {
    const cached = await kv.get(`catalystpit:${dataKey}`);

    if (cached) {
      const lastRefresh = await kv.get('catalystpit:last_refresh');
      return Response.json(
        {
          data: typeof cached === 'string' ? JSON.parse(cached) : cached,
          source: 'cache',
          lastRefresh: lastRefresh || null,
        },
        {
          status: 200,
          headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=1800' },
        }
      );
    }

    console.warn(`Cache miss for ${dataKey} — triggering fresh fetch`);
    const freshData = await fetchFreshFromClaude(dataKey);

    if (!freshData) {
      return Response.json(
        { error: 'Data temporarily unavailable. Try again in 30 seconds.' },
        { status: 503 }
      );
    }

    return Response.json(
      { data: freshData, source: 'fresh', lastRefresh: new Date().toISOString() },
      { status: 200 }
    );
  } catch (error) {
    console.error(`API error for key ${dataKey}:`, error);
    return Response.json({ error: 'Internal server error', detail: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const dataKey = body.key || body.type;

    if (!dataKey || !VALID_KEYS.has(dataKey)) {
      return Response.json({ error: 'Invalid or missing key' }, { status: 400 });
    }

    const cached = await kv.get(`catalystpit:${dataKey}`);
    if (cached) {
      return Response.json(
        { data: typeof cached === 'string' ? JSON.parse(cached) : cached, source: 'cache' },
        { status: 200 }
      );
    }

    return Response.json({ error: 'Data not cached yet. Check back shortly.' }, { status: 503 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
