import { db } from '../db';
import { sql } from 'drizzle-orm';
import { TRADEABLE_ASSET_TYPES } from '../heatmap/heatmap-universe.mjs';
import { marketPhase, previousTradingDay, OPEN_MINUTE } from '../market/market-session.mjs';
import { rankMovers } from './movers-universe.mjs';

// MARKET-WIDE TOP GAINERS / TOP LOSERS — one shared rebuild per 15 minutes, for the whole market.
//
// ⚠️ INDEPENDENT OF THE HEATMAP BY DESIGN. The heatmap's universe is the Top 500 by market cap and
// must not change; these lists rank every eligible US operating company. They share a refresh
// CADENCE and a session lifecycle, and nothing else — different universe, different key namespace,
// different upstream call.
//
// ── THE ECONOMICS, MEASURED ─────────────────────────────────────────────────
//
// `GET /iex` with no ticker list returns the ENTIRE market in ONE request: 42,590 rows, 12.08MB,
// ~1.5s. That is the whole upstream cost of a rebuild. Batching the eligible symbols 100 at a time
// would have cost ~56 requests for a worse answer, so this is not merely cheaper — it is the only
// call shape that makes a market-wide list affordable:
//
//     1 request per rebuild  ·  4 rebuilds/hour  ·  26 per trading day
//     ≈ 0.013% of the 30,000/hour budget, and FLAT in viewer count.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Namespaced away from production by any probe, exactly as the heatmap snapshot is — `.env.local`
// points at the same Upstash instance production uses.
const NS = String(process.env.CP_HEATMAP_KV_NAMESPACE || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
const PREFIX = NS ? `cp:mv:${NS}` : 'cp:mv';

export const SNAPSHOT_TTL_SEC = 15 * 60;
export const SNAPSHOT_KEEP_SEC = 26 * 60 * 60;   // survives the closed period so the board can freeze
export const REBUILD_LOCK_SEC = 60;              // a market-wide rebuild is slower than the heatmap's
export const snapshotKey = () => `${PREFIX}:rt`;
export const lockKey = () => `${PREFIX}:lock`;
export const kvNamespace = () => NS || null;

const kv = async (path, body) => {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

/**
 * The eligible universe and its baseline, in one query.
 *
 * ⚠️ MEMBERSHIP OF THIS MAP *IS* THE ELIGIBILITY RULE, and it is the existing one: the security
 * master's `asset_type` filtered by TRADEABLE_ASSET_TYPES ('Stock', 'ADRC'), which is where this
 * product already decides what is an operating company. ETFs, ETNs, ETVs, ETSs, funds, warrants,
 * rights, units, preferreds and structured products are excluded because they are not that type —
 * not because of anything about their symbol. There is no ticker-shape heuristic here.
 *
 * Requiring a close for the named session also removes delisted and dormant names for free: a
 * security that did not trade the previous session has no row.
 *
 * ⚠️ AND THE CLOSE IS OURS, SPLIT-ADJUSTED. See movers-universe.mjs for the measurements — the
 * vendor's own `prevClose` on this endpoint is NOT split-adjusted, and ranking on it puts a stock
 * that moved +1.23% at the top of the page at +10,377%.
 */
export async function baselineCloses(sessionDate) {
  const types = sql`${`{${TRADEABLE_ASSET_TYPES.join(',')}}`}::text[]`;
  const res = await db.execute(sql`
    select c.ticker, c.close::float8 as close
      from ticker_daily_candles c
      join screener_meta m on m.ticker = c.ticker
     where c.date = ${sessionDate}
       and coalesce(m.asset_type, '') = any(${types})
       and c.close > 0`);
  const out = new Map();
  for (const r of (res.rows ?? res)) out.set(String(r.ticker).toUpperCase(), Number(r.close));
  return out;
}

/** Names for display. Only fetched for the ~20 symbols that actually rank. */
async function namesFor(tickers) {
  if (!tickers.length) return new Map();
  const list = sql`${`{${tickers.join(',')}}`}::text[]`;
  const res = await db.execute(sql`
    select s.ticker, coalesce(s.company, i.name, m.name) as company
      from screener_stocks s
      left join security_identity i on i.ticker = s.ticker
      left join screener_meta     m on m.ticker = s.ticker
     where s.ticker = any(${list})`);
  const out = new Map();
  for (const r of (res.rows ?? res)) out.set(String(r.ticker).toUpperCase(), r.company || null);
  return out;
}

/** The instant this session opened, in ms — the cutoff that separates today's print from a relic. */
export function sessionOpenMs(sessionDate) {
  if (!sessionDate) return NaN;
  const noonUtc = Date.parse(`${sessionDate}T12:00:00Z`);
  if (!Number.isFinite(noonUtc)) return NaN;
  // ET's UTC offset ON THAT DATE, read from the real DST calendar rather than assumed: at 12:00
  // UTC the ET hour is 08 during EDT and 07 during EST, giving 4 and 5. A hardcoded offset is
  // wrong for half the year, and here that would mean an hour of the session treated as stale.
  const etHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  }).formatToParts(new Date(noonUtc)).find((p) => p.type === 'hour')?.value);
  if (!Number.isFinite(etHour)) return NaN;
  const offsetHours = 12 - etHour;
  return Date.parse(`${sessionDate}T00:00:00Z`) + (OPEN_MINUTE / 60 + offsetHours) * 3600_000;
}

