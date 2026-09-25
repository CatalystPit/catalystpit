// BUILD CONTEXT — the same rows, fetched once for many tickers instead of once per ticker.
//
// ── ⚠️ WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT ────────────────────────
//
// It is a DATA ACCESS layer and nothing else. It issues the same queries the evidence resolvers
// issue, with `ticker = $1` widened to `ticker = ANY($1)`, and hands each resolver exactly the rows
// its own query would have returned. Every calculation, threshold, window, weight and conclusion
// stays where it already lives and runs on the same input.
//
// It is NOT a second evidence engine. Nothing here interprets a filing, scores a family or decides
// what qualifies. If you find yourself adding a rule to this file, it belongs somewhere else.
//
// ── ⚠️ THE PROBLEM IT SOLVES ────────────────────────────────────────────────
//
// A board build resolves two evidence engines plus a reaction attach per candidate, which
// instrumentation put at 16 database round trips each:
//
//   3,309 candidates x 16 = 52,944 round trips
//
// Individual queries are fast — every one except the 13F aggregate is sub-millisecond in isolation.
// The build did not fit in a 300s invocation because of the COUNT of round trips, not their cost.
// Production measured ~116-122ms per ticker across four runs, needing ~400s.
//
// ── ⚠️ CHUNKED, NOT ALL-AT-ONCE ─────────────────────────────────────────────
//
// Twelve years of daily candles for 3,309 tickers is ~2.2M bars, which is not something to hold in
// one map inside a 3009MB function. The board loads a CHUNK of candidates, builds those setups from
// memory, drops the chunk and moves on. Round trips become (candidates / CHUNK) x families rather
// than candidates x families, and peak memory stays proportional to the chunk.
//
// ── ⚠️ ONE CANDLE LOAD SERVES THREE READERS ─────────────────────────────────
//
// Market structure reads 12 years, market facts read 400 days, and the reaction attach reads a
// window derived from the evidence it is attaching to — at most 1,460 days of evidence age plus a
// 12-day anchor pad. Both of the latter are strict subsets of the first, so all three are served
// from one load and filtered in memory to the exact ranges their own queries used.

import { CONSTANTS } from './consensus-v1.mjs';
import { HISTORY_WINDOW_DAYS, DISPLAY_WINDOW_DAYS } from '../evidence/resolve.js';
import { MAX_RELEVANCE_DAYS } from '../evidence/company-events.mjs';
import { HISTORY_DAYS as CANDLE_DAYS } from '../structure/structure-data.js';

const rowsOf = (res) => res?.rows ?? res ?? [];
const upper = (t) => String(t || '').toUpperCase();

/**
 * How many candidates are loaded and built at a time.
 *
 * ⚠️ A MEMORY BOUND, NOT A PERFORMANCE KNOB. The dominant term is candles: ~700 bars per ticker on
 * average and 3,015 at the worst, so 400 tickers is roughly 280k bars in flight. Raising it buys
 * almost nothing — the round-trip count is already down by two orders of magnitude — and risks the
 * function's memory ceiling on a chunk of large-cap names.
 */
export const CHUNK = 400;

/**
 * ⚠️ EVERY WINDOW IS IMPORTED FROM THE MODULE THAT OWNS IT. NEVER RETYPED.
 *
 * This is not stylistic. The first version of this file hard-coded 45 days for the consensus
 * families because that looked like the obvious number; the real values are insiders 90, congress
 * 90, catalysts 14. The equivalence test caught it as 70 of 120 setups differing — CRM flipped from
 * MIXED to NEGATIVE because its congress family saw 5 events instead of 8 and a catalyst appeared
 * that the real window excludes. A duplicated constant here is a silent methodology change.
 */
export const WINDOWS = Object.freeze({
  consensusInsiderDays: CONSTANTS.activationWindowDays.insiders,
  consensusCongressDays: CONSTANTS.activationWindowDays.congress,
  consensusCatalystDays: CONSTANTS.activationWindowDays.catalysts,
  resolveHistoryDays: HISTORY_WINDOW_DAYS,
  /** form 144 reads only the display window */
  resolveDisplayDays: DISPLAY_WINDOW_DAYS,
  /** the press-release query's own bound */
  pressDays: MAX_RELEVANCE_DAYS,
  candleDays: CANDLE_DAYS,
  /** evidence/resolve.js institutionEvidence BREADTH_LOOKBACK_DAYS / BREADTH_QUARTERS */
  breadthDays: 900,
  breadthQuarters: 9,
});

