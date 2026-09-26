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
/**
 * The safe leg of the credit comparison: 1-3 year Treasuries.
 *
 * ── ⚠️ WHY THIS IS SHY AND NOT IEF, WHICH IS WHAT IT USED TO BE ─────────────
 *
 * The component is called Credit Risk Appetite and it was not measuring credit. Against IEF
 * (7-10 year Treasuries), over 742 shared sessions:
 *
 *     corr(spread, IEF return) = -0.662  →  44% of the spread's variance was the TREASURY leg
 *     corr(spread, HYG return) = +0.153  →   2% was the CREDIT leg
 *
 * IEF's duration meant a rates move arrived as "credit appetite" whether or not credit had done
 * anything. The failure it produced is easy to state: on 67 of the 108 sessions where BOTH bond
 * ETFs fell — 62% of them — the component printed GREED, because Treasuries had fallen harder
 * than junk. 2026-09-25 was exactly that: HYG -2.52%, IEF -3.46%, component 71.7 GREED.
 *
 * Measured over the same history, against SHY:
 *
 *     corr(spread, HYG return) = +0.946  →  89% of the variance is the CREDIT leg
 *     corr(spread, SHY return) = +0.220  →   5% is the Treasury leg
 *     both legs down and the signal says GREED:  0 of 107.
 *
 * A short-duration control leg still asks the right question — is credit being paid for, relative
 * to government paper — while carrying almost none of the duration that was drowning the answer.
 *
 * ⚠️ SHY IS NOT A NEW DATA SOURCE. Same table, same licensed Tiingo EOD bars, same 762-session
 * coverage as HYG and IEF, loaded by the same loadCloses call. Nothing about ingestion changes.
 */
export const CREDIT_SAFE_SYMBOL = 'SHY';
/**
 * The volatility market, as a traded instrument. NOT the VIX — see volMarketSeries in series.mjs
 * and METHODOLOGY.excluded in model.mjs. Proprietary: this symbol appears in nothing the API
 * serves.
 */
export const VOL_MARKET_SYMBOL = 'UVXY';

/**
 * ⚠️ A LONGER LOAD FOR THE VOLATILITY MARKET, AND ONLY FOR IT.
 *
 * Every published score is ranked against a FULL 504-session window — MIN_WINDOW equals
 * NORM_WINDOW precisely so no point is ranked against a shorter history than any other. A component
 * therefore needs its moving-average warmup PLUS the whole window behind the first session it can
 * score, and this instrument's stored history begins later than SPY's.
 *
 * Measured against the store: loaded over the standard 1,500 days the first scoreable session is
 * 2024-10-29, which is 28 sessions AFTER the reporting calendar starts, so the component would be
 * absent from the opening month of the chart for no reason other than how much was fetched. Loaded
 * over its full stored history the first scoreable session is 2023-11-29 — comfortably before the
 * calendar — and every published session has it.
 *
 * This changes no arithmetic. It is how far back the query reaches, not how anything is computed:
 * the window a given session ranks against is still the 504 sessions ENDING at that session.
 */
export const VOL_MARKET_WARMUP_DAYS = 2600;

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
