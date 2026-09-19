// CAPTURING POINT-IN-TIME FUNDAMENTALS.
//
// `screener_stocks` is rebuilt by DELETE-then-INSERT every night, so it holds exactly one historical
// observation: the present. Valuation, margins, growth and market cap therefore have no past to
// research, and nobody sells us ours back — every uncaptured day is permanently lost.
//
// This writes one immutable row per ticker per trading day. It is DATA COLLECTION, not a feature:
// nothing reads it, no API exposes it, no score consumes it, and the research harness under
// research/ is its only eventual consumer.
//
// ── THE FOUR RULES ────────────────────────────────────────────────────────────
//
//   NULL STAYS NULL. A value we did not have that day is stored as null, never as zero and never
//   carried forward from yesterday. Forward-filling would make a gap in coverage indistinguishable
//   from a fact, which is the failure mode that quietly ruins a research dataset.
//
//   IDEMPOTENT. Re-running a capture for the same day REPLACES the row. A cron that retries, a
//   manual re-run and a double-fire all converge on one row per ticker per day.
//
//   NO BACKFILL. There is no path here that writes a past date from present values. Today is day one
//   of the series and the table says so.
//
//   CAPTURE IS SEPARATE FROM as_of. `captured_at` records when we actually wrote it, so a late or
//   re-run capture is visible as such rather than presented as having happened on the day.

import { sql } from 'drizzle-orm';
import { db } from './db';

/**
 * THE CAPTURED COLUMNS, and why this list is short.
 *
 * Everything recomputable from data we already keep permanently is excluded — see the migration for
 * the full reasoning. In brief: price and technicals come back from `ticker_daily_candles`;
 * proprietary signals come back from their own source tables WITH their own information dates, and
 * capturing them would freeze today's definitions (bugs included) into the historical record.
 */
export const SNAPSHOT_COLUMNS = Object.freeze([
  'company', 'sector', 'industry', 'exchange', 'country', 'asset_type', 'ipo_date',
  'market_cap', 'shares_out', 'float_shares',
  'eps_ttm', 'revenue_ttm', 'equity', 'total_debt', 'cash', 'ebitda',
  'pe', 'ps', 'pb', 'ev_sales', 'ev_ebitda', 'dividend_yield', 'payout_ratio',
  'roe', 'roa', 'roic', 'gross_margin', 'oper_margin', 'net_margin',
  'debt_equity', 'lt_debt_equity', 'current_ratio', 'quick_ratio',
  'eps_growth_ttm', 'rev_growth_ttm', 'eps_growth_qoq', 'sales_growth_qoq',
  'eps_growth_3y', 'sales_growth_3y', 'eps_growth_5y', 'sales_growth_5y', 'eps_growth_this_yr',
  'inst_own_pct', 'short_float',
]);

/**
 * ELIGIBILITY: a row is worth a day's storage only if it carries something.
 *
 * Roughly 12,000 of the 17,728 screener rows have no market cap and no fundamentals at all — storing
 * them daily would be a quarter of a million empty rows a month. A ticker must have at least a
 * market capitalisation or an earnings figure to be captured.
 *
 * This is a STORAGE rule, not a data rule: a captured row still keeps every null it has. It only
 * decides whether the row is written at all, and it is stated here rather than buried in SQL.
 */
const ELIGIBLE = sql`(s.market_cap is not null or f.eps_ttm is not null or f.revenue_ttm is not null)`;

/**
 * CHANGE-ONLY WRITES — the reason this table is ~20MB a year instead of ~550MB.
 *
 * Measured on the first full capture: 6,439 eligible tickers, 2.2MB a day. Fundamentals update
 * QUARTERLY, so all but a handful of those rows would be byte-identical to yesterday's. A row is
 * therefore written only when the payload actually differs from that ticker's most recent one.
 *
 * `fundamentalsAsOf()` reads "the latest row at or before this date", so a sparse series is read
 * exactly like a dense one and the point-in-time guarantee is untouched.
 *
 * MARKET CAP IS EXCLUDED FROM THE TEST, deliberately. It moves every day with price, so including it
 * would force a daily write for every ticker and defeat the whole saving — and it is recoverable
 * anyway as shares_out × close from the candle history we keep permanently. `shares_out` IS in the
 * test, because that is the part a price cannot reconstruct.
 *
 * `is distinct from` rather than `<>`, because a value going null or arriving from null is a change
 * and `null <> null` is null, which would silently drop exactly those transitions.
 */
