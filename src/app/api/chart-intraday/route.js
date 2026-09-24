import { auth } from '@clerk/nextjs/server';
import { resolveUserAccess, isRealtime } from '../../../lib/entitlements';
import { getIntradayBars } from '../../../lib/market/tiingo.mjs';
import { DELAY_MS } from '../../../lib/market/delayed-store.mjs';
import { TIMEFRAMES, timeframe, isServable } from '../../../lib/chart/chart-source.mjs';

export const runtime = 'nodejs';
export const maxDuration = 30;

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// THE ROUTE READS THE REGISTRY, it does not keep its own list. Every intraday timeframe declares the
// bar multiplier it needs, how many trading sessions to keep and how many calendar days to request,
// so adding an interval is a registry entry and this file does not change. An id the current adapter
// cannot serve is refused rather than silently answered at the default resolution — a chart labelled
// "3 minutes" showing 5-minute bars is worse than a chart showing nothing.
const INTRADAY = new Map(
  TIMEFRAMES.filter((t) => t.kind === 'intraday' && isServable(t.id)).map((t) => [t.id, t.request]),
);
// ⚠️ MUST BE A SERVABLE INTRADAY ID. This was '1D', which is the DAILY timeframe — not in the
// INTRADAY map at all — so a request with a missing or unrecognised range fell back to it,
// INTRADAY.get() returned undefined, destructuring threw, and the route answered
// `data_unavailable` every time. Pre-existing and invisible in practice, because barsUrl() always
// sends an explicit id; found by requesting ?range=1D by hand.
const DEFAULT_RANGE = '5m';
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;     // same gate as /api/ticker & /api/chart-daily

const DAY = 86_400_000;
// ⚠️ DELAY IS NOW AN ENTITLEMENT, NOT A CONSTANT. It used to be a hardcoded `true` describing
// Polygon's Stocks Starter plan. The source is Tiingo, which serves current candles; whether a
// given RESPONSE is delayed depends on who asked, and is enforced by truncating the bars below.

// Regular US session, in ET minutes-since-midnight: 9:30 (570) inclusive → 16:00 (960) exclusive.
// Bar timestamps are the bar's START, so [570, 960) yields 78 five-min / 26 fifteen-min bars.
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

// EXTENDED HOURS. The intraday feed returns the full tape — verified against the
// live API: 04:00 to 19:55 ET on a normal weekday, 66 pre-market and 48 after-hours 5-minute bars
// alongside the 78 regular-session ones. Only the regular session was ever published because this
// filter dropped the rest, not because the data was missing.
//
// Opt-in per request. The default stays exactly as it was, so every existing caller is unaffected.
const PRE_MIN = 240, POST_MIN = 1200;   // 04:00 and 20:00 ET
const inExtended = (info) => info.isWeekday && info.minutes >= PRE_MIN && info.minutes < POST_MIN;

// TTL from the REQUEST time (not bar data): tighter cache while the market is live.
//
// ⚠️ "LIVE" MEANS THE EXTENDED SESSION, NOT THE REGULAR ONE — and getting that wrong is what froze
// the pre-market chart. This asked `minutes >= OPEN_MIN`, so at 08:05 ET the market counted as
// closed and the payload was cached for a full HOUR. The 15-minute series built at 08:05 held one
// bar (08:00), and it kept serving that single bar until 09:05 while Tiingo already had 08:15 and
// 08:30 — which is exactly the "one current-session candle" the chart showed, and why the forming
// bucket appeared not to update. The bars were never mis-bucketed; the response was stale.
//
// inExtended is 04:00–20:00 on a weekday, so pre-market and after-hours now get the same 300s TTL
// the regular session always had. Outside the tape entirely, an hour is still right.
function ttlForNow() {
  return inExtended(etInfo(Date.now())) ? 300 : 3600;
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
  return Response.json({ ticker, range, count: 0, bars: [], error: 'data_unavailable', meta: { cached: false, delayed: null, source: 'tiingo' } });
}

