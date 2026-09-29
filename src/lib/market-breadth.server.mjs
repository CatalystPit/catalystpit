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

  const [row] = await sql`
    WITH universe AS (
      SELECT ticker FROM screener_stocks
       WHERE asset_type = ${UNIVERSE_ASSET_TYPE}
         AND exchange = ANY(${UNIVERSE_EXCHANGES})
    ),
    -- Per ticker, its own most recent session first. close > 0 drops rows that carry no usable price;
    -- a zero close is absence, not a price of nothing.
    ranked AS (
      SELECT c.ticker, c.date, c.close,
             row_number() OVER (PARTITION BY c.ticker ORDER BY c.date DESC) AS rn,
             max(c.date) OVER (PARTITION BY c.ticker) AS latest_date,
             min(c.date) OVER (PARTITION BY c.ticker) AS first_date
        FROM ticker_daily_candles c
        JOIN universe u ON u.ticker = c.ticker
       WHERE c.close > 0
    ),
    -- ⚠️ THE 52-WEEK WINDOW IS A DATE RANGE, INCLUSIVE OF THE LATEST SESSION. A session count would
    -- drift with holidays and halts; 364 days is what "52 weeks" means.
    win AS (
      SELECT * FROM ranked WHERE date > latest_date - ${WEEKS_52_DAYS}::int
    ),
    per_ticker AS (
      SELECT ticker,
             max(latest_date) AS latest_date,
             min(first_date)  AS first_date,
             -- The two most recent closes. rn is over the WHOLE history, so rn=2 is the true previous
             -- session even when the 52-week window starts later.
             max(close) FILTER (WHERE rn = 1) AS last_close,
             max(close) FILTER (WHERE rn = 2) AS prev_close,
             -- Closing-basis 52-week extremes over the inclusive window.
             max(close) AS hi_52w,
             min(close) AS lo_52w,
             -- Averages over the most recent N sessions, with the count so insufficient history is
             -- excluded rather than averaged over whatever exists.
             avg(close) FILTER (WHERE rn <= ${SMA_SHORT}) AS sma_short,
             count(*)   FILTER (WHERE rn <= ${SMA_SHORT}) AS n_short,
             avg(close) FILTER (WHERE rn <= ${SMA_LONG})  AS sma_long,
             count(*)   FILTER (WHERE rn <= ${SMA_LONG})  AS n_long
        FROM win GROUP BY ticker
    ),
    flags AS (
      SELECT p.*,
             -- ⚠️ EACH ELIGIBILITY TEST IS THE INPUT THAT METRIC NEEDS, nothing more and nothing less.
             (p.last_close IS NOT NULL AND p.prev_close IS NOT NULL)                       AS ok_adv,
             -- A full 52 weeks of history, or the extreme is not a 52-week extreme.
             (p.first_date <= p.latest_date - ${WEEKS_52_DAYS}::int)                        AS ok_hl,
             (p.n_short >= ${SMA_SHORT} AND p.sma_short IS NOT NULL)                        AS ok_s50,
             (p.n_long  >= ${SMA_LONG}  AND p.sma_long  IS NOT NULL)                        AS ok_s200
        FROM per_ticker p
    )
    SELECT
      (SELECT count(*)::int FROM universe) AS universe,
      max(latest_date)::text               AS as_of_session,
      count(*) FILTER (WHERE ok_adv)::int                                          AS adv_eligible,
      count(*) FILTER (WHERE ok_adv AND last_close > prev_close)::int              AS adv,
      count(*) FILTER (WHERE ok_adv AND last_close < prev_close)::int              AS decl,
      count(*) FILTER (WHERE ok_adv AND last_close = prev_close)::int              AS unch,
      count(*) FILTER (WHERE ok_hl)::int                                           AS hl_eligible,
      count(*) FILTER (WHERE ok_hl AND last_close = hi_52w)::int                   AS new_high,
      count(*) FILTER (WHERE ok_hl AND last_close = lo_52w)::int                   AS new_low,
      count(*) FILTER (WHERE ok_s50)::int                                          AS sma50_eligible,
      count(*) FILTER (WHERE ok_s50 AND last_close > sma_short)::int               AS above_sma50,
      count(*) FILTER (WHERE ok_s50 AND last_close < sma_short)::int               AS below_sma50,
      count(*) FILTER (WHERE ok_s50 AND last_close = sma_short)::int               AS at_sma50,
      count(*) FILTER (WHERE ok_s200)::int                                         AS sma200_eligible,
      count(*) FILTER (WHERE ok_s200 AND last_close > sma_long)::int               AS above_sma200,
      count(*) FILTER (WHERE ok_s200 AND last_close < sma_long)::int               AS below_sma200,
      count(*) FILTER (WHERE ok_s200 AND last_close = sma_long)::int               AS at_sma200
    FROM flags`;

  if (!row || !row.as_of_session) return { ok: false, reason: 'no-candles', ms: Date.now() - t0 };

  await sql`
    INSERT INTO market_breadth (id, as_of_session, computed_at, universe,
      adv, decl, unch, adv_eligible, new_high, new_low, hl_eligible,
      above_sma50, below_sma50, at_sma50, sma50_eligible,
      above_sma200, below_sma200, at_sma200, sma200_eligible)
    VALUES (1, ${row.as_of_session}::date, now(), ${row.universe},
      ${row.adv}, ${row.decl}, ${row.unch}, ${row.adv_eligible},
      ${row.new_high}, ${row.new_low}, ${row.hl_eligible},
      ${row.above_sma50}, ${row.below_sma50}, ${row.at_sma50}, ${row.sma50_eligible},
      ${row.above_sma200}, ${row.below_sma200}, ${row.at_sma200}, ${row.sma200_eligible})
    ON CONFLICT (id) DO UPDATE SET
      as_of_session = excluded.as_of_session, computed_at = excluded.computed_at,
      universe = excluded.universe,
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
    await ensureBreadthTable();
    const [row] = await conn()`
      SELECT universe, as_of_session::text AS as_of_session,
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