const CHANGED = sql`(p.ticker is null or ${sql.join([
  sql`p.company is distinct from coalesce(s.company, i.name)`,
  sql`p.sector is distinct from coalesce(s.sector, m.sector)`,
  sql`p.industry is distinct from coalesce(s.industry, m.industry)`,
  sql`p.exchange is distinct from coalesce(s.exchange, m.exchange)`,
  sql`p.country is distinct from coalesce(s.country, m.country)`,
  sql`p.asset_type is distinct from coalesce(s.asset_type, m.asset_type)`,
  sql`p.shares_out is distinct from coalesce(s.shares_out, m.shares_out)`,
  sql`p.float_shares is distinct from s.float_shares`,
  sql`p.eps_ttm is distinct from f.eps_ttm`,
  sql`p.revenue_ttm is distinct from f.revenue_ttm`,
  sql`p.equity is distinct from f.equity`,
  sql`p.total_debt is distinct from f.total_debt`,
  sql`p.cash is distinct from f.cash`,
  sql`p.ebitda is distinct from f.ebitda`,
  sql`p.pe is distinct from s.pe`,
  sql`p.ps is distinct from s.ps`,
  sql`p.pb is distinct from s.pb`,
  sql`p.ev_sales is distinct from s.ev_sales`,
  sql`p.ev_ebitda is distinct from s.ev_ebitda`,
  sql`p.dividend_yield is distinct from s.dividend_yield`,
  sql`p.payout_ratio is distinct from s.payout_ratio`,
  sql`p.roe is distinct from s.roe`,
  sql`p.roa is distinct from s.roa`,
  sql`p.roic is distinct from s.roic`,
  sql`p.gross_margin is distinct from s.gross_margin`,
  sql`p.oper_margin is distinct from s.oper_margin`,
  sql`p.net_margin is distinct from s.net_margin`,
  sql`p.debt_equity is distinct from s.debt_equity`,
  sql`p.lt_debt_equity is distinct from s.lt_debt_equity`,
  sql`p.current_ratio is distinct from s.current_ratio`,
  sql`p.quick_ratio is distinct from s.quick_ratio`,
  sql`p.eps_growth_ttm is distinct from s.eps_growth_ttm`,
  sql`p.rev_growth_ttm is distinct from s.rev_growth_ttm`,
  sql`p.eps_growth_qoq is distinct from s.eps_growth_qoq`,
  sql`p.sales_growth_qoq is distinct from s.sales_growth_qoq`,
  sql`p.eps_growth_3y is distinct from s.eps_growth_3y`,
  sql`p.sales_growth_3y is distinct from s.sales_growth_3y`,
  sql`p.eps_growth_5y is distinct from s.eps_growth_5y`,
  sql`p.sales_growth_5y is distinct from s.sales_growth_5y`,
  sql`p.eps_growth_this_yr is distinct from s.eps_growth_this_yr`,
  sql`p.inst_own_pct is distinct from s.inst_own_pct`,
  sql`p.short_float is distinct from s.short_float`,
], sql` or `)})`;

/**
 * Capture one day.
 *
 * `asOf` is the trading day the observation describes and defaults to today in ET, because the
 * screener rebuild runs pre-market and describes the session that just settled.
 *
 * Written as ONE `insert ... select` rather than a read-then-write loop: the source rows never leave
 * the database, so a 6,000-row capture is a single statement rather than 6,000 round trips.
 */
