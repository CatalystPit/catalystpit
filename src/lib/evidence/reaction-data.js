// Market reaction — the database half.
//
// ── NO QUERY PER MARKER ─────────────────────────────────────────────────────
//
// A timeline can carry dozens of markers and a mega-cap carries eighty. Fetching candles per event
// would be an eighty-query page. Instead the whole candle range a ticker's evidence could possibly
// need is fetched ONCE, and every reaction is computed in memory against that one array.
//
// Cost per request, independent of marker count:
//   1  ticker candles over the evidence span plus the longest horizon
//   1  price quality + breaks for the ticker
//   0  benchmark candles, amortised — SPY is identical for every viewer and every ticker, so it is
//      held process-wide behind a TTL rather than refetched per request
//
// ── WHICH ADJUSTMENT, AND WHY IT IS NOT "BOTH" ──────────────────────────────
//
// Reaction requires a SPLIT-ADJUSTED series (price-semantics.mjs, REQUIRED_CONVENTION). It must not
// be total-return. A total-return series back-adjusts historic prices downward by every dividend
// paid since, so a bar's "return" silently includes distributions the tape never showed on that day
// — and this module's whole claim is that it reports what the tape did after a disclosure.
//
// This comment used to say splits AND dividends were handled at ingest. That described the old
// convention and was corrected when the adjustment seam was repaired: the repaired tickers now
// store raw OHLC scaled by split factor only. Dividends are deliberately NOT removed.
//
// ⚠️ THE TABLE IS NOT YET UNIFORM. Only the vendor-confirmed seam tickers have been converted; other
// tickers may still carry total-return rows from the older ingest. The difference is small on recent
// bars and grows with age, so a reaction far back on an unrepaired dividend payer can still read
// high. That is a known, bounded data-quality gap, not something this module can correct — it cannot
// tell the two conventions apart from the numbers alone.
//
// What adjustment CANNOT fix is a series that stops describing the same security — a retired symbol
// reassigned to a new company, or a reverse split the vendor never applied. price-continuity.mjs
// detects those and ticker_price_breaks records them; a return whose window contains one is
// suppressed rather than shown, because it is a number about two different companies.

import { sql } from 'drizzle-orm';
import { db } from '../db';
import { computeReaction, HORIZONS, BENCHMARK } from './reaction.mjs';

const DAY = 86_400_000;
const rows = (res) => res?.rows ?? res ?? [];
const MAX_HORIZON = Math.max(...HORIZONS);

// Calendar days to fetch beyond the last event so the longest horizon can complete. 63 sessions is
// about 91 calendar days; the margin covers holidays and long weekends.
const HORIZON_PAD_DAYS = Math.ceil(MAX_HORIZON * 1.6) + 10;
// Sessions before the earliest event, so its anchor (the close BEFORE it) is always in range.
const ANCHOR_PAD_DAYS = 12;

// ── the benchmark, held once per process ─────────────────────────────────────
// SPY is the same series for every ticker and every viewer. Refetching it per request would be the
// single most wasteful query on the page.
let _bench = null;
let _benchAt = 0;
let _benchFrom = null;
const BENCH_TTL_MS = 30 * 60 * 1000;

async function benchmarkCloses(fromISO, { now = Date.now() } = {}) {
  const fresh = _bench && now - _benchAt < BENCH_TTL_MS && _benchFrom && _benchFrom <= fromISO;
  if (fresh) return _bench;
  const res = await db.execute(sql`
    select date::text as date, close
      from ticker_daily_candles
     where ticker = ${BENCHMARK}
       and date >= ${fromISO}
     order by date asc`);
  const map = new Map();
  for (const r of rows(res)) map.set(String(r.date), Number(r.close));
  _bench = map; _benchAt = now; _benchFrom = fromISO;
  return map;
}

/** Test seam. */
export function __setBenchmark(map, fromISO = '1900-01-01') {
  _bench = map; _benchAt = Date.now(); _benchFrom = fromISO;
}

/**
 * Attach a `reaction` to every evidence item that has one.
 *
 * Mutating-free: returns a new array. Items keep their identity and every other field, so a caller
 * that does not care about reactions is unaffected.
 *
 * DEGRADES SILENTLY AND COMPLETELY. Market reaction is context on top of evidence; if the candle
 * data is missing, unusable or the query fails, the evidence itself is still correct and still
 * shown. A ticker page must never lose its filings because a price series is unavailable.
 */
export async function attachReactions(ticker, evidence, { now = Date.now() } = {}) {
  const list = Array.isArray(evidence) ? evidence : [];
  if (!list.length) return list;

  const times = list.map((e) => new Date(e.publicTime).getTime()).filter(Number.isFinite);
  if (!times.length) return list;

  const earliest = Math.min(...times);
  const fromISO = new Date(earliest - ANCHOR_PAD_DAYS * DAY).toISOString().slice(0, 10);
  const toISO = new Date(Math.min(now, Math.max(...times) + HORIZON_PAD_DAYS * DAY))
    .toISOString().slice(0, 10);

  try {
    const [candleRes, qualityRes, bench] = await Promise.all([
      db.execute(sql`
        select date::text as date, close
          from ticker_daily_candles
         where ticker = ${ticker}
           and date >= ${fromISO}
           and date <= ${toISO}
         order by date asc`),
      // Quality verdict and break dates in one round trip. Both are tiny.
      db.execute(sql`
        select
          (select coalesce(usable, true) from ticker_price_quality where ticker = ${ticker}) as usable,
          (select coalesce(array_agg(break_date::text), '{}')
             from ticker_price_breaks where ticker = ${ticker}) as breaks`),
      benchmarkCloses(fromISO, { now }),
    ]);

    const bars = rows(candleRes).map((r) => ({ date: String(r.date), close: Number(r.close) }))
      .filter((b) => Number.isFinite(b.close));
    if (bars.length < 2) return list;

    const q = rows(qualityRes)[0] || {};
    // A ticker absent from ticker_price_quality has not been scanned; treated as usable, which is
    // what every other surface does. The break list is the harder guard and applies regardless.
    const usable = q.usable !== false;
    const breaks = Array.isArray(q.breaks) ? q.breaks.map(String) : [];

    return list.map((e) => {
      const reaction = computeReaction({
        // ⚠️ publicTime, and only publicTime. Never eventTime, referencePeriod, facts.quarterEnd or
        // facts.transactionDate — the same rule that governs marker placement governs the clock the
        // reaction is measured from.
        publicTime: e.publicTime,
        bars, benchBars: bench, breaks, usable,
      });
      return reaction?.hasAny ? { ...e, reaction } : e;
    });
  } catch {
    // Reaction is an enhancement. Losing it must not cost the evidence.
    return list;
  }
}