/**
 * Group flat rows into Map<ticker, rows[]>, preserving the order the database returned them in.
 *
 * ⚠️ ORDER IS PART OF THE CONTRACT. Every per-ticker query carried an ORDER BY, and downstream code
 * reads `r[0]` as "the newest". The batched queries order by (ticker, <the same key>) so that
 * slicing by ticker reproduces each original result set exactly.
 */
function groupByTicker(rows, key = 'ticker') {
  const m = new Map();
  for (const r of rows) {
    const t = upper(r[key]);
    if (!t) continue;
    const list = m.get(t);
    if (list) list.push(r); else m.set(t, [r]);
  }
  return m;
}

/**
 * The loaded rows for one chunk of candidates.
 *
 * `rows(family, ticker)` always returns an array — empty when that ticker has none — so a resolver
 * can use it exactly where it used its own query result.
 */
export class BuildContext {
  constructor(tickers, families) {
    this.tickers = new Set(tickers.map(upper));
    this.families = families;                      // Map<string, Map<ticker, rows[]>>
  }

  /** Whether this context covers the ticker at all. A miss must fall back, never return empty. */
  covers(ticker) { return this.tickers.has(upper(ticker)); }

  has(family) { return this.families.has(family); }

  rows(family, ticker) {
    if (!this.covers(ticker)) return null;         // ⚠️ null means "not loaded", not "none"
    const f = this.families.get(family);
    if (!f) return null;
    return f.get(upper(ticker)) || [];
  }
}

/**
 * Load every per-ticker evidence input for a chunk of candidates.
 *
 * ⚠️ EACH QUERY BELOW IS THE RESOLVER'S OWN QUERY, WIDENED. Same columns, same predicates, same
 * ORDER BY, and the per-ticker LIMIT reproduced with row_number() over a ticker partition — because
 * three of these limits genuinely truncate (measured: insider 4,790 rows against a 2,000 limit,
 * consensus insider 874 against 400, press releases 402 against 60) and dropping the limit would
 * hand the resolver more rows than it asked for.
 *
 * @param {string[]} tickers the chunk
 * @returns {Promise<BuildContext>}
 */
