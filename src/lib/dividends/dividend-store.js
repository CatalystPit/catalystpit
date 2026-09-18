// READING AND WRITING DIVIDEND EVENTS.
//
// Ingestion writes here on a cron. The calendar reads here on a request. Those are the only two
// paths, and the second never calls a provider — the mistake this codebase has already paid for
// twice (the 13F roll-up and the symbol-search aggregation) is doing provider work in front of a
// user, and it is not repeated here.

import { sql } from 'drizzle-orm';
import { db } from '../db';

/**
 * Upsert canonical events. IDEMPOTENT on (source, source_event_id).
 *
 * A provider that revises an announced dividend — a changed amount, a payment date that finally
 * arrives — re-sends the same event id, and that UPDATES the row. Re-running a whole window
 * therefore costs nothing and fixes everything, which is what makes the daily sync safe to repeat.
 *
 * Written in batches with a single multi-row insert per batch, so a thousand events are a handful of
 * statements rather than a thousand of them.
 */
export async function upsertDividendEvents(events, { batchSize = 500 } = {}) {
  const rows = (events || []).filter(Boolean);
  if (!rows.length) return { written: 0, batches: 0 };
  let written = 0, batches = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = batch.map((e) => sql`(
      ${e.source}, ${e.sourceEventId}, ${e.ticker}, ${e.cik ?? null},
      ${e.declarationDate ?? null}::date, ${e.exDividendDate ?? null}::date,
      ${e.recordDate ?? null}::date, ${e.paymentDate ?? null}::date,
      ${e.cashAmount ?? null}, ${e.currency ?? null}, ${e.dividendType ?? null},
      ${e.frequency ?? null}, ${e.annualizedAmount ?? null}, ${e.announced === true}, now()
    )`);

    await db.execute(sql`
      insert into dividend_events (
        source, source_event_id, ticker, cik,
        declaration_date, ex_dividend_date, record_date, payment_date,
        cash_amount, currency, dividend_type, frequency, annualized_amount, announced, updated_at)
      values ${sql.join(values, sql`, `)}
      on conflict (source, source_event_id) do update set
        ticker            = excluded.ticker,
        cik               = coalesce(excluded.cik, dividend_events.cik),
        declaration_date  = excluded.declaration_date,
        ex_dividend_date  = excluded.ex_dividend_date,
        record_date       = excluded.record_date,
        payment_date      = excluded.payment_date,
        cash_amount       = excluded.cash_amount,
        currency          = excluded.currency,
        dividend_type     = excluded.dividend_type,
        frequency         = excluded.frequency,
        annualized_amount = excluded.annualized_amount,
        announced         = excluded.announced,
        updated_at        = now()`);

    written += batch.length;
    batches += 1;
  }
  return { written, batches };
}

/** Column list shared by the calendar reads, so the two date modes cannot drift apart. */
const EVENT_COLUMNS = sql`
  d.ticker, d.ex_dividend_date, d.payment_date, d.record_date, d.declaration_date,
  d.cash_amount, d.currency, d.dividend_type, d.frequency, d.annualized_amount`;

/**
 * The calendar query: ONE indexed date range, plus a bounded join to metadata we already store.
 *
 * `mode` picks which date organises the calendar — 'ex' (the default and the product's primary axis)
 * or 'payment'. Both are indexed, so the toggle costs nothing.
 *
 * ANNOUNCED ONLY. An event with no issuer announcement behind it never leaves this function, which
 * is where "we do not predict dividends" stops being a promise and becomes a where clause.
 *
 * The join is to screener_stocks and screener_meta — tables a cron already maintains — so a row
 * arrives with its company name, sector, market cap and last price without a second query and
 * without an N+1. A ticker we do not track still appears; it simply has no metadata.
 */
/**
 * The WHERE both the page of rows and the count are built from.
 *
 * ONE BUILDER, TWO QUERIES, on purpose. When the count had its own narrower conditions the page
 * reported "139 events" above an empty table — the rows honoured the filter and the total did not,
 * so the calendar contradicted itself in the only two numbers a reader can compare.
 */
