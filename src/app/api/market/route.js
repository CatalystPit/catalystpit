export const runtime = 'nodejs';

// Client market-cache reader (KV). Split out of /api/claude so homepage/news market-data
// reads no longer hit a route named for the LLM (A6 / "Claude is not a market-data vendor").
// Same KV logic; serves cached ticker_tape / market_snapshot / top_stories.
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await res.json();
  return data.result;
}

const VALID_KEYS = new Set(['top_stories', 'market_snapshot', 'ticker_tape', 'pit_snapshot']);

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
        // ⚠️ THE EDGE CACHE OUTLIVED THREE GENERATIONS OF THE DATA IT WAS HOLDING.
        //
        // /api/refresh rewrites ticker_tape and market_snapshot every FIVE minutes, and this served
        // them with s-maxage=900 — so a visitor could be handed a tape fifteen minutes old, three
        // writes behind, with no way to tell. On 2026-11-23, when the fix for the session-mismatch
        // bug went live, KV was correct within a minute while the edge kept serving the wrong
        // percentages; a reader reloading the page in that window saw the defect that had already
        // been fixed. It also masks the failure in the other direction: a diagnostic read of this
        // endpoint reports the CDN's copy, not the data.
        //
        // A TTL may be shorter than the write cadence but never longer. stale-while-revalidate
        // keeps the burst protection: the edge still answers instantly from its copy and refreshes
        // behind the response, so nothing waits on KV.
        { status: 200, headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=240' } }
      );
    }
    return Response.json({ data: [], source: 'empty' }, { status: 200 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
