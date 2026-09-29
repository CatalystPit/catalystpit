// COMPUTE AND READ THE MARKET-BREADTH SNAPSHOT.
//
// ⚠️ THE MARKET IS MEASURED ONCE, NOT ONCE PER VISITOR. The aggregate walks the last 52 weeks of every
// eligible security — a few hundred thousand candle rows — and writes ONE row. A homepage request reads
// that row by primary key. Doing the walk per request would put a market-wide scan on the critical path
// of every page load, which is the specific failure the brief rules out.
//
// No provider is called from here either. The only input is ticker_daily_candles, which the existing
// ingest already maintains.
import { neon } from '@neondatabase/serverless';
import {
  WEEKS_52_DAYS, SMA_SHORT, SMA_LONG, UNIVERSE_ASSET_TYPE, UNIVERSE_EXCHANGES, buildBreadthPayload,
} from './market-breadth.mjs';

let client = null;
const conn = () => (client ||= neon(process.env.DATABASE_URL));

export async function ensureBreadthTable() {
  await conn()`
    CREATE TABLE IF NOT EXISTS market_breadth (
      id             integer PRIMARY KEY DEFAULT 1,
      as_of_session  date NOT NULL,
      computed_at    timestamptz NOT NULL DEFAULT now(),
      universe       integer NOT NULL,
      adv            integer NOT NULL, decl integer NOT NULL, unch integer NOT NULL,
      adv_eligible   integer NOT NULL,
      new_high       integer NOT NULL, new_low integer NOT NULL, hl_eligible integer NOT NULL,
      -- ⚠️ WHY SECURITIES WERE LEFT OUT, recorded rather than inferred. A snapshot that cannot say how
      -- many of its universe did not trade cannot be told apart from one where everything traded flat.
      not_trading    integer NOT NULL DEFAULT 0,
      no_prior_close integer NOT NULL DEFAULT 0,
      prior_session  date,
      above_sma50    integer NOT NULL, below_sma50 integer NOT NULL, at_sma50 integer NOT NULL,
      sma50_eligible integer NOT NULL,
      above_sma200   integer NOT NULL, below_sma200 integer NOT NULL, at_sma200 integer NOT NULL,
      sma200_eligible integer NOT NULL,
      -- A single row, rewritten each run. History is not a requirement here and one row keeps the read
      -- a primary-key lookup.
      CONSTRAINT market_breadth_single CHECK (id = 1)
    )`;
}

/**
 * Recompute the snapshot from stored daily candles.
 *
 * ⚠️ ONE STATEMENT, AND THE WINDOW IS PER TICKER. Each security's own latest session is its reference
 * point, so a name that did not trade on the market's last session is measured against ITS last close
 * and its own previous close — not silently compared across a gap, and not dropped for being quiet.
 */
