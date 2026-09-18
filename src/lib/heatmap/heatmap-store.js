// READING THE HEATMAP — FOUR BOUNDED QUERIES, WHATEVER THE BOARD SIZE.
//
// The naive version of this page asks each ticker for its history and computes a return: 300 tickers
// is 300 round trips, and this codebase has already paid for that mistake twice (the 13F roll-up at
// 8.2s and symbol search at 11.6s). It is not repeated here.
//
// Instead, per request:
//   1. the universe — reference data (market cap, sector, name), ONE indexed read
//   2. the latest session close + volume per ticker, ONE `distinct on`
//   3. the baseline session close per ticker at or before the window's anchor, ONE `distinct on`
//   4. price-continuity verdicts for the universe, ONE read
//
// Four queries, each bounded by the universe size, none scanning the 2.8M-row candle table whole:
// `distinct on (ticker) … order by ticker, date desc` walks the (ticker, date) primary key backwards
// and stops at the first row per ticker.
//
// REFERENCE DATA STAYS SEPARATE FROM PRICE. Market cap and sector come from the screener tables and
// are static between nightly refreshes; only the two close reads are dynamic. That is what makes the
// live migration a change to step 2 alone — nothing about tile sizing recomputes on a tick.

import { sql } from 'drizzle-orm';
import { db } from '../db';
import { anchorDateFor, pctReturn, asDay, NO_RETURN, MAX_BASELINE_GAP_DAYS } from './heatmap-window.mjs';
import { TRADEABLE_ASSET_TYPES } from './heatmap-universe.mjs';
import { returnBlocked } from '../price-continuity.mjs';

/** The most recent session anywhere in our candle history — the board's `asOf`. */
export async function latestSessionDate() {
  const res = await db.execute(sql`select max(date)::text as d from ticker_daily_candles`);
  return (res.rows ?? res)[0]?.d ?? null;
}

/**
 * The universe: the largest securities we cover, with the reference data a tile needs.
 *
 * Company name comes from the security master via coalesce, so funds and ETFs carry a name here for
 * the same reason they do on the Dividend Calendar — screener_stocks.company is filings-derived and
 * null for anything that files neither a Form 4 nor an 8-K.
 */
export async function heatmapUniverse(limit = 500) {
  const lim = Math.max(10, Math.min(6000, Number(limit) || 500));
  // ASSET TYPE IS THE ELIGIBILITY RULE, and it is existing reference data rather than a maintained
  // exclusion list — see TRADEABLE_ASSET_TYPES for why funds, warrants and units are not operating
  // companies. `market_cap > 0` does the rest: every mutual-fund share class carries none.
  const types = sql`${`{${TRADEABLE_ASSET_TYPES.join(',')}}`}::text[]`;
  const res = await db.execute(sql`
    select s.ticker,
           coalesce(s.company, i.name) as company,
           coalesce(s.sector, m.sector) as sector,
           coalesce(s.market_cap, m.market_cap) as market_cap
      from screener_stocks s
      left join screener_meta     m on m.ticker = s.ticker
      left join security_identity i on i.ticker = s.ticker
     where coalesce(s.market_cap, m.market_cap) > 0
       and coalesce(m.asset_type, '') = any(${types})
     order by coalesce(s.market_cap, m.market_cap) desc
     limit ${lim}`);
  return (res.rows ?? res).map((r) => ({
    ticker: String(r.ticker),
    company: r.company || null,
    sector: r.sector || null,
    marketCap: Number(r.market_cap) || null,
  }));
}

/** A Postgres text[] literal for a ticker list — the driver will not interpolate a JS array here. */
const tickerArray = (tickers) =>
  sql`${`{${tickers.map((t) => `"${String(t).replace(/["\\]/g, '')}"`).join(',')}}`}::text[]`;

/**
 * The latest session at or before `onOrBefore` for each ticker, in one statement.
 *
 * `strictlyBefore` shifts the comparison to `<`, which is how 1D asks for "the session before the
 * latest one" without needing to know the trading calendar: across a weekend that lands on Friday,
 * across a holiday weekend on the Thursday, because the data carries the calendar.
 */
async function sessionPerTicker(tickers, onOrBefore, { strictlyBefore = false, floorDays = MAX_BASELINE_GAP_DAYS } = {}) {
  if (!tickers.length || !asDay(onOrBefore)) return new Map();
  const arr = tickerArray(tickers);
  const bound = strictlyBefore
    ? sql`date < ${onOrBefore}::date`
    : sql`date <= ${onOrBefore}::date`;
  // A LOWER BOUND ON THE SCAN, which is both the correctness rule and the performance win: a
  // baseline more than MAX_BASELINE_GAP_DAYS before its anchor is not the window it claims to be.
  // Without it, `distinct on` walks each ticker's history back through years of bars; with it the
  // whole eligible universe costs 317ms instead of 1,650ms.
  // The ::integer cast is load-bearing: an untyped parameter here makes Postgres resolve
  // `date - $n` as date-minus-date, which yields an integer and fails with
  // "operator does not exist: date >= integer".
  const floor = sql`date >= ${onOrBefore}::date - ${floorDays}::integer`;
  const res = await db.execute(sql`
    select distinct on (ticker) ticker, date::text as date, close, volume
      from ticker_daily_candles
     where ticker = any(${arr}) and ${bound} and ${floor}
     order by ticker, date desc`);
  const out = new Map();
  for (const r of (res.rows ?? res)) {
    out.set(String(r.ticker), { date: r.date, close: Number(r.close), volume: Number(r.volume) });
  }
  return out;
}

