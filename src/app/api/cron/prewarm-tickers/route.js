import { POPULAR_TICKERS } from '../../../../lib/popular-tickers.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;          // Vercel Pro ceiling; the loop is bounded well under this

const CRON_SECRET = process.env.CRON_SECRET;

// Rotating window: each run warms BATCH tickers; the window advances every 15-min slot so the
// full list is covered over ceil(total/BATCH) runs. Throttle is the GAP between tickers.
// Bound: BATCH * (PER_CALL_TIMEOUT + GAP) must stay < maxDuration.
//   20 * (8s + 6s) = 280s < 300s. Finnhub: ~4 calls/ticker, 1 ticker / 6s ≈ 40/min < 60 cap.
const BATCH = 20;
const GAP_MS = 6000;
const PER_CALL_TIMEOUT_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Warm one ticker's caches by hitting the public routes (reuses all their cache logic).
// The 4 endpoints hit different upstreams (Finnhub/Polygon, Polygon, Tiingo, SEC) → parallel
// is a controlled 4-call burst, not a per-ticker bottleneck; the inter-ticker GAP is the throttle.
//
// ── WARMING IS NOT REFETCHING ───────────────────────────────────────────────
//
// This job used to cost an upstream Tiingo request per ticker per run — 4 runs/hour x 20 tickers =
// 80/hour, which on its own exceeded the account's hourly allocation before a single visitor
// arrived. The cause was not this file: /api/chart-daily compared freshness against the calendar
// date, so "warm the cache" and "refetch from the vendor" were the same operation.
//
// With market/refresh-policy.mjs that is fixed at the route. A warm now reaches the provider only
// when a session has actually published — roughly once per ticker per day — and every other run is
// served from Postgres. Measured in scripts/verify-refresh-policy.mjs: 80/hour -> 20/hour, and a
// fully warm hour costs zero.
//
// The job is left calling the public routes deliberately: it exercises the same paths visitors do,
// so a cache that is warm here is warm for them. That property is worth more than shaving the
// internal hop, now that the hop is cheap.
async function warmTicker(base, sym) {
  const t0 = Date.now();
  const paths = [
    `/api/ticker?symbol=${encodeURIComponent(sym)}`,
    `/api/chart-intraday?ticker=${encodeURIComponent(sym)}&range=1D`,
    `/api/chart-daily?ticker=${encodeURIComponent(sym)}&range=3M`,
    `/api/earnings?ticker=${encodeURIComponent(sym)}`,
  ];
  const settled = await Promise.allSettled(paths.map((p) =>
    fetch(`${base}${p}`, { cache: 'no-store', signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS) })));
  const ok = settled.filter((s) => s.status === 'fulfilled' && s.value.ok).length;
  if (ok < paths.length) {
    const failed = paths.filter((_, i) => !(settled[i].status === 'fulfilled' && settled[i].value.ok))
      .map((p) => p.split('?')[0]).join(', ');
    console.log(`[prewarm-tickers] ${sym} ${ok}/${paths.length} (failed: ${failed}) ${Date.now() - t0}ms`);
  } else {
    console.log(`[prewarm-tickers] ${sym} ${ok}/${paths.length} ${Date.now() - t0}ms`);
  }
  return ok === paths.length;
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const base = new URL(request.url).origin;          // warm whatever env this runs on (shared KV/Postgres)
  const total = POPULAR_TICKERS.length;
  // Stateless rotation: window start derived from the 15-min time slot → no KV state, no race
  // when market + off-hours schedules overlap (both pick the same slice, harmless).
  const slot = Math.floor(Date.now() / (15 * 60 * 1000));
  const start = (slot * BATCH) % total;
  const slice = Array.from({ length: Math.min(BATCH, total) }, (_, i) => POPULAR_TICKERS[(start + i) % total]);

  const t0 = Date.now();
  let warmed = 0;
  for (let i = 0; i < slice.length; i++) {
    try { if (await warmTicker(base, slice[i])) warmed++; }
    catch (e) { console.log(`[prewarm-tickers] ${slice[i]} threw: ${e.message}`); }   // log + continue
    if (i < slice.length - 1) await sleep(GAP_MS);
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  console.log(`Pre-warm complete: ${warmed}/${slice.length} tickers warmed in ${seconds}s (window ${start}–${(start + slice.length - 1) % total} of ${total})`);
  return Response.json({ warmed, batch: slice.length, total, windowStart: start, seconds });
}