function calendarConditions({
  from, to, dateCol,
  search = null, sector = null, minYield = null, minAmount = null,
  frequency = null, type = null, minMarketCap = null, covered = true,
} = {}) {
  const conds = [sql`d.announced = true`, sql`${dateCol} >= ${from}::date`, sql`${dateCol} <= ${to}::date`];
  // TICKERS WE ACTUALLY COVER, by default.
  //
  // The provider's feed is global — New Zealand lines, foreign OTC tickers and mutual-fund share
  // classes all carry dividends. Measured on a real window, only about a fifth of raw rows match a
  // security in our own universe. Showing the rest would fill the calendar with names that have no
  // company, no sector, no price, and whose ticker link would land on a page we cannot render.
  // `covered: false` lifts the restriction for an operational view.
  if (covered) conds.push(sql`s.ticker is not null`);
  if (search) {
    const like = `%${String(search).toUpperCase().slice(0, 40)}%`;
    conds.push(sql`(d.ticker like ${like} or upper(coalesce(s.company, '')) like ${like})`);
  }
  // Sector lives on both tables; screener_meta covers tickers the daily screener rebuild has not
  // reached yet, which is why this coalesces rather than picking one.
  if (sector) conds.push(sql`coalesce(s.sector, m.sector) = ${sector}`);
  if (type) conds.push(sql`d.dividend_type = ${type}`);
  if (frequency != null) conds.push(sql`d.frequency = ${Number(frequency)}`);
  if (minAmount != null) conds.push(sql`d.cash_amount >= ${Number(minAmount)}`);
  if (minMarketCap != null) conds.push(sql`coalesce(s.market_cap, m.market_cap) >= ${Number(minMarketCap)}`);
  // Yield is filtered in SQL from stored numbers only — never computed from a fetched price.
  if (minYield != null) {
    conds.push(sql`(d.annualized_amount is not null and s.price > 0
      and (d.annualized_amount / s.price) * 100 >= ${Number(minYield)})`);
  }
  return sql.join(conds, sql` and `);
}

export async function calendarRange({ from, to, mode = 'ex', limit = 500, offset = 0, ...filters } = {}) {
  const dateCol = mode === 'payment' ? sql`d.payment_date` : sql`d.ex_dividend_date`;
  const lim = Math.max(1, Math.min(1000, Number(limit) || 500));
  const off = Math.max(0, Number(offset) || 0);
  const where = calendarConditions({ from, to, dateCol, ...filters });

  const res = await db.execute(sql`
    select ${EVENT_COLUMNS},
           s.company as company,
           coalesce(s.sector, m.sector) as sector,
           coalesce(s.market_cap, m.market_cap) as market_cap,
           s.price as price
      from dividend_events d
      left join screener_stocks s on s.ticker = d.ticker
      left join screener_meta   m on m.ticker = d.ticker
     where ${where}
     order by ${dateCol} asc, d.ticker asc
     limit ${lim} offset ${off}`);

  return res.rows ?? res;
}

/** How many announced events sit in a window — for paging, and for the empty state to be honest. */
export async function calendarCount({ from, to, mode = 'ex', ...filters } = {}) {
  const dateCol = mode === 'payment' ? sql`d.payment_date` : sql`d.ex_dividend_date`;
  // The SAME conditions as the rows, over the same joins — the filters reach `s`, so the joins have
  // to be here too even though nothing is selected from them.
  const where = calendarConditions({ from, to, dateCol, ...filters });
  const res = await db.execute(sql`
    select count(*)::int as n
      from dividend_events d
      left join screener_stocks s on s.ticker = d.ticker
      left join screener_meta   m on m.ticker = d.ticker
     where ${where}`);
  return Number((res.rows ?? res)[0]?.n) || 0;
}

/** Freshness, so the page can say when it last synced rather than implying it is live. */
export async function dividendSyncState() {
  const res = await db.execute(sql`
    select max(updated_at) as updated_at, count(*)::int as events,
           count(*) filter (where ex_dividend_date >= current_date)::int as upcoming
      from dividend_events`);
  const row = (res.rows ?? res)[0] || {};
  return {
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    events: Number(row.events) || 0,
    upcoming: Number(row.upcoming) || 0,
  };
}