/**
 * ⚠️ THE FREE CUTOFF, ENFORCED ON THE SERVER, ON A BAR'S END RATHER THAN ITS START.
 *
 * A bar is stamped with the moment it OPENS, so a 5-minute bar stamped 14:15 contains trading up to
 * 14:20. Cutting on the stamp would hand a Free viewer at 14:30 data that is ten minutes old, not
 * fifteen. The test is therefore barStart + barLength <= now − delay, which at 14:30 admits the bar
 * opening 14:10 and closing 14:15, and no later one.
 *
 * This runs before the response is built, so the bars simply are not in the payload. Nothing is
 * sent and hidden, and no client-side filter is trusted with an entitlement.
 */
export function truncateForDelay(bars, barMinutes, now = Date.now(), delayMs = DELAY_MS) {
  const cutoffSec = Math.floor((now - delayMs) / 1000);
  const lenSec = Math.max(1, Number(barMinutes) || 1) * 60;
  return (bars || []).filter((b) => Number(b.time) + lenSec <= cutoffSec);
}

export async function GET(request) {
  let ticker = '', range = DEFAULT_RANGE;
  try {
    const params = new URL(request.url).searchParams;
    ticker = (params.get('ticker') || '').toUpperCase().trim();
    range  = params.get('range') || DEFAULT_RANGE;
    if (!INTRADAY.has(range)) range = DEFAULT_RANGE;
    // 'extended' is the only value that changes anything; anything else means the regular session.
    const session = params.get('session') === 'extended' ? 'extended' : 'regular';
    if (!TICKER_RE.test(ticker)) return emptyResp(ticker, range);

    // ⚠️ RESOLVED FROM THE SESSION, NEVER FROM THE QUERY. A caller adding ?rt=1 or ?realtime=true
    // changes nothing here; the only parameters this route reads are ticker, range and session.
    let entitled = false;
    try {
      const { userId } = await auth();
      if (userId) { const { tier, beta } = await resolveUserAccess(); entitled = isRealtime(tier) && !beta; }
    } catch { /* signed out → delayed */ }

    const { barMinutes: mult, sessions: keepN, lookbackDays } = INTRADAY.get(range);

    // ⚠️ ONE CACHED BAR SET SERVES BOTH AUDIENCES, AND THE TRUNCATION IS WHAT KEEPS THAT SAFE.
    //
    // The cache holds the FULL set, so a thousand Free viewers and a Pro viewer of AAPL share a
    // single upstream fetch — chart cost scales with symbol demand and cache interval, not with
    // page views. Entitlement is applied when the RESPONSE is built, on every path including the
    // cache hit and the stale fallback, so a Free reader never receives the newer bars however the
    // payload was obtained. Caching per entitlement instead would double upstream cost to achieve
    // nothing: the bars are identical, only the visible tail differs.
    const respond = (payload, cached) => {
      const full = payload.bars || [];
      const bars = entitled ? full : truncateForDelay(full, mult);
      return Response.json({
        ...payload,
        count: bars.length,
        bars,
        meta: {
          ...payload.meta,
          cached,
          source: 'tiingo',
          // States what this RESPONSE is, which is what the chart labels from.
          delayed: !entitled,
          delayMinutes: entitled ? 0 : Math.round(DELAY_MS / 60000),
          freshness: entitled ? 'realtime' : 'delayed',
        },
      });
    };

    // THE SESSION BELONGS IN THE KEY. Without it the first caller's shape is served to the other —
    // a cache that returns the wrong data rather than a slow one.
    // ⚠️ THE SESSION COUNT BELONGS IN THE KEY FOR THE SAME REASON THE SESSION DOES. The number of
    // trading days kept is part of the payload's SHAPE, so when the registry changes it — as it
    // just did for 1m and 5m — every cached entry built under the old value stays valid for its
    // full hour and keeps serving the old shape. Keying on it means the new window is live on
    // deploy instead of an hour later, and a future registry change cannot silently serve stale
    // geometry either.
    const key     = `chart:intraday:${ticker}:${range}:s${keepN}${session === 'extended' ? ':ext' : ''}`;
    const lastKey = `${key}:last`;

    // HIT → serve fresh cache, no upstream call.
    const hit = await kvGet(key);
    if (hit != null) {
      try {
        return respond(JSON.parse(hit), true);
      } catch { /* corrupt entry → fall through to refetch */ }
    }

    // MISS → one upstream call over a small window; keep the last N distinct ET trading days.
    // The numbers come from the timeframe's own declaration — e.g. 4 hours is a 240-minute
    // multiple over 60 sessions, requested across 95 calendar days so weekends and holidays cannot
    // shorten the window.
    const now    = Date.now();
    const from   = etInfo(now - lookbackDays * DAY).ymd;
    const to     = etInfo(now).ymd;

    // ⚠️ TIINGO, UNDER OUR OWN LICENCE. This was Polygon Stocks Starter, whose redistribution
    // rights for public commercial display were never established — and "it works technically" is
    // not a right. Tiingo's IEX intraday endpoint carries the same OHLC (measured 287 sessions of
    // 60-minute history, deeper than any range this route offers) and is covered by the agreement.
    const res = await getIntradayBars(ticker, { from, to, freq: `${mult}min`, extendedHours: session === 'extended' });
    const ok = res.ok;
    const results = res.bars || [];

    if (!ok) {
      // Provider failed → better stale than empty: serve the long-lived last-good copy if present.
      // Still through respond(), so a stale payload is truncated for a Free reader too.
      const stale = await kvGet(lastKey);
      if (stale != null) {
        try { return respond(JSON.parse(stale), true); } catch { /* fall through */ }
      }
      console.log(`[chart_intraday] ${ticker} ${range} tiingo failed, no stale cache`);
      return emptyResp(ticker, range);
    }

    // Map → UTC seconds (Lightweight Charts wants UNIX seconds), filter to regular session.
    // ⚠️ NO VOLUME FIELD, DELIBERATELY. Tiingo's IEX intraday response carries none at all
    // (measured: date, open, high, low, close), and had it carried one it would be a single
    // venue's print, not consolidated US volume. A price chart with no volume histogram is
    // honest; a histogram of partial volume presented as the market's is not.
    const mapped = results
      .map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, _et: etInfo(b.time * 1000) }))
      .filter((b) => (session === 'extended' ? inExtended(b._et) : inSession(b._et)));

    const dates = [...new Set(mapped.map((b) => b._et.ymd))].sort();
    const keep  = new Set(dates.slice(-keepN));
    const bars  = mapped.filter((b) => keep.has(b._et.ymd)).map(({ _et, ...rest }) => rest);

    if (bars.length === 0) return emptyResp(ticker, range);     // junk ticker / no session data

    const payload = { ticker, range, count: bars.length, bars, meta: { cached: false, source: 'tiingo', session } };
    await kvSet(key, JSON.stringify(payload), ttlForNow());     // primary: computed 5min/1hr TTL
    await kvSet(lastKey, JSON.stringify(payload), 21600);       // last-good: 6h, for a provider-fail fallback
    console.log(`[chart_intraday] ${ticker} ${range} bars=${bars.length} sessions=${keep.size} ttl=${ttlForNow()}s`);
    // ⚠️ THE CACHE HOLDS THE FULL SET; THE RESPONSE IS TRUNCATED. Storing the untruncated bars is
    // what lets one fetch serve both audiences, and respond() is the only way out of this handler
    // — so the entitlement is applied on the fresh path, the cache-hit path and the stale path
    // alike, and cannot be bypassed by whichever one a request happens to take.
    return respond(payload, false);
  } catch (e) {
    console.log(`[chart_intraday] ${ticker} ${range} failed: ${e.message}`);
    return emptyResp(ticker, range);
  }
}
