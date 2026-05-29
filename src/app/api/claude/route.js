export const runtime = 'nodejs';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await res.json();
  return data.result;
}

const VALID_KEYS = new Set([
  'top_stories','market_snapshot','ticker_tape',
]);

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const dataKey = searchParams.get('key');

  if (!dataKey || !VALID_KEYS.has(dataKey)) {
    return Response.json({ error: 'Invalid key' }, { status: 400 });
  }

  try {
    const cached = await kvGet(`catalystpit:${dataKey}`);
    if (cached) {
      const lastRefresh = await kvGet('catalystpit:last_refresh');
      return Response.json(
        { data: typeof cached === 'string' ? JSON.parse(cached) : cached, source: 'cache', lastRefresh },
        { status: 200, headers: { 'Cache-Control': 'public, s-maxage=900' } }
      );
    }
    // Cache miss → empty payload + 200 (not 503) so consumers render their empty
    // state instead of breaking. top_stories' 4h TTL expires nightly/weekends
    // between refresh-content cron runs; "no data right now" is a 200 with [].
    return Response.json({ data: [], source: 'empty' }, { status: 200 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const dataKey = body.key || body.type;
    if (!dataKey || !VALID_KEYS.has(dataKey)) {
      return Response.json({ error: 'Invalid key' }, { status: 400 });
    }
    const cached = await kvGet(`catalystpit:${dataKey}`);
    if (cached) {
      return Response.json(
        { data: typeof cached === 'string' ? JSON.parse(cached) : cached, source: 'cache' },
        { status: 200 }
      );
    }
    return Response.json({ data: [], source: 'empty' }, { status: 200 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
