// FEAR & GREED — the database half. Read-only, and it computes nothing it does not have to.
//
// Three queries supply every component. The panel query does its aggregation server-side because
// the alternative is shipping a million bars to Node to count how many closed above a moving
// average; the two price queries return raw closes because series.mjs owns that arithmetic.

import { sql } from 'drizzle-orm';
import { db } from '../db';

const rows = (res) => res?.rows ?? res ?? [];

/** The broad-market proxy. Our own licensed EOD bars, back to 1993. */
export const MARKET_SYMBOL = 'SPY';
/** High-yield corporate credit. */
export const CREDIT_RISK_SYMBOL = 'HYG';
/** 7-10 year Treasuries — the safe leg of the credit comparison. */
export const CREDIT_SAFE_SYMBOL = 'IEF';

/**
 * ⚠️ THE BREADTH PANEL IS FIXED COVERAGE, NOT "EVERY TICKER WE HOLD".
 *
 * Measured: the count of tickers with 252 sessions of history behind them jumps 195 -> 1,140 ->
 * 7,000 across three dates. Those steps are BACKFILL ARTIFACTS, not changes in the market. Ranking
 * today's breadth across 7,036 names against a distribution mostly built from 1,140 names compares
 * two different populations and calls the difference sentiment.
 *
 * So the panel is the set of tickers carrying enough history to be present for the WHOLE
 * normalisation window plus the 52-week lookback. Measured at 1,068 names — roughly S&P 1500 scale
 * — with the daily eligible count varying only 1,025-1,068 (4%) across the window, which is
 * ordinary reporting lag rather than a change of universe.
 */
export const PANEL_MIN_SESSIONS = 756;
/** A panel member has to still be trading; a delisted name must not sit in the denominator. */
export const PANEL_MAX_STALE_DAYS = 7;

/** Sessions of 52-week high/low lookback. */
export const HIGH_LOW_LOOKBACK = 252;
/** Sessions in the breadth moving average. */
export const BREADTH_MA = 50;

/**
 * Per-session breadth and net-new-highs across the stable panel.
 *
 * Both are RATIOS of the eligible count for that session, so the small day-to-day variation in
 * reporting does not move the measure.
 *
 * @returns {Promise<Array<{date,eligible,breadth,strength}>>} oldest first
 */
export async function loadPanelSeries(dbc = db, sqlc = sql, { sinceDays = 1500 } = {}) {
  const res = await dbc.execute(sqlc`
    with panel as (
      select ticker from ticker_daily_candles
       where close > 0
       group by ticker
      having count(*) >= ${PANEL_MIN_SESSIONS}
         and max(date) >= (current_date - make_interval(days => ${PANEL_MAX_STALE_DAYS}))),
    w as (
      select c.ticker, c.date, c.close,
             avg(c.close) over (partition by c.ticker order by c.date
                                rows between ${BREADTH_MA - 1} preceding and current row) sma,
             count(*)     over (partition by c.ticker order by c.date
                                rows between ${HIGH_LOW_LOOKBACK - 1} preceding and current row) n,
             max(c.close) over (partition by c.ticker order by c.date
                                rows between ${HIGH_LOW_LOOKBACK - 1} preceding and current row) hi,
             min(c.close) over (partition by c.ticker order by c.date
                                rows between ${HIGH_LOW_LOOKBACK - 1} preceding and current row) lo
        from ticker_daily_candles c
        join panel p on p.ticker = c.ticker
       where c.close > 0)
    select date::text as date,
           count(*)::int as eligible,
           avg(case when close > sma then 1.0 else 0.0 end)::float8 as breadth,
           ((count(*) filter (where close >= hi) - count(*) filter (where close <= lo))::float8
             / nullif(count(*), 0)) as strength
      from w
     where n >= ${HIGH_LOW_LOOKBACK}
       and date >= (current_date - make_interval(days => ${sinceDays}))
     group by date
     order by date`);
  return rows(res).map((r) => ({
    date: String(r.date),
    eligible: Number(r.eligible),
    breadth: Number(r.breadth),
    strength: Number(r.strength),
  }));
}

/** Daily closes for one symbol, oldest first. */
export async function loadCloses(dbc = db, sqlc = sql, symbol, { sinceDays = 1500 } = {}) {
  const res = await dbc.execute(sqlc`
    select date::text as date, close::float8 as close
      from ticker_daily_candles
     where ticker = ${String(symbol).toUpperCase()}
       and close > 0
       and date >= (current_date - make_interval(days => ${sinceDays}))
     order by date asc`);
  return rows(res).map((r) => ({ date: String(r.date), close: Number(r.close) }));
}

/** How many sessions of price history each component needs behind its first reported value. */
export const WARMUP_DAYS = 1500;
