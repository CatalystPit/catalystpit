import { db } from '../../../lib/db';
import { shortInterest } from '../../../lib/schema';
import { eq, desc } from 'drizzle-orm';
import { resolveFloat } from '../../../lib/finra-short-interest.mjs';

export const runtime = 'nodejs';
export const maxDuration = 30;

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TTL_SECONDS = 60 * 60 * 6;      // 6h — short interest changes twice a month
const HISTORY_LIMIT = 12;             // last 12 settlement periods

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

// resolveFloat now lives in lib/finra-short-interest.mjs — SHARED with /api/ticker (hero)
// so the tab's % of float and the hero's % of float can never diverge for the same ticker.

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
