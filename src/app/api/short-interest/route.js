import { db } from '../../../lib/db';
import { shortInterest, tickerFloat } from '../../../lib/schema';
import { eq, desc } from 'drizzle-orm';
import { fetchFloat } from '../../../lib/finra-short-interest.mjs';

export const runtime = 'nodejs';
export const maxDuration = 30;

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const FMP_API_KEY = process.env.FMP_API_KEY;
const TTL_SECONDS = 60 * 60 * 6;      // 6h — short interest changes twice a month
const HISTORY_LIMIT = 12;             // last 12 settlement periods
const FLOAT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // refetch float when older than 30 days

// ── tiny KV helpers (REST; same pattern as /api/earnings, /api/ticker) ──
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const { result } = await r.json();
    return result ? JSON.parse(result) : null;
  } catch { return null; }
}

async function kvSet(key, value, ttl) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?EX=${ttl}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch { /* cache write failure is non-fatal */ }
}

// Lazy float resolver: read ticker_float; if missing/stale, fetch FMP once and upsert.
// Returns { float_shares, outstanding_shares, free_float_pct } or null. Never throws —
// a float failure must not break the short-interest response.
async function resolveFloat(ticker) {
  try {
    const [row] = await db.select().from(tickerFloat).where(eq(tickerFloat.ticker, ticker)).limit(1);
    const fresh = row && row.updatedAt && (Date.now() - new Date(row.updatedAt).getTime() < FLOAT_MAX_AGE_MS);
    if (fresh) {
      return { float_shares: row.floatShares, outstanding_shares: row.outstandingShares, free_float_pct: row.freeFloatPct };
    }
    const f = await fetchFloat(ticker, FMP_API_KEY);
    if (!f) {
      // FMP failed: serve a stale cached row if we have one, else null.
      return row ? { float_shares: row.floatShares, outstanding_shares: row.outstandingShares, free_float_pct: row.freeFloatPct } : null;
    }
    await db.insert(tickerFloat)
      .values({ ticker, floatShares: f.floatShares, outstandingShares: f.outstandingShares, freeFloatPct: f.freeFloatPct, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: tickerFloat.ticker,
        set: { floatShares: f.floatShares, outstandingShares: f.outstandingShares, freeFloatPct: f.freeFloatPct, updatedAt: new Date() },
      });
    return { float_shares: f.floatShares, outstanding_shares: f.outstandingShares, free_float_pct: f.freeFloatPct };
  } catch { return null; }   // float failure must never break the short-interest response
}

// DB row (camelCase from drizzle) → API row (snake_case per the response spec).
const shape = (r) => ({
  settlement_date:      r.settlementDate,
  short_int_shares:     r.shortIntShares,
  prev_short_int_shares: r.prevShortIntShares,
  avg_daily_volume:     r.avgDailyVolume,
  days_to_cover:        r.daysToCover,
  change_percent:       r.changePercent,
  market_center:        r.marketCenter,
  issue_name:           r.issueName,
});

export async function GET(request) {
  let ticker;
  try {
    const { searchParams } = new URL(request.url);
    ticker = searchParams.get('ticker')?.toUpperCase().trim();
    if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
      return Response.json({ error: 'Invalid ticker' }, { status: 400 });
    }

    const cacheKey = `shortint:${ticker}`;
    const cached = await kvGet(cacheKey);
    if (cached) return Response.json({ ...cached, meta: { ...(cached.meta || {}), cached: true } });

    const rows = await db.select().from(shortInterest)
      .where(eq(shortInterest.ticker, ticker))
      .orderBy(desc(shortInterest.settlementDate))
      .limit(HISTORY_LIMIT);

    const history = rows.map(shape);
    // Resolve float only when there's short-interest data (no point otherwise). float<=0
    // (e.g. ETFs) and null both render "—" for % of float in the UI.
    const float = history.length ? await resolveFloat(ticker) : null;
    const payload = {
      ticker,
      latest: history[0] || null,
      history,
      float,
      meta: { cached: false, source: 'finra' },
    };
    if (history.length) await kvSet(cacheKey, payload, TTL_SECONDS);   // don't cache empty (ticker may appear next report)
    return Response.json(payload);
  } catch (e) {
    console.log(`[short_interest_api] failed: ${e.message}`);
    return Response.json(
      { ticker: ticker || null, latest: null, history: [], meta: { cached: false, source: 'finra' }, error: 'data_unavailable' },
      { status: 200 },
    );
  }
}
