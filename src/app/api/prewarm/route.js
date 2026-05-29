export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;

// Popular tickers kept warm so first-visit cold loads (the ~2s /api/ticker gate) are rare.
// Mirrors /api/refresh's NEWS_TICKERS. Steady-state cost is tiny: profile is cached 24h, so each
// run only refreshes quote (5min TTL) + news, ~1 Finnhub + 1 Polygon per ticker per run.
const POPULAR = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META', 'GOOGL', 'AMD', 'NFLX', 'GOOG',
  'JPM', 'BAC', 'XOM', 'WMT', 'COIN', 'PLTR', 'BA', 'DIS', 'UBER', 'SHOP'];

// Low concurrency: each /api/ticker fans out to ~4 Finnhub calls, so keep the in-flight count
// modest to stay friendly with Finnhub's 60/min free tier. A cold burst that 429s simply
// self-heals next run (failed fetches aren't cached); steady-state is well under the limit.
async function throttle(items, conc, gapMs, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += conc) {
    out.push(...await Promise.all(items.slice(i, i + conc).map(fn)));
    if (i + conc < items.length) await new Promise((r) => setTimeout(r, gapMs));
  }
  return out;
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const base = new URL(request.url).origin;   // warm whatever env this runs on (shared KV)
  const t0 = Date.now();
  // Best-effort: cap each warm at 8s so one slow ticker can't blow the function budget
  // (it just gets warmed on the next run). Worst case ≈ 5 batches × (8s + 1s) ≈ 45s < maxDuration.
  const results = await throttle(POPULAR, 4, 1000, async (sym) => {
    try {
      const r = await fetch(`${base}/api/ticker?symbol=${encodeURIComponent(sym)}`,
        { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      return { sym, ok: r.ok };
    } catch (e) { return { sym, ok: false, err: e.message }; }
  });
  const warmed = results.filter((r) => r.ok).length;
  console.log(`[prewarm] ${warmed}/${POPULAR.length} tickers warmed in ${Date.now() - t0}ms`);
  return Response.json({ warmed, total: POPULAR.length, ms: Date.now() - t0 });
}
