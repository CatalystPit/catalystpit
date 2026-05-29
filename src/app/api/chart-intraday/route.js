import { fetchPolygonMinuteAggs } from '../../../lib/polygon-intraday.mjs';

export const runtime = 'nodejs';
export const maxDuration = 30;

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const RANGES = new Set(['1D', '5D']);
const DEFAULT_RANGE = '1D';
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;     // same gate as /api/ticker & /api/chart-daily

const DAY = 86_400_000;
const DELAYED = true;                            // Polygon Stocks Starter = 15-min delayed (flip to false on tier upgrade)

// Regular US session, in ET minutes-since-midnight: 9:30 (570) inclusive → 16:00 (960) exclusive.
// Polygon bar timestamps are the bar's START, so [570, 960) yields 78 five-min / 26 fifteen-min bars.
const OPEN_MIN = 570, CLOSE_MIN = 960;

// ET wall-clock parts for an epoch (handles DST automatically). hourCycle h23 avoids "24:00".
const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
});
function etInfo(ms) {
  const p = {};
  for (const x of ET_FMT.formatToParts(ms)) p[x.type] = x.value;
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    minutes: (+p.hour) * 60 + (+p.minute),
    isWeekday: p.weekday !== 'Sat' && p.weekday !== 'Sun',
  };
}
const inSession = (info) => info.isWeekday && info.minutes >= OPEN_MIN && info.minutes < CLOSE_MIN;

// TTL from the REQUEST time (not bar data): tighter cache while the market is live.
function ttlForNow() {
  const i = etInfo(Date.now());
  return (i.isWeekday && i.minutes >= OPEN_MIN && i.minutes < CLOSE_MIN) ? 300 : 3600;
}

// ─── Upstash KV (REST) — mirrors /api/ticker ─────────────────────────────────
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    const d = await r.json();
    return d.result ?? null;
  } catch { return null; }
}
async function kvSet(key, value, ttlSec) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?ex=${ttlSec}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' }, body: value,
    });
  } catch { /* cache-write failure is non-fatal */ }
}

function emptyResp(ticker, range) {
  return Response.json({ ticker, range, count: 0, bars: [], error: 'data_unavailable', meta: { cached: false, delayed: DELAYED, source: 'polygon' } });
}

export async function GET(request) {
  let ticker = '', range = DEFAULT_RANGE;
  try {
    const params = new URL(request.url).searchParams;
    ticker = (params.get('ticker') || '').toUpperCase().trim();
    range  = params.get('range') || DEFAULT_RANGE;
    if (!RANGES.has(range)) range = DEFAULT_RANGE;
    if (!TICKER_RE.test(ticker)) return emptyResp(ticker, range);

    const key     = `chart:intraday:${ticker}:${range}`;
    const lastKey = `${key}:last`;

    // HIT → serve fresh cache, no Polygon call.
    const hit = await kvGet(key);
    if (hit != null) {
      try {
        const v = JSON.parse(hit);
        return Response.json({ ...v, meta: { ...v.meta, cached: true } });
      } catch { /* corrupt entry → fall through to refetch */ }
    }

    // MISS → one Polygon call over a small window; keep the last N distinct ET trading days.
    //   1D: 5-min bars, last 1 session;  5D: 15-min bars, last 5 sessions.
    //   Multi-day window in a single call handles weekends/holidays (today may be non-trading).
    const mult   = range === '5D' ? 15 : 5;
    const keepN  = range === '5D' ? 5 : 1;
    const now    = Date.now();
    const from   = etInfo(now - (range === '5D' ? 9 : 5) * DAY).ymd;
    const to     = etInfo(now).ymd;

    // Accept either env-var name: POLYGON_API_KEY (local .env.local) or POLYGON_KEY (Vercel).
    const { ok, results } = await fetchPolygonMinuteAggs(ticker, mult, from, to, process.env.POLYGON_API_KEY || process.env.POLYGON_KEY);

    if (!ok) {
      // Polygon failed → better stale than empty: serve the long-lived last-good copy if present.
      const stale = await kvGet(lastKey);
      if (stale != null) {
        try { const v = JSON.parse(stale); return Response.json({ ...v, meta: { ...v.meta, cached: true } }); }
        catch { /* fall through */ }
      }
      console.log(`[chart_intraday] ${ticker} ${range} polygon failed, no stale cache`);
      return emptyResp(ticker, range);
    }

    // Map → UTC seconds (Lightweight Charts wants UNIX seconds), filter to regular session.
    const mapped = results
      .map((b) => ({ time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, _et: etInfo(b.t) }))
      .filter((b) => inSession(b._et));

    const dates = [...new Set(mapped.map((b) => b._et.ymd))].sort();
    const keep  = new Set(dates.slice(-keepN));
    const bars  = mapped.filter((b) => keep.has(b._et.ymd)).map(({ _et, ...rest }) => rest);

    if (bars.length === 0) return emptyResp(ticker, range);     // junk ticker / no session data

    const payload = { ticker, range, count: bars.length, bars, meta: { cached: false, delayed: DELAYED, source: 'polygon' } };
    await kvSet(key, JSON.stringify(payload), ttlForNow());     // primary: computed 5min/1hr TTL
    await kvSet(lastKey, JSON.stringify(payload), 21600);       // last-good: 6h, for Polygon-fail fallback
    console.log(`[chart_intraday] ${ticker} ${range} bars=${bars.length} sessions=${keep.size} ttl=${ttlForNow()}s`);
    return Response.json(payload);
  } catch (e) {
    console.log(`[chart_intraday] ${ticker} ${range} failed: ${e.message}`);
    return emptyResp(ticker, range);
  }
}