export async function loadBuildContext(db, sql, tickers, { now = Date.now() } = {}) {
  const list = [...new Set(tickers.map(upper))].filter(Boolean);
  const arr = `{${list.join(',')}}`;
  const families = new Map();
  if (!list.length) return new BuildContext(list, families);

  const W = WINDOWS;

  // Every load is independent; they go out together and the chunk waits once.
  const [
    consInsider, consCongress, consCatalyst, consInstitution,
    resInsider, resCongress, resCatalyst, res144, res13d, resPress, resBreadth,
    candles, priceQuality, priceBreaks,
  ] = await Promise.all([
    // ── consensus/evidence.js ────────────────────────────────────────────────
    db.execute(sql`
      select * from (
        select ticker, id, action, transaction_code, total_value, executive, filing_date, accession,
               coalesce(rule_10b5_1, false) as planned,
               coalesce(is_officer, false) as officer, coalesce(is_director, false) as director,
               row_number() over (partition by ticker order by filing_date desc, accession desc, id desc) rn
          from insider_trades
         where ticker = any(${arr}::text[])
           and filing_date >= (current_date - make_interval(days => ${W.consensusInsiderDays}))
           and total_value > 0) t
       where rn <= 400
       order by ticker, filing_date desc, accession desc, id desc`),
    db.execute(sql`
      select * from (
        select ticker, id, action, amount_mid, member_slug, disclosure_date, transaction_date,
               row_number() over (partition by ticker order by disclosure_date desc, id desc) rn
          from congress_trades
         where ticker = any(${arr}::text[])
           and disclosure_date >= (current_date - make_interval(days => ${W.consensusCongressDays}))) t
       where rn <= 200
       order by ticker, disclosure_date desc, id desc`),
    db.execute(sql`
      select * from (
        select ticker, items, material, filed_at, accession, report_date,
               row_number() over (partition by ticker order by filed_at desc) rn
          from eightk_filings
         where ticker = any(${arr}::text[])
           and filed_at >= (now() - make_interval(days => ${W.consensusCatalystDays}))) t
       where rn <= 40
       order by ticker, filed_at desc`),
    // ⚠️ THE 13F ROLL-UP, AGGREGATED SERVER-SIDE PER TICKER. The per-ticker version opened with two
    // max(quarter) probes; batched, the latest two quarters are derived once for the whole chunk.
    // Same definition: the newest quarter the ticker appears in, and the newest strictly before it.
    db.execute(sql`
      with t(ticker) as (select unnest(${arr}::text[])),
      -- ⚠️ ONE INDEX PROBE PER TICKER, STILL ONE ROUND TRIP. A select-distinct over ticker+quarter
      -- across the chunk reads every historical row for 400 names; a correlated max() rides
      -- idx_fund_holdings_ticker_quarter backwards and stops at the first entry.
      tq as (
        select t.ticker,
               (select max(h.quarter) from fund_holdings h where h.ticker = t.ticker) as cur
          from t),
      tq2 as (
        select tq.ticker, tq.cur,
               (select max(h.quarter) from fund_holdings h
                 where h.ticker = tq.ticker and h.quarter < tq.cur) as prev
          from tq where tq.cur is not null),
      -- ⚠️ TWO EQUALITY SEEKS, NOT AN OR. "h.quarter = cur OR h.quarter = prev" cannot use
      -- idx_fund_holdings_qoq (quarter, ticker) INCLUDE (cik, shares); expanding the two quarters
      -- into rows and joining on equality can. Measured on a 400-ticker chunk: 9,619ms -> 1,924ms,
      -- byte-identical output.
      tq3 as (
        select ticker, cur as quarter, true as is_cur from tq2
        union all
        select ticker, prev, false from tq2 where prev is not null),
      per_fund as (
        select h.ticker, h.cik,
               sum(case when tq3.is_cur then h.shares else 0 end) as cur_sh,
               sum(case when not tq3.is_cur then h.shares else 0 end) as prev_sh
          from tq3
          join fund_holdings h on h.quarter = tq3.quarter and h.ticker = tq3.ticker
         where h.put_call = ''
         group by h.ticker, h.cik)
      select tq2.ticker,
             tq2.cur::text as quarter_end,
             (select max(f.filed_date) from fund_filings f where f.quarter = tq2.cur)::text as disclosed_at,
             count(*) filter (where pf.cur_sh > pf.prev_sh)::int as increased,
             count(*) filter (where pf.cur_sh < pf.prev_sh and pf.cur_sh > 0)::int as reduced,
             count(*) filter (where pf.prev_sh = 0 and pf.cur_sh > 0)::int as initiated,
             count(*) filter (where pf.cur_sh = 0 and pf.prev_sh > 0)::int as exited,
             count(*) filter (where pf.cur_sh > 0)::int as holders
        from tq2 left join per_fund pf on pf.ticker = tq2.ticker
       group by tq2.ticker, tq2.cur`),

    // ── evidence/resolve.js ──────────────────────────────────────────────────
    db.execute(sql`
      select * from (
        select ticker, id, action, transaction_code, total_value, shares, executive, title,
               filing_date, accession, filing_url,
               -- ⚠️ MIRRORS insiderEvidence's OWN SELECT, AND MUST. This hands the resolver the
               -- rows its query would have returned; a column missing here is a field the resolver
               -- silently sees as null on the batched path only, so the Consensus board and the
               -- alert worker would disagree with the ticker page about the same filing.
               transaction_date, price_per_share,
               coalesce(rule_10b5_1, false) as planned,
               coalesce(is_derivative, false) as derivative,
               coalesce(superseded_by, '') as superseded,
               coalesce(is_officer, false) as officer, coalesce(is_director, false) as director,
               row_number() over (partition by ticker order by filing_date desc, accession desc, id desc) rn
          from insider_trades
         where ticker = any(${arr}::text[])
           and filing_date >= (current_date - make_interval(days => ${W.resolveHistoryDays}))
           and total_value > 0) t
       where rn <= 2000
       order by ticker, filing_date desc, accession desc, id desc`),
    db.execute(sql`
      select * from (
        select ticker, id, action, amount_mid, amount_min, amount_range, member_slug, representative,
               party, chamber, state, disclosure_date, transaction_date, link,
               row_number() over (partition by ticker order by disclosure_date desc, id desc) rn
          from congress_trades
         where ticker = any(${arr}::text[])
           and disclosure_date >= (current_date - make_interval(days => ${W.resolveHistoryDays}))) t
       where rn <= 1000
       order by ticker, disclosure_date desc, id desc`),
    db.execute(sql`
      select * from (
        select ticker, items, coalesce(material, false) as material, filed_at, accession,
               report_date, filing_url, primary_doc_url,
               row_number() over (partition by ticker order by filed_at desc) rn
          from eightk_filings
         where ticker = any(${arr}::text[])
           and filed_at >= (now() - make_interval(days => ${W.resolveHistoryDays}))) t
       where rn <= 1000
       order by ticker, filed_at desc`),
    db.execute(sql`
      select * from (
        select ticker, accession, seller, relationship, shares, aggregate_value, shares_outstanding,
               approx_sale_date, filed_at, primary_doc_url, filing_url,
               row_number() over (partition by ticker order by filed_at desc) rn
          from form144_filings
         where ticker = any(${arr}::text[])
           and filed_at >= (now() - make_interval(days => ${W.resolveDisplayDays}))) t
       where rn <= 100
       order by ticker, filed_at desc`),
    db.execute(sql`
      select * from (
        select ticker, accession, issuer_name, security_class, form_type, is_amendment, filer_name,
               filer_type, pct_of_class, shares, item4_codes, date_of_event, group_key, filed_at,
               primary_doc_url, filing_url,
               row_number() over (partition by ticker order by filed_at desc) rn
          from schedule13d_filings
         where ticker = any(${arr}::text[])
           and filed_at >= (now() - make_interval(days => ${W.resolveHistoryDays}))) t
       where rn <= 200
       order by ticker, filed_at desc`),
    // ⚠️ primary_events MATCHES ON AN ARRAY COLUMN, so one row can belong to several candidates.
    // unnest expands it to one row per (candidate, event), which is what the per-ticker query
    // returned for each of them. The `&&` prefilter keeps the scan off rows for nobody in the chunk.
    db.execute(sql`
      select * from (
        select tk.ticker, p.seq, p.source,
               coalesce(p.source_headline, p.headline) as headline, p.summary,
               p.published_at, p.canonical_url, p.original_url, p.content_hash,
               row_number() over (partition by tk.ticker order by p.published_at desc, p.seq desc) rn
          from primary_events p
          cross join lateral unnest(p.tickers) as tk(ticker)
         where p.tickers && ${arr}::text[]
           and tk.ticker = any(${arr}::text[])
           and p.published_at >= (now() - make_interval(days => ${W.pressDays}))) t
       where rn <= 60
       order by ticker, published_at desc, seq desc`),
    db.execute(sql`
      select * from (
        select ticker, quarter, count(distinct cik) as breadth,
               row_number() over (partition by ticker order by quarter desc) rn
          from fund_holdings
         where ticker = any(${arr}::text[])
           and put_call = ''
           and quarter >= (current_date - make_interval(days => ${W.breadthDays}))
         group by ticker, quarter) t
       where rn <= ${W.breadthQuarters}
       order by ticker, quarter desc`),

    // ── prices: one load, three readers ──────────────────────────────────────
    db.execute(sql`
      select ticker, date::text as date, open, high, low, close, volume
        from ticker_daily_candles
       where ticker = any(${arr}::text[])
         and date >= (current_date - make_interval(days => ${W.candleDays}))
       order by ticker, date asc`),
    db.execute(sql`
      select ticker, coalesce(usable, true) as usable, reason,
             last_break::text as last_break, break_count
        from ticker_price_quality where ticker = any(${arr}::text[])`),
    db.execute(sql`
      select ticker, break_date::text as break_date
        from ticker_price_breaks where ticker = any(${arr}::text[])`),
  ]);

  families.set('consensus.insider', groupByTicker(rowsOf(consInsider)));
  families.set('consensus.congress', groupByTicker(rowsOf(consCongress)));
  families.set('consensus.catalyst', groupByTicker(rowsOf(consCatalyst)));
  families.set('consensus.institution', groupByTicker(rowsOf(consInstitution)));
  families.set('resolve.insider', groupByTicker(rowsOf(resInsider)));
  families.set('resolve.congress', groupByTicker(rowsOf(resCongress)));
  families.set('resolve.catalyst', groupByTicker(rowsOf(resCatalyst)));
  families.set('resolve.form144', groupByTicker(rowsOf(res144)));
  families.set('resolve.sched13d', groupByTicker(rowsOf(res13d)));
  families.set('resolve.press', groupByTicker(rowsOf(resPress)));
  families.set('resolve.breadth', groupByTicker(rowsOf(resBreadth)));
  families.set('price.candles', groupByTicker(rowsOf(candles)));
  families.set('price.quality', groupByTicker(rowsOf(priceQuality)));
  families.set('price.breaks', groupByTicker(rowsOf(priceBreaks)));

  return new BuildContext(list, families);
}

/** Split the candidate list into chunks of at most CHUNK. */
export function chunkTickers(tickers, size = CHUNK) {
  const out = [];
  for (let i = 0; i < tickers.length; i += size) out.push(tickers.slice(i, i + size));
  return out;
}
