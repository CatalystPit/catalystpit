// DIVIDEND-AND-SPLIT-ADJUSTED DAILY CLOSES — total-return prices, stored apart from the raw bars.
//
// ── ⚠️ WHY THIS IS A SEPARATE TABLE ─────────────────────────────────────────
//
// `ticker_daily_candles` is SPLIT-adjusted only. Its rows are stamped 'tiingo_split_adj' and its own
// notes say mixing adjustment bases inside one column would make the column meaningless — every
// other consumer in the product reads it expecting price, not total return. So nothing here writes
// to that table. Total-return closes get their own table, their own source stamp and their own
// loader, and the two are never mixed in one series.
//
// ── ⚠️ WHY A COMPONENT NEEDS THIS AT ALL ────────────────────────────────────
//
// Comparing an income-paying bond fund against an equity index on price alone measures coupons
// rather than conviction. Measured on our own bars: TLT, SHY and HYG each drop by roughly their
// monthly distribution on the first trading day of the month (0.20%, 0.28%, 0.44%), and TLT's
// PRICE-ONLY return since 2002 is -4% against a +121% TOTAL return. A stocks-versus-bonds spread
// built on price-only data is largely a yield-differential artifact.
//
// ── ⚠️ ADJUSTED RETURNS ARE STILL POINT-IN-TIME CORRECT ─────────────────────
//
// The obvious worry is that an adjusted series gets revised: a new distribution rescales every
// earlier bar. It does — but not the RETURNS between two earlier dates. A distribution paid after
// date t multiplies the adjusted close at t0 and at t1 (both before it) by the SAME factor, so the
// ratio is unchanged. Only distributions falling INSIDE [t0, t1] move that ratio, and those were
// public by t1. A total return computed between two past dates is therefore exactly what an
// investor experienced and it is not revised by the future.
//
// ── ⚠️ AND NOTHING IS MANUFACTURED ──────────────────────────────────────────
//
// A session the provider does not return is ABSENT. There is no interpolation, no forward-fill, no
// carrying yesterday's close, and no neutral substitute. A ticker whose fetch fails is left alone
// rather than partially written.

import { db as defaultDb } from '../db.js';
import { sql } from 'drizzle-orm';

export const ADJUSTED_SOURCE = 'tiingo_total_return';
const rows = (res) => res?.rows ?? res ?? [];

/** The instruments the Safe-Haven Demand component needs, and nothing else. */
export const ADJUSTED_SYMBOLS = ['SPY', 'IEF', 'GLD'];

export async function ensureAdjustedTable(dbc = defaultDb) {
  await dbc.execute(sql`
    create table if not exists ticker_daily_adjusted (
      ticker      text        not null,
      date        date        not null,
      adj_close   double precision not null,
      source      text        not null,
      retrieved_at timestamptz not null default now(),
      primary key (ticker, date),
      -- ⚠️ A NON-POSITIVE TOTAL-RETURN CLOSE IS NOT A PRICE. Refused at the storage layer so a bad
      -- parse can never become an observation.
      constraint ticker_daily_adjusted_positive check (adj_close > 0)
    )`);
  await dbc.execute(sql`
    create index if not exists ticker_daily_adjusted_ticker_date
      on ticker_daily_adjusted (ticker, date)`);
}

/**
 * Total-return closes for one symbol, oldest first.
 *
 * @returns {Promise<Array<{date:string, close:number}>>} shaped like loadCloses so the series
 *          helpers can consume it unchanged.
 */
export async function loadAdjustedCloses(dbc = defaultDb, symbol, { sinceDays = 12500 } = {}) {
  const res = await dbc.execute(sql`
    select date::text as date, adj_close::float8 as close
      from ticker_daily_adjusted
     where ticker = ${String(symbol).toUpperCase()}
       and adj_close > 0
       and date >= (current_date - make_interval(days => ${sinceDays}))
     order by date asc`);
  return rows(res).map((r) => ({ date: String(r.date), close: Number(r.close) }));
}

/**
 * Fetch adjusted closes from Tiingo. Returns [] on any failure — never a partial series presented
 * as complete.
 */