export async function captureFundamentalSnapshot({ asOf = null, source = 'screener_rebuild' } = {}) {
  const startedAt = Date.now();
  const day = asOf || etToday();

  const res = await db.execute(sql`
    insert into security_fundamental_snapshot (
      ticker, as_of, captured_at, source,
      company, sector, industry, exchange, country, asset_type, ipo_date,
      market_cap, shares_out, float_shares,
      eps_ttm, revenue_ttm, equity, total_debt, cash, ebitda,
      pe, ps, pb, ev_sales, ev_ebitda, dividend_yield, payout_ratio,
      roe, roa, roic, gross_margin, oper_margin, net_margin,
      debt_equity, lt_debt_equity, current_ratio, quick_ratio,
      eps_growth_ttm, rev_growth_ttm, eps_growth_qoq, sales_growth_qoq,
      eps_growth_3y, sales_growth_3y, eps_growth_5y, sales_growth_5y, eps_growth_this_yr,
      inst_own_pct, short_float)
    select
      s.ticker, ${day}::date, now(), ${source},
      -- Identity prefers the security master, which resolves funds and ETFs the filings-derived
      -- company column cannot name. Classification falls back to screener_meta the same way the
      -- rest of the product does, so the snapshot matches what was actually being shown.
      coalesce(s.company, i.name), coalesce(s.sector, m.sector), coalesce(s.industry, m.industry),
      coalesce(s.exchange, m.exchange), coalesce(s.country, m.country),
      coalesce(s.asset_type, m.asset_type), coalesce(s.ipo_date, m.ipo_date),
      coalesce(s.market_cap, m.market_cap), coalesce(s.shares_out, m.shares_out), s.float_shares,
      f.eps_ttm, f.revenue_ttm, f.equity, f.total_debt, f.cash, f.ebitda,
      s.pe, s.ps, s.pb, s.ev_sales, s.ev_ebitda, s.dividend_yield, s.payout_ratio,
      s.roe, s.roa, s.roic, s.gross_margin, s.oper_margin, s.net_margin,
      s.debt_equity, s.lt_debt_equity, s.current_ratio, s.quick_ratio,
      s.eps_growth_ttm, s.rev_growth_ttm, s.eps_growth_qoq, s.sales_growth_qoq,
      s.eps_growth_3y, s.sales_growth_3y, s.eps_growth_5y, s.sales_growth_5y, s.eps_growth_this_yr,
      s.inst_own_pct, s.short_float
      from screener_stocks s
      left join screener_meta         m on m.ticker = s.ticker
      left join screener_fundamentals f on f.ticker = s.ticker
      left join security_identity     i on i.ticker = s.ticker
      -- That ticker's most recent stored observation, for the change test below.
      left join lateral (
        select * from security_fundamental_snapshot p
         where p.ticker = s.ticker and p.as_of < ${day}::date
         order by p.as_of desc limit 1
      ) p on true
     where ${ELIGIBLE} and ${CHANGED}
    -- IDEMPOTENT. A re-run replaces the day's row rather than failing or duplicating, and
    -- captured_at moves so a re-capture is visible as one.
    on conflict (ticker, as_of) do update set
      captured_at = now(), source = excluded.source,
      company = excluded.company, sector = excluded.sector, industry = excluded.industry,
      exchange = excluded.exchange, country = excluded.country, asset_type = excluded.asset_type,
      ipo_date = excluded.ipo_date,
      market_cap = excluded.market_cap, shares_out = excluded.shares_out, float_shares = excluded.float_shares,
      eps_ttm = excluded.eps_ttm, revenue_ttm = excluded.revenue_ttm, equity = excluded.equity,
      total_debt = excluded.total_debt, cash = excluded.cash, ebitda = excluded.ebitda,
      pe = excluded.pe, ps = excluded.ps, pb = excluded.pb, ev_sales = excluded.ev_sales,
      ev_ebitda = excluded.ev_ebitda, dividend_yield = excluded.dividend_yield, payout_ratio = excluded.payout_ratio,
      roe = excluded.roe, roa = excluded.roa, roic = excluded.roic,
      gross_margin = excluded.gross_margin, oper_margin = excluded.oper_margin, net_margin = excluded.net_margin,
      debt_equity = excluded.debt_equity, lt_debt_equity = excluded.lt_debt_equity,
      current_ratio = excluded.current_ratio, quick_ratio = excluded.quick_ratio,
      eps_growth_ttm = excluded.eps_growth_ttm, rev_growth_ttm = excluded.rev_growth_ttm,
      eps_growth_qoq = excluded.eps_growth_qoq, sales_growth_qoq = excluded.sales_growth_qoq,
      eps_growth_3y = excluded.eps_growth_3y, sales_growth_3y = excluded.sales_growth_3y,
      eps_growth_5y = excluded.eps_growth_5y, sales_growth_5y = excluded.sales_growth_5y,
      eps_growth_this_yr = excluded.eps_growth_this_yr,
      inst_own_pct = excluded.inst_own_pct, short_float = excluded.short_float`);

  const written = res?.rowCount ?? res?.rows?.length ?? null;

  // THE RUN LOG. With change-only writes, "nothing changed today" and "the job never ran" would
  // otherwise be the same absence of rows. This is how coverage is audited rather than inferred.
  const considered = await eligibleCount();
  await db.execute(sql`
    insert into security_snapshot_run (as_of, captured_at, considered, written, source)
    values (${day}::date, now(), ${considered}, ${written ?? 0}, ${source})
    // A re-run REPLACES the day's counts rather than accumulating them: the log answers "what did
    // the last capture for this day do", not "how many times was it retried".
    on conflict (as_of) do update set
      captured_at = now(), considered = excluded.considered,
      written = excluded.written, source = excluded.source`);

  return { ok: true, asOf: day, considered, written, ms: Date.now() - startedAt };
}

/** How many tickers were eligible for capture — the denominator the run log records. */
async function eligibleCount() {
  const res = await db.execute(sql`
    select count(*)::int n from screener_stocks s
      left join screener_fundamentals f on f.ticker = s.ticker
     where ${ELIGIBLE}`);
  return Number((res.rows ?? res)[0]?.n) || 0;
}

/** Today's date in ET, which is the calendar the market trades on. */
function etToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** How the series is growing — for the storage question, answered with measurement. */
export async function snapshotCoverage() {
  const res = await db.execute(sql`
    select count(*)::int rows, count(distinct ticker)::int tickers, count(distinct as_of)::int days,
           min(as_of)::text first_day, max(as_of)::text last_day,
           pg_size_pretty(pg_total_relation_size('security_fundamental_snapshot')) size
      from security_fundamental_snapshot`);
  return (res.rows ?? res)[0] || null;
}

/**
 * THE RESEARCH READ: what we knew about a ticker on a given day.
 *
 * At or before, so a research date that falls on a weekend resolves to the last capture — and never
 * forward, which is the property that makes this table safe to join against outcomes.
 */
export async function fundamentalsAsOf(ticker, asOfDay) {
  const res = await db.execute(sql`
    select * from security_fundamental_snapshot
     where ticker = ${String(ticker).toUpperCase()} and as_of <= ${asOfDay}::date
     order by as_of desc limit 1`);
  return (res.rows ?? res)[0] || null;
}
