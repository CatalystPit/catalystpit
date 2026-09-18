// THE 13F QUARTER-OVER-QUARTER SUMMARY, COMPUTED WHERE IT BELONGS.
//
// Pit Consensus needs one fact per ticker from the institutional data: how many funds grew their
// position last quarter, and how many shrank it. That fact is expensive to derive and almost never
// changes — 13F filings arrive on an ingest cron, not on a page view.
//
// Deriving it live means scanning both quarters of fund_holdings (3.09M rows), hash-aggregating into
// 1.74M (ticker, cik) pairs with ~145 MB spilling to disk, then collapsing to ~14.5k tickers: about
// six seconds in Postgres, eight by the time it reaches Node. Every visitor to the homepage, any
// ticker page, the Terminal or /consensus paid that whenever the cache happened to be cold.
//
// So it is computed once per ingest and stored in `fund_qoq`. THE ARITHMETIC IS UNCHANGED — this
// module runs the same grouping the board used to run inline, and writes the result down.

import { sql } from 'drizzle-orm';
import { db } from './db';

/**
 * The two most recent quarters that have filings, newest first.
 *
 * Read from fund_filings rather than fund_holdings: a fund that filed an empty or all-options
 * position still marks the quarter as reported, and it is cheap — fund_filings is 33k rows against
 * nine million.
 */
export async function latestQuarters() {
  const res = await db.execute(sql`
    select quarter from fund_filings group by quarter order by quarter desc limit 2`);
  const rows = res.rows ?? res;
  return rows.map((r) => (r.quarter instanceof Date ? r.quarter.toISOString().slice(0, 10) : String(r.quarter).slice(0, 10)));
}

/**
 * Recompute the summary for the current quarter pair and store it.
 *
 * ONE STATEMENT. The aggregation and the write happen in the database, so nine million rows never
 * cross the wire — which is the whole reason this is fast enough to run on a cron at all.
 *
 * `on conflict do update` makes it idempotent: running it twice is running it once, and a re-run
 * after a late-arriving filing corrects the row rather than duplicating it.
 */
export async function refreshFundQoq() {
  const startedAt = Date.now();
  const [q0, q1] = await latestQuarters();
  if (!q0) return { ok: false, reason: 'no filings', ms: Date.now() - startedAt };
  const prev = q1 ?? q0;

  await db.execute(sql`
    insert into fund_qoq (quarter, ticker, acc, red, computed_at)
    with per_fund as (
      select ticker, cik,
             sum(case when quarter = ${q0}::date then shares else 0 end) cur,
             sum(case when quarter = ${prev}::date then shares else 0 end) prev
        from fund_holdings
       where quarter in (${q0}::date, ${prev}::date)
         and ticker is not null and put_call = ''
       group by ticker, cik
    )
    select ${q0}::date, ticker,
           count(*) filter (where cur > prev)::int,
           count(*) filter (where cur < prev)::int,
           now()
      from per_fund group by ticker
    on conflict (quarter, ticker) do update
       set acc = excluded.acc, red = excluded.red, computed_at = excluded.computed_at`);

  const res = await db.execute(sql`select count(*)::int n from fund_qoq where quarter = ${q0}::date`);
  const tickers = Number((res.rows ?? res)[0]?.n) || 0;

  // Yesterday's quarter pair is dead weight once a new quarter lands; the board only ever reads the
  // current one. Kept to two so a rollback has something to fall back on.
  await db.execute(sql`
    delete from fund_qoq
     where quarter not in (select distinct quarter from fund_qoq order by quarter desc limit 2)`);

  return { ok: true, quarter: q0, prevQuarter: prev, tickers, ms: Date.now() - startedAt };
}

/**
 * The quarter pair AND whether the summary exists for it, in one round trip.
 *
 * These travel together because the board needs both before it can decide which path to take, and
 * asking separately would put two sequential round trips in front of every request.
 */
export async function quartersAndSummaryState() {
  // Two scalar columns rather than an array_agg: drivers disagree about whether a Postgres array
  // comes back as a JS array or as the literal '{...}' string, and there is no reason to care.
  const res = await db.execute(sql`
    with q as (
      select quarter, row_number() over (order by quarter desc) rn
        from (select quarter from fund_filings group by quarter) d
    )
    select (select quarter from q where rn = 1) q0,
           (select quarter from q where rn = 2) q1,
           (select count(*)::int from fund_qoq
             where quarter = (select quarter from q where rn = 1)) summary_rows`);
  const row = (res.rows ?? res)[0] || {};
  const day = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  return { q0: day(row.q0), q1: day(row.q1), built: Number(row.summary_rows) > 0 };
}

/**
 * The board's read: the requested tickers for one quarter, straight off the index.
 *
 * ONLY THE TICKERS ASKED FOR. The board requires two aligned signals, so a ticker the funds moved
 * but no insider and no member of Congress touched can never appear on it — reading all 14,474 to
 * discard 13,000 of them is transfer for nothing. The caller passes the union of the insider and
 * Congress tickers (~1,100), and the result is identical by construction.
 *
 * Returns null — NOT an empty map — when the summary has not been built for this quarter, because
 * those two states mean opposite things. Empty means "no fund moved any of these", which would
 * silently strip the institutional leg out of every score. Null means "use the slow path", which is
 * what should happen while an ingest is mid-flight or a new quarter has just appeared.
 */
export async function readFundQoq(quarter, tickers) {
  if (!quarter) return null;
  const wanted = [...new Set((tickers || []).filter(Boolean))];
  if (!wanted.length) return new Map();
  // ONE text parameter cast to text[], not a JS array: drivers turn an interpolated array into a
  // record, which Postgres refuses to cast. Each element is quoted and escaped, so a ticker
  // carrying a comma, a quote or a backslash cannot break out of the literal.
  const literal = `{${wanted.map((t) => `"${String(t).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
  const res = await db.execute(sql`
    select ticker, acc, red from fund_qoq
     where quarter = ${quarter}::date and ticker = any(${literal}::text[])`);
  const map = new Map();
  for (const r of (res.rows ?? res)) map.set(r.ticker, { acc: Number(r.acc) || 0, red: Number(r.red) || 0 });
  return map;
}