/**
 * Every security's close and volume ON the latest session, in one statement.
 *
 * `date = asOf` rather than `distinct on … date <= asOf`, which is SIX TIMES faster across the
 * eligible universe (337ms against 2,033ms) because it reads one date's rows instead of walking
 * every ticker's history backwards.
 *
 * It is also the more honest question. A security with no print on the latest session has no current
 * price, and the previous version would have handed back a stale close to be displayed as today's —
 * the exact failure the heatmap audit recorded. Those rows now arrive with no price and are reported
 * as unmeasurable rather than shown with an old one.
 */
async function latestSession(tickers, asOfDay) {
  if (!tickers.length || !asDay(asOfDay)) return new Map();
  const res = await db.execute(sql`
    select ticker, date::text as date, close, volume
      from ticker_daily_candles
     where date = ${asOfDay}::date and ticker = any(${tickerArray(tickers)})`);
  const out = new Map();
  for (const r of (res.rows ?? res)) {
    out.set(String(r.ticker), { date: r.date, close: Number(r.close), volume: Number(r.volume) });
  }
  return out;
}

/** Continuity verdicts, so a return spanning a reused symbol or an unadjusted split is withheld. */
async function qualityFor(tickers) {
  if (!tickers.length) return new Map();
  const res = await db.execute(sql`
    select ticker, usable, reason, last_break::text as last_break
      from ticker_price_quality where ticker = any(${tickerArray(tickers)})`);
  const out = new Map();
  for (const r of (res.rows ?? res)) {
    out.set(String(r.ticker), { usable: r.usable, reason: r.reason, lastBreak: r.last_break });
  }
  return out;
}

/**
 * The whole board for one timeframe.
 *
 * Returns { asOf, baselineDate, rows: [{ ticker, company, sector, marketCap, price, pct, volume,
 * latestDate, baselineDate, reason }] }. A row whose return could not be measured keeps its tile —
 * sized by market cap, coloured as unknown — with a `reason`, rather than dropping out of the board
 * and silently changing what the market looks like.
 */
export async function heatmapBoard({ timeframe = '1D', limit = 150 } = {}) {
  const asOf = await latestSessionDate();
  if (!asOf) return { asOf: null, baselineDate: null, rows: [] };

  const universe = await heatmapUniverse(limit);
  const tickers = universe.map((u) => u.ticker);
  if (!tickers.length) return { asOf, baselineDate: null, rows: [] };

  // The anchor for everything except 1D, which is expressed as "strictly before the latest session".
  const anchor = anchorDateFor(timeframe, asOf);

  const [latest, baseline, quality] = await Promise.all([
    latestSession(tickers, asOf),
    timeframe === '1D'
      ? sessionPerTicker(tickers, asOf, { strictlyBefore: true, floorDays: 10 })
      : sessionPerTicker(tickers, anchor),
    qualityFor(tickers),
  ]);

  const rows = universe.map((u) => {
    const l = latest.get(u.ticker);
    const b = baseline.get(u.ticker);
    const row = {
      ...u,
      price: l?.close ?? null,
      volume: l?.volume ?? null,
      latestDate: l?.date ?? null,
      baselineDate: b?.date ?? null,
      pct: null,
      reason: null,
    };
    if (!l) { row.reason = NO_RETURN.NO_PRICE; return row; }
    // A baseline that is the latest session itself means the security has no history reaching back
    // that far — a recent listing. 0% would be a fabrication, so it is reported as missing history.
    if (!b || b.date >= l.date) { row.reason = NO_RETURN.NO_HISTORY; return row; }
    if (returnBlocked(quality.get(u.ticker) ?? null, b.date)) { row.reason = NO_RETURN.SERIES_BREAK; return row; }
    const pct = pctReturn(l.close, b.close);
    if (pct === null) { row.reason = NO_RETURN.NO_PRICE; return row; }
    row.pct = pct;
    return row;
  });

  // The board's baseline date is the one most securities share — the market's session, not any one
  // name's. Reported so the UI can state exactly what the percentages are measured from.
  const counts = new Map();
  for (const r of rows) if (r.baselineDate) counts.set(r.baselineDate, (counts.get(r.baselineDate) || 0) + 1);
  const baselineDate = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] ?? null;

  return { asOf, baselineDate, anchorDate: anchor, rows };
}

/**
 * The board, trimmed for the wire.
 *
 * The full eligible universe is 5,553 rows, and sent verbatim that is 1.24MB — mostly float noise
 * (a return carried to fifteen decimal places) and per-row dates that are the same on almost every
 * row. Nothing is lost that the page displays: returns render to two decimals, prices to two, and
 * the board already reports its own `asOf` and `baselineDate`.
 *
 * A row's OWN dates are kept only when they differ from the board's, which is exactly the case a
 * reader needs to see — a security whose baseline fell on a different session than the market's.
 */
export function compactRows(rows, { asOf, baselineDate } = {}) {
  const round = (v, dp) => (v == null || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(dp)));
  return (rows || []).map((r) => {
    const out = {
      ticker: r.ticker,
      company: r.company ?? null,
      sector: r.sector ?? null,
      marketCap: r.marketCap == null ? null : Math.round(r.marketCap),
      price: round(r.price, 2),
      pct: round(r.pct, 2),
      volume: r.volume == null ? null : Math.round(r.volume),
    };
    if (r.reason) out.reason = r.reason;
    if (r.latestDate && r.latestDate !== asOf) out.latestDate = r.latestDate;
    if (r.baselineDate && r.baselineDate !== baselineDate) out.baselineDate = r.baselineDate;
    return out;
  });
}