export async function fetchAdjustedCloses(symbol, { startDate = '2002-01-01', token = process.env.TIINGO_API_KEY } = {}) {
  if (!token) return { rows: [], error: 'TIINGO_API_KEY is not set' };
  const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(symbol)}/prices`
    + `?startDate=${startDate}&format=json&resampleFreq=daily&token=${token}`;
  try {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) return { rows: [], error: `HTTP ${res.status}` };
    const json = await res.json();
    if (!Array.isArray(json) || !json.length) return { rows: [], error: 'empty payload' };
    const out = json
      .map((r) => ({ date: String(r.date).slice(0, 10), adj: Number(r.adjClose) }))
      // ⚠️ A ROW WITHOUT A USABLE ADJUSTED CLOSE IS DROPPED, never defaulted to the raw close —
      // silently substituting price for total return is the exact error this file exists to prevent.
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.adj) && r.adj > 0);
    return { rows: out, error: out.length ? null : 'no usable rows' };
  } catch (e) {
    return { rows: [], error: e.message };
  }
}

/** Upsert observations for one symbol. Bounded batches; existing rows are replaced, none deleted. */
export async function saveAdjustedCloses(dbc = defaultDb, symbol, observations = []) {
  const clean = observations.filter((o) => o && Number.isFinite(Number(o.adj)) && Number(o.adj) > 0);
  if (!clean.length) return 0;
  const tick = String(symbol).toUpperCase();
  let written = 0;
  for (let i = 0; i < clean.length; i += 500) {
    const batch = clean.slice(i, i + 500);
    const values = sql.join(
      batch.map((o) => sql`(${tick}, ${o.date}::date, ${Number(o.adj)}, ${ADJUSTED_SOURCE}, now())`),
      sql`, `,
    );
    await dbc.execute(sql`
      insert into ticker_daily_adjusted (ticker, date, adj_close, source, retrieved_at)
      values ${values}
      on conflict (ticker, date) do update
        set adj_close = excluded.adj_close,
            source = excluded.source,
            retrieved_at = excluded.retrieved_at`);
    written += batch.length;
  }
  return written;
}

/**
 * Bring the adjusted store up to date. Called by the nightly build.
 *
 * ⚠️ THIS EXISTS BECAUSE THE COMPONENT DIES WITHOUT IT. The backfill is a one-off; without a
 * nightly refresh the newest adjusted close stays frozen at whatever the backfill wrote, the
 * safe-haven series stops producing observations for new sessions, and the component quietly
 * reports itself absent from the day after the backfill onward.
 *
 * ⚠️ BOUNDED, NOT A RE-BACKFILL. It asks for a short recent window rather than the whole history:
 * the provider revises adjusted closes when a distribution occurs, so the recent tail is the part
 * that legitimately changes, and re-fetching twenty-four years nightly would be pointless traffic.
 * Rows are upserted, so a revision inside the window lands and nothing outside it is touched.
 *
 * ⚠️ AND A FAILURE HERE IS NOT AN INDEX FAILURE. A symbol that cannot be fetched is left exactly
 * as it was — no partial write, no placeholder, no carrying yesterday forward. The series then
 * lacks the newest sessions and the component reports itself absent, which is the existing
 * missing-component rule and is honest about what we hold.
 *
 * @returns {Promise<{asked:number, stored:number, failed:number, symbols:object}>}
 */
export async function refreshAdjusted(dbc = defaultDb, { days = 90, symbols = ADJUSTED_SYMBOLS } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const out = { asked: 0, stored: 0, failed: 0, symbols: {} };
  for (const sym of symbols) {
    out.asked++;
    const { rows: got, error } = await fetchAdjustedCloses(sym, { startDate: since });
    if (error || !got.length) { out.failed++; out.symbols[sym] = `failed: ${error || "empty"}`; continue; }
    const n = await saveAdjustedCloses(dbc, sym, got);
    out.stored += n;
    out.symbols[sym] = `${n} rows through ${got.at(-1).date}`;
  }
  return out;
}

/** What we hold, for logging and for the integrity checks. */
export async function adjustedCoverage(dbc = defaultDb) {
  const res = await dbc.execute(sql`
    select ticker, count(*)::int as n, min(date)::text as first, max(date)::text as last
      from ticker_daily_adjusted group by ticker order by ticker`);
  return rows(res).map((r) => ({ ticker: r.ticker, n: Number(r.n), first: r.first, last: r.last }));
}