async function readSnapshot() {
  const r = await kv(`/get/${encodeURIComponent(snapshotKey())}`);
  const raw = r?.result;
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

async function writeSnapshot(snap) {
  await kv(`/set/${encodeURIComponent(snapshotKey())}?EX=${SNAPSHOT_KEEP_SEC}`, snap);
  return snap;
}

async function acquireLock() {
  // `NX`, not `NX=true` — the latter is a 400 from the REST API, which reads as "someone else holds
  // it" and would mean no instance ever rebuilds. That exact typo shipped once on the heatmap lock.
  const r = await kv(`/set/${encodeURIComponent(lockKey())}/1?NX&EX=${REBUILD_LOCK_SEC}`);
  return r?.result === 'OK';
}

const ageMs = (snap, now) => (snap?.calculatedAt ? now - Date.parse(snap.calculatedAt) : null);

/**
 * THE COMPLETED-SESSION LIST — close-to-close, straight from stored candles.
 *
 * ⚠️ THIS IS WHAT A FREE READER GETS, AND IT COSTS ZERO TIINGO REQUESTS. It is also what everyone
 * gets once the official close has landed. Both ends are settled official closes, so it needs no
 * entitlement and no live feed; the entitled intraday list is a strictly separate path.
 */
export async function completedSessionMovers({ limit = 10 } = {}) {
  const types = sql`${`{${TRADEABLE_ASSET_TYPES.join(',')}}`}::text[]`;
  const res = await db.execute(sql`
    with latest as (select max(date) d from ticker_daily_candles),
         prev   as (select max(date) d from ticker_daily_candles where date < (select d from latest))
    select c.ticker,
           c.close::float8  as price,
           p.close::float8  as prev_close,
           (select d from latest)::text as as_of,
           (select d from prev)::text   as baseline_date,
           ((c.close - p.close) / p.close * 100)::float8 as pct
      from ticker_daily_candles c
      join ticker_daily_candles p on p.ticker = c.ticker and p.date = (select d from prev)
      join screener_meta m on m.ticker = c.ticker
     where c.date = (select d from latest)
       and coalesce(m.asset_type, '') = any(${types})
       and c.close > 0 and p.close > 0`);
  const rows = (res.rows ?? res).map((r) => ({
    ticker: String(r.ticker).toUpperCase(), price: Number(r.price),
    prevClose: Number(r.prev_close), pct: Number(r.pct), baselineDate: r.baseline_date,
  })).filter((r) => Number.isFinite(r.pct));

  const asOf = (res.rows ?? res)[0]?.as_of ?? null;
  const baselineDate = (res.rows ?? res)[0]?.baseline_date ?? null;
  const by = (d) => (a, b) => d * (a.pct - b.pct) || a.ticker.localeCompare(b.ticker);
  const gainers = [...rows].sort(by(-1)).slice(0, limit);
  const losers = [...rows].sort(by(1)).slice(0, limit);
  const names = await namesFor([...gainers, ...losers].map((r) => r.ticker));
  const dress = (r) => ({ ...r, company: names.get(r.ticker) ?? null });
  return {
    gainers: gainers.map(dress), losers: losers.map(dress),
    asOf, baselineDate, freshness: 'eod', universeCount: rows.length,
    snapshotAt: null, session: null,
  };
}

/**
 * THE MARKET-WIDE INTRADAY LIST, for an entitled reader, from one shared snapshot.
 *
 * Mirrors the heatmap's lifecycle exactly — rebuild only between the bells, freeze after, hand over
 * to the completed session once the official closes land — because they are the same lifecycle,
 * not because they share any data.
 */
export async function marketMovers({ realtime = false, limit = 10, now = Date.now() } = {}) {
  const session = marketPhase(now);

  // Free, signed out, or vendor realtime disabled → the completed-session list. No Tiingo call.
  const { tiingoRealtimeEnabled } = await import('../market/tiingo.mjs');
  if (!realtime || !tiingoRealtimeEnabled()) {
    const eod = await completedSessionMovers({ limit });
    return { ...eod, session: { ...session, frozen: false, final: true } };
  }

  const serve = async (snap, frozen) => {
    const names = await namesFor([...(snap.gainers || []), ...(snap.losers || [])].map((r) => r.ticker));
    const dress = (r) => ({ ...r, company: names.get(r.ticker) ?? null });
    return {
      gainers: (snap.gainers || []).map(dress), losers: (snap.losers || []).map(dress),
      asOf: snap.sessionDate, baselineDate: snap.baselineDate,
      freshness: 'realtime', snapshotAt: snap.calculatedAt,
      universeCount: snap.counts?.ranked ?? null, counts: snap.counts ?? null,
      session: { ...session, frozen, final: false },
    };
  };

  const snap = await readSnapshot();
  const ofSession = snap && snap.sessionDate === session.sessionDate;

  // ⚠️ OUTSIDE THE BELLS, NOTHING UPSTREAM HAPPENS — evenings, overnight, weekends, holidays. The
  // final ranking of the session is served frozen; once the official closes land the completed
  // list takes over and is authoritative.
  if (session.phase !== 'regular') {
    if (ofSession) return serve(snap, true);
    const eod = await completedSessionMovers({ limit });
    return { ...eod, session: { ...session, frozen: false, final: true } };
  }

  if (ofSession && ageMs(snap, now) != null && ageMs(snap, now) <= SNAPSHOT_TTL_SEC * 1000) {
    return serve(snap, false);
  }

  // One rebuild across all instances; everyone else serves what is already there.
  if (!(await acquireLock())) {
    if (ofSession) return serve(snap, false);
    const eod = await completedSessionMovers({ limit });
    return { ...eod, session: { ...session, frozen: false, final: false } };
  }

  // ⚠️ THE BASELINE SESSION IS A CALENDAR FACT. The previous trading day walks the real exchange
  // calendar, so Monday looks back to Friday and the day after Thanksgiving looks back to Wednesday.
  const baselineDate = previousTradingDay(session.sessionDate, { inclusive: false });
  const [baselines, quotes] = await Promise.all([
    baselineCloses(baselineDate),
    (async () => {
      const { getAllTickersSnapshot } = await import('../market/tiingo.mjs');
      const res = await getAllTickersSnapshot();
      // `lastPrice`, never `price` — see the note on that field. `price` degrades to prevClose,
      // and an unadjusted prevClose over our split-adjusted close is a fabricated −99%.
      return res?.ok ? res.rows.map((r) => ({ ticker: r.symbol, tngoLast: r.lastPrice, timestamp: r.asOf })) : [];
    })(),
  ]);

  const ranked = rankMovers(quotes, baselines, {
    sessionOpenMs: sessionOpenMs(session.sessionDate), baselineDate, limit,
  });

  if (!ranked.counts.ranked) {
    // Nothing usable. Prefer the last good ranking, then the completed session — never a blank list.
    if (ofSession) return serve(snap, false);
    const eod = await completedSessionMovers({ limit });
    return { ...eod, session: { ...session, frozen: false, final: false } };
  }

  const fresh = {
    gainers: ranked.gainers, losers: ranked.losers, counts: ranked.counts,
    baselineDate, sessionDate: session.sessionDate,
    calculatedAt: new Date(now).toISOString(), kind: 'market-movers-1d',
  };
  await writeSnapshot(fresh);
  return serve(fresh, false);
}