export async function computeMarketBreadth() {
  await ensureBreadthTable();
  const t0 = Date.now();
  const sql = conn();

  // ⚠️ THE WHOLE SNAPSHOT IS PINNED TO ONE MARKET SESSION, and it was not before.
  //
  // The first version anchored every window to each TICKER'S OWN latest candle. On the live corpus 192
  // of 5,336 eligible securities had not traded on the market's latest session — a delisting, a halt, a
  // thin OTC-adjacent name — and each was still classified: its "advance or decline" compared two older
  // sessions, its moving averages were as of whatever day it last printed, and all of it was folded into
  // a card headed "CLOSE 2026-09-28". That is a mixed-session reading presented as one session, which is
  // the defect, independent of how much it moved the totals (it moved them little: those 192 split
  // 70 up / 71 down / 49 flat).
  //
  // Now the market's latest session is established FIRST, market-wide, and a security that did not print
  // that day is excluded from every metric and counted in not_trading. A snapshot that cannot say how
  // many of its universe failed to trade cannot be distinguished from one where everything traded flat.
  const [sessions] = await sql`
    WITH s AS (SELECT DISTINCT date FROM ticker_daily_candles ORDER BY date DESC LIMIT 2)
    SELECT max(date)::text AS s1, min(date)::text AS s2 FROM s`;
  if (!sessions?.s1 || !sessions?.s2) return { ok: false, reason: 'no-sessions', ms: Date.now() - t0 };

  const [row] = await sql`
    WITH universe AS (
      SELECT ticker FROM screener_stocks
       WHERE asset_type = ${UNIVERSE_ASSET_TYPE}
         AND exchange = ANY(${UNIVERSE_EXCHANGES})
    ),
    -- Every usable close for the universe, newest first, but only up to the market session: a candle
    -- dated after it cannot inform a reading as of it.
    ranked AS (
      SELECT c.ticker, c.date, c.close,
             row_number() OVER (PARTITION BY c.ticker ORDER BY c.date DESC) AS rn,
             min(c.date) OVER (PARTITION BY c.ticker) AS first_date
        FROM ticker_daily_candles c
        JOIN universe u ON u.ticker = c.ticker
       WHERE c.close > 0 AND c.date <= ${sessions.s1}::date
    ),
    -- ⚠️ THE 52-WEEK WINDOW ENDS AT THE MARKET SESSION, not at the ticker's own last print. A date range
    -- rather than a session count, because a session count drifts with holidays and halts.
    win AS (
      SELECT * FROM ranked WHERE date > ${sessions.s1}::date - ${WEEKS_52_DAYS}::int
    ),
    per_ticker AS (
      SELECT ticker,
             min(first_date) AS first_date,
             -- Did it print on the market session, and on the one before it? These are the eligibility
             -- facts the first version never asked.
             bool_or(date = ${sessions.s1}::date) AS on_session,
             bool_or(date = ${sessions.s2}::date) AS on_prior_session,
             max(close) FILTER (WHERE date = ${sessions.s1}::date) AS last_close,
             -- ⚠️ THE PRIOR SESSION'S CLOSE, NOT "THE NEXT ROW DOWN". 58 securities' second-newest candle
             -- is not the immediately preceding session, so the old rn=2 compared across a gap of days
             -- or weeks and called the result a daily advance.
             max(close) FILTER (WHERE date = ${sessions.s2}::date) AS prev_close,
             max(close) AS hi_52w,
             min(close) AS lo_52w,
             avg(close) FILTER (WHERE rn <= ${SMA_SHORT}) AS sma_short,
             count(*)   FILTER (WHERE rn <= ${SMA_SHORT}) AS n_short,
             avg(close) FILTER (WHERE rn <= ${SMA_LONG})  AS sma_long,
             count(*)   FILTER (WHERE rn <= ${SMA_LONG})  AS n_long
        FROM win GROUP BY ticker
    ),
    flags AS (
      SELECT p.*,
             -- Every metric requires the security to have printed on the market session. Beyond that,
             -- each requires exactly the input it needs and nothing more.
             (p.on_session AND p.on_prior_session
                AND p.last_close IS NOT NULL AND p.prev_close IS NOT NULL)          AS ok_adv,
             (p.on_session AND p.first_date <= ${sessions.s1}::date - ${WEEKS_52_DAYS}::int) AS ok_hl,
             (p.on_session AND p.n_short >= ${SMA_SHORT} AND p.sma_short IS NOT NULL) AS ok_s50,
             (p.on_session AND p.n_long  >= ${SMA_LONG}  AND p.sma_long  IS NOT NULL) AS ok_s200
        FROM per_ticker p
    )
    SELECT
      (SELECT count(*)::int FROM universe) AS universe,
      ${sessions.s1}::text                 AS as_of_session,
      ${sessions.s2}::text                 AS prior_session,
      -- ⚠️ PUBLISHED, NOT INFERRED: how much of the universe this snapshot could not measure, and why.
      -- ⚠️ COUNTED AGAINST THE UNIVERSE, NOT AGAINST THE ROWS WE HAPPEN TO HAVE. The flags CTE descends
      -- from the candle table, so a universe member with no usable close inside the window never reaches
      -- it and a FILTER here would silently omit it: CRD.B and TAP.A have no candles at all, OST's last
      -- print is 2025-09-12. Subtracting from the universe keeps
      -- universe = not_trading + measured true by construction, so unmeasured coverage cannot hide.
      ((SELECT count(*) FROM universe) - count(*) FILTER (WHERE on_session))::int   AS not_trading,
      count(*) FILTER (WHERE on_session AND NOT on_prior_session)::int              AS no_prior_close,
      count(*) FILTER (WHERE ok_adv)::int                                           AS adv_eligible,
      count(*) FILTER (WHERE ok_adv AND last_close > prev_close)::int               AS adv,
      count(*) FILTER (WHERE ok_adv AND last_close < prev_close)::int               AS decl,
      count(*) FILTER (WHERE ok_adv AND last_close = prev_close)::int               AS unch,
      count(*) FILTER (WHERE ok_hl)::int                                            AS hl_eligible,
      count(*) FILTER (WHERE ok_hl AND last_close = hi_52w)::int                    AS new_high,
      count(*) FILTER (WHERE ok_hl AND last_close = lo_52w)::int                     AS new_low,
      count(*) FILTER (WHERE ok_s50)::int                                           AS sma50_eligible,
      count(*) FILTER (WHERE ok_s50 AND last_close > sma_short)::int                AS above_sma50,
      count(*) FILTER (WHERE ok_s50 AND last_close < sma_short)::int                AS below_sma50,
      count(*) FILTER (WHERE ok_s50 AND last_close = sma_short)::int                AS at_sma50,
      count(*) FILTER (WHERE ok_s200)::int                                          AS sma200_eligible,
      count(*) FILTER (WHERE ok_s200 AND last_close > sma_long)::int                AS above_sma200,
      count(*) FILTER (WHERE ok_s200 AND last_close < sma_long)::int                AS below_sma200,
      count(*) FILTER (WHERE ok_s200 AND last_close = sma_long)::int                AS at_sma200
    FROM flags`;

  if (!row || !row.as_of_session) return { ok: false, reason: 'no-candles', ms: Date.now() - t0 };

  await sql`
    INSERT INTO market_breadth (id, as_of_session, prior_session, computed_at, universe,
      not_trading, no_prior_close,
      adv, decl, unch, adv_eligible, new_high, new_low, hl_eligible,
      above_sma50, below_sma50, at_sma50, sma50_eligible,
      above_sma200, below_sma200, at_sma200, sma200_eligible)
    VALUES (1, ${row.as_of_session}::date, ${row.prior_session}::date, now(), ${row.universe},
      ${row.not_trading}, ${row.no_prior_close},
      ${row.adv}, ${row.decl}, ${row.unch}, ${row.adv_eligible},
      ${row.new_high}, ${row.new_low}, ${row.hl_eligible},
      ${row.above_sma50}, ${row.below_sma50}, ${row.at_sma50}, ${row.sma50_eligible},
      ${row.above_sma200}, ${row.below_sma200}, ${row.at_sma200}, ${row.sma200_eligible})
    ON CONFLICT (id) DO UPDATE SET
      as_of_session = excluded.as_of_session, prior_session = excluded.prior_session,
      computed_at = excluded.computed_at, universe = excluded.universe,
      not_trading = excluded.not_trading, no_prior_close = excluded.no_prior_close,
      adv = excluded.adv, decl = excluded.decl, unch = excluded.unch, adv_eligible = excluded.adv_eligible,
      new_high = excluded.new_high, new_low = excluded.new_low, hl_eligible = excluded.hl_eligible,
      above_sma50 = excluded.above_sma50, below_sma50 = excluded.below_sma50,
      at_sma50 = excluded.at_sma50, sma50_eligible = excluded.sma50_eligible,
      above_sma200 = excluded.above_sma200, below_sma200 = excluded.below_sma200,
      at_sma200 = excluded.at_sma200, sma200_eligible = excluded.sma200_eligible`;

  return { ok: true, ...row, ms: Date.now() - t0 };
}

/** The stored snapshot as the API payload, or null when there is none. */
export async function readMarketBreadth() {
  try {
    // ⚠️ NO DDL ON THE READ PATH. This used to call ensureBreadthTable, so every homepage load carried
    // a CREATE TABLE IF NOT EXISTS — and worse, the route was briefly build-time generated, which put
    // that statement in the deploy. The cron owns the schema; a missing table simply lands in the catch
    // below and the card renders "unavailable", which is the honest answer before the first run.
    const [row] = await conn()`
      SELECT universe, as_of_session::text AS as_of_session, prior_session::text AS prior_session,
             not_trading, no_prior_close,
             to_char(computed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS computed_at,
             adv, decl, unch, adv_eligible, new_high, new_low, hl_eligible,
             above_sma50, below_sma50, at_sma50, sma50_eligible,
             above_sma200, below_sma200, at_sma200, sma200_eligible
        FROM market_breadth WHERE id = 1`;
    return buildBreadthPayload(row);
  } catch (err) {
    // A breadth card is not worth failing a page for. The UI renders "unavailable" on null.
    console.error('[market-breadth] read failed', err?.message || err);
    return null;
  }
}
