import { sql, and, eq, gte, inArray, desc, isNotNull } from 'drizzle-orm';
import { db } from './db';
import { insiderTrades, congressTrades, fundHoldings, fundFilings, eightkFilings, shortInterest, tickerFloat, tickerDailyCandles, screenerStocks, screenerMeta, screenerFundamentals, tickerInstitutionalOwnership } from './schema';
import { LICENSED_CANDLE_SOURCES_SQL, servableMetaSource } from './licensing/providers.mjs';

/**
 * A Postgres text[] literal from a list of code-generated values.
 *
 * ⚠️ BECAUSE A BOUND ARRAY PARAMETER DOES NOT WORK ON THIS DRIVER. `any(${jsArray})` renders through
 * drizzle's neon-http driver as `any(($2))`, which Postgres rejects — the query throws, a caller's catch
 * turns it into an empty result, and the surface reports success while serving nothing. That is exactly
 * how /api/ticker shipped an empty metrics block.
 *
 * ⚠️ AND EVERY VALUE IS WHITELISTED BY SHAPE, NOT ESCAPED. These lists are tickers and ISO dates this
 * module generated itself, never user input — but building SQL text from a list deserves a guard that
 * does not depend on that staying true, so anything that is not a plain symbol or date is dropped rather
 * than quoted. A dropped value narrows a result; an injected one does something else entirely.
 */
function textArrayLiteral(values) {
  const safe = (values || [])
    .map((v) => String(v))
    .filter((v) => /^[A-Za-z0-9.\-]{1,24}$/.test(v));
  return safe.length ? `ARRAY[${safe.map((v) => `'${v}'`).join(',')}]::text[]` : `ARRAY[]::text[]`;
}
import { computeConfluence } from './confluence';
import { isSicDescription } from './sic-descriptions.mjs';
import { resolveClassifications, secTickerIndex } from './market/sec-classification.mjs';
import { sicToMarketSector } from './market-taxonomy.mjs';
import { isRenderableTicker } from './security-identity.mjs';
import { isExchangeTestSymbol } from './ticker-symbol.mjs';
import { readSecurityIdentity, refreshSecurityIdentity, filerNameMap } from './security-identity';
import { captureFundamentalSnapshot } from './fundamental-snapshot';

// Populates the screener_stocks universe from data we ALREADY own (no external provider):
//  proprietary signals (insider/congress/13F/consensus/8-K) + price/volume/technicals computed
//  from ticker_daily_candles + short interest + float. Descriptive/fundamental columns stay null
//  until a bulk market-data feed is ingested. Run by /api/cron/screener (nightly) or admin.

let _ensured = false;
export async function ensureScreenerTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS screener_stocks (
    ticker TEXT PRIMARY KEY, company TEXT, exchange TEXT, sector TEXT, industry TEXT, country TEXT,
    asset_type TEXT, market_cap DOUBLE PRECISION, ipo_date DATE,
    price DOUBLE PRECISION, change_pct DOUBLE PRECISION, volume DOUBLE PRECISION, avg_vol DOUBLE PRECISION,
    rel_vol DOUBLE PRECISION, float_shares DOUBLE PRECISION, shares_out DOUBLE PRECISION,
    short_float DOUBLE PRECISION, days_to_cover DOUBLE PRECISION, dividend_yield DOUBLE PRECISION, beta DOUBLE PRECISION,
    rsi14 DOUBLE PRECISION, sma20 DOUBLE PRECISION, sma50 DOUBLE PRECISION, sma200 DOUBLE PRECISION,
    hi52 DOUBLE PRECISION, lo52 DOUBLE PRECISION, atr14 DOUBLE PRECISION,
    perf_1w DOUBLE PRECISION, perf_1m DOUBLE PRECISION, perf_3m DOUBLE PRECISION, perf_6m DOUBLE PRECISION,
    perf_ytd DOUBLE PRECISION, perf_1y DOUBLE PRECISION,
    pe DOUBLE PRECISION, forward_pe DOUBLE PRECISION, peg DOUBLE PRECISION, ps DOUBLE PRECISION, pb DOUBLE PRECISION,
    ev_ebitda DOUBLE PRECISION, eps_growth_ttm DOUBLE PRECISION, rev_growth_ttm DOUBLE PRECISION,
    roe DOUBLE PRECISION, gross_margin DOUBLE PRECISION, net_margin DOUBLE PRECISION, debt_equity DOUBLE PRECISION,
    insider_own_pct DOUBLE PRECISION, inst_own_pct DOUBLE PRECISION,
    insider_net_90d DOUBLE PRECISION, insider_buyers_90d INTEGER, insider_buy_90d BOOLEAN DEFAULT FALSE,
    insider_sell_90d BOOLEAN DEFAULT FALSE, congress_net_90d DOUBLE PRECISION, congress_buy_90d BOOLEAN DEFAULT FALSE,
    fund_net_qoq INTEGER, consensus_score INTEGER, has_material_8k BOOLEAN DEFAULT FALSE, news_recent BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`ALTER TABLE screener_stocks ADD COLUMN IF NOT EXISTS sic_code INTEGER`);
  await db.execute(sql`ALTER TABLE screener_meta ADD COLUMN IF NOT EXISTS sic_code INTEGER`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_screener_sic ON screener_stocks (sic_code)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_screener_sector ON screener_stocks (sector)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_screener_mcap ON screener_stocks (market_cap)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_screener_consensus ON screener_stocks (consensus_score)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_screener_insider_buy ON screener_stocks (insider_buy_90d)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_screener_price ON screener_stocks (price)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS screener_saved (
    id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, filters TEXT, sort_by TEXT,
    sort_dir TEXT, view TEXT, columns TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_screener_saved_user ON screener_saved (user_id)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS screener_meta (
    ticker TEXT PRIMARY KEY, market_cap DOUBLE PRECISION, sector TEXT, industry TEXT, exchange TEXT,
    asset_type TEXT, country TEXT, shares_out DOUBLE PRECISION, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS screener_fundamentals (
    ticker TEXT PRIMARY KEY, eps_ttm DOUBLE PRECISION, revenue_ttm DOUBLE PRECISION, equity DOUBLE PRECISION,
    total_debt DOUBLE PRECISION, cash DOUBLE PRECISION, ebitda DOUBLE PRECISION, gross_margin DOUBLE PRECISION,
    oper_margin DOUBLE PRECISION, net_margin DOUBLE PRECISION, roe DOUBLE PRECISION, roa DOUBLE PRECISION,
    current_ratio DOUBLE PRECISION, quick_ratio DOUBLE PRECISION, debt_equity DOUBLE PRECISION, lt_debt_equity DOUBLE PRECISION,
    eps_growth_ttm DOUBLE PRECISION, rev_growth_ttm DOUBLE PRECISION, eps_growth_qoq DOUBLE PRECISION,
    sales_growth_qoq DOUBLE PRECISION, eps_growth_3y DOUBLE PRECISION, sales_growth_3y DOUBLE PRECISION,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Extra screener_stocks columns (idempotent adds): fundamentals + Polygon-computed quote/technicals.
  for (const c of ['ev_sales', 'p_cash', 'roa', 'oper_margin', 'current_ratio', 'quick_ratio', 'lt_debt_equity', 'eps_growth_qoq', 'sales_growth_qoq', 'eps_growth_3y', 'sales_growth_3y', 'change_from_open', 'gap', 'volatility', 'high20d', 'high50d', 'all_time_high', 'perf_3y', 'perf_5y', 'eps_growth_5y', 'sales_growth_5y', 'eps_growth_this_yr', 'roic', 'payout_ratio']) {
    await db.execute(sql.raw(`ALTER TABLE screener_stocks ADD COLUMN IF NOT EXISTS ${c} DOUBLE PRECISION`));
  }
  for (const c of ['eps_growth_5y', 'sales_growth_5y', 'eps_growth_this_yr', 'roic']) {
    await db.execute(sql.raw(`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS ${c} DOUBLE PRECISION`));
  }
  // Backfill bookkeeping: how many times we asked the provider about a symbol and got nothing, and
  // when we last asked. Lets an unfetchable symbol leave the daily queue without being blacklisted.
  await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE screener_meta ADD COLUMN IF NOT EXISTS annual_dividend DOUBLE PRECISION`);
  await db.execute(sql`ALTER TABLE screener_meta ADD COLUMN IF NOT EXISTS ipo_date DATE`);
  // ⚠️ PROVENANCE, AND IT IS DELIBERATELY NULLABLE WITH NO DEFAULT.
  //
  // The audit could not establish where 15,944 screener_meta rows and 4,477 screener_fundamentals rows
  // came from, because neither table ever recorded it — the answer had to be reconstructed from
  // ingestion code. Both were Polygon.
  //
  // A DEFAULT here would be the worst possible choice: it would stamp every pre-existing row with a
  // provenance nobody verified, which is exactly the "fake provenance for old records" that makes an
  // audit impossible a second time. NULL means UNKNOWN and stays UNKNOWN, and the read gate treats
  // unknown as not-servable. A row earns a source by being written by a pipeline that knows one.
  await db.execute(sql`ALTER TABLE screener_meta ADD COLUMN IF NOT EXISTS source TEXT`);
  await db.execute(sql`ALTER TABLE screener_fundamentals ADD COLUMN IF NOT EXISTS source TEXT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_screener_meta_source ON screener_meta (source)`);
  // The vendor's security name, previously fetched and discarded on every ticker-details call.
  await db.execute(sql`ALTER TABLE screener_meta ADD COLUMN IF NOT EXISTS name TEXT`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS security_identity (
    ticker TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.execute(sql`ALTER TABLE screener_stocks ADD COLUMN IF NOT EXISTS news_category TEXT`);
  await db.execute(sql`ALTER TABLE screener_stocks ADD COLUMN IF NOT EXISTS breaking_today BOOLEAN DEFAULT FALSE`);
  await db.execute(sql`ALTER TABLE screener_stocks ADD COLUMN IF NOT EXISTS candlestick TEXT`);
  await db.execute(sql`ALTER TABLE screener_stocks ADD COLUMN IF NOT EXISTS pattern TEXT`);
  await db.execute(sql`ALTER TABLE screener_saved ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'screener'`);
  _ensured = true;
}

// ── Polygon Financials → fundamentals (SEC statements). Price-independent values + raw inputs. ──
/**
 * The smallest trailing EPS that can act as a P/E denominator — a tenth of a cent.
 *
 * ⚠️ A TRIPWIRE FOR ARITHMETIC RESIDUE, NOT A VIEW ON WHICH COMPANIES DESERVE A P/E. See the comment
 * at the `pe:` assignment for the measurement: exactly one of 2,179 positive eps_ttm values falls
 * below this, at 3.47e-18, and the next smallest real value is $0.01.
 */
export const MIN_MEANINGFUL_EPS = 0.001;

const fval = (r, stmt, key) => r?.financials?.[stmt]?.[key]?.value ?? null;
const sumField = (rows, stmt, key) => rows.reduce((s, r) => { const x = fval(r, stmt, key); return x == null ? s : s + x; }, 0);
const cagr = (end, start, yrs) => (start > 0 && end > 0) ? (Math.pow(end / start, 1 / yrs) - 1) * 100 : null;
const growth = (cur, prev) => (prev != null && prev !== 0 && cur != null) ? ((cur - prev) / Math.abs(prev)) * 100 : null;

// ⚠️ THIS FETCHER IS RETIRED AND UNREACHABLE. See backfillFundamentals below for why the Screener's
// fundamentals are unavailable rather than re-sourced, and what it would take to restore them. The
// arithmetic is preserved verbatim because it is the specification a SEC-backed replacement must meet;
// nothing calls it, and the licensing sweep asserts that stays true.
async function fetchFinancialsRetiredPolygonShape(t, q = [], a = []) {
  try {
    if (q.length < 1 && a.length < 1) return null;

    const last4 = q.slice(0, 4), prev4 = q.slice(4, 8);
    const revenueTtm = last4.length ? sumField(last4, 'income_statement', 'revenues') : null;
    const netTtm = last4.length ? sumField(last4, 'income_statement', 'net_income_loss') : null;
    const grossTtm = sumField(last4, 'income_statement', 'gross_profit');
    const operTtm = sumField(last4, 'income_statement', 'operating_income_loss');
    const epsTtm = last4.reduce((s, r) => { const x = fval(r, 'income_statement', 'diluted_earnings_per_share'); return x == null ? s : s + x; }, 0) || null;
    const revPrev = prev4.length ? sumField(prev4, 'income_statement', 'revenues') : null;
    const epsPrev = prev4.length ? (prev4.reduce((s, r) => { const x = fval(r, 'income_statement', 'diluted_earnings_per_share'); return x == null ? s : s + x; }, 0) || null) : null;

    const bs = q[0] || a[0];
    const equity = fval(bs, 'balance_sheet', 'equity');
    const assets = fval(bs, 'balance_sheet', 'assets');
    const curA = fval(bs, 'balance_sheet', 'current_assets');
    const curL = fval(bs, 'balance_sheet', 'current_liabilities');
    const liab = fval(bs, 'balance_sheet', 'liabilities');
    const inv = fval(bs, 'balance_sheet', 'inventory');
    const ltDebt = fval(bs, 'balance_sheet', 'long_term_debt') ?? fval(bs, 'balance_sheet', 'noncurrent_liabilities');

    const epsQ = fval(q[0], 'income_statement', 'diluted_earnings_per_share'), epsQyr = fval(q[4], 'income_statement', 'diluted_earnings_per_share');
    const revQ = fval(q[0], 'income_statement', 'revenues'), revQyr = fval(q[4], 'income_statement', 'revenues');
    const annEps = a.map((r) => fval(r, 'income_statement', 'diluted_earnings_per_share'));
    const annRev = a.map((r) => fval(r, 'income_statement', 'revenues'));

    const pctMargin = (num) => (revenueTtm && revenueTtm > 0 && num != null) ? (num / revenueTtm) * 100 : null;
    return {
      ticker: t,
      epsTtm, revenueTtm, equity, totalDebt: liab ?? ltDebt ?? null, cash: null, ebitda: operTtm || null,
      grossMargin: pctMargin(grossTtm), operMargin: pctMargin(operTtm), netMargin: pctMargin(netTtm),
      roe: (equity > 0 && netTtm != null) ? (netTtm / equity) * 100 : null,
      roa: (assets > 0 && netTtm != null) ? (netTtm / assets) * 100 : null,
      currentRatio: (curL > 0) ? curA / curL : null,
      quickRatio: (curL > 0) ? (curA - (inv || 0)) / curL : null,
      debtEquity: (equity > 0 && liab != null) ? liab / equity : null,
      ltDebtEquity: (equity > 0 && ltDebt != null) ? ltDebt / equity : null,
      epsGrowthTtm: growth(epsTtm, epsPrev), revGrowthTtm: growth(revenueTtm, revPrev),
      epsGrowthQoq: growth(epsQ, epsQyr), salesGrowthQoq: growth(revQ, revQyr),
      epsGrowth3y: cagr(annEps[0], annEps[3], 3), salesGrowth3y: cagr(annRev[0], annRev[3], 3),
      epsGrowth5y: cagr(annEps[0], annEps[5], 5), salesGrowth5y: cagr(annRev[0], annRev[5], 5),
      epsGrowthThisYr: growth(annEps[0], annEps[1]),
      // ROIC ≈ net income TTM / invested capital (equity + total debt).
      roic: (((equity || 0) + (liab ?? ltDebt ?? 0)) > 0 && netTtm != null) ? (netTtm / ((equity || 0) + (liab ?? ltDebt ?? 0))) * 100 : null,
    };
  } catch { return null; }
}

/**
 * STOOD DOWN — THE SCREENER'S FUNDAMENTALS HAD NO LICENSED SOURCE.
 *
 * ⚠️ WHAT THIS DID. Two Polygon `vX/reference/financials` calls per ticker produced every fundamental
 * column the Screener offers: EPS TTM, revenue TTM, equity, debt, the margins, ROE/ROA/ROIC, the
 * liquidity and leverage ratios and the growth series. 4,477 rows, served to Free and Pro.
 *
 * ⚠️ WHY IT IS NOT SIMPLY REPOINTED AT SEC, which is the honest part. SEC XBRL companyfacts does carry
 * these concepts, and /api/financials already reads them for the ticker page's statements — so the
 * DATA is available to us and users have not lost access to it. What is not available in the same
 * change is a *verified* market-wide extractor: companyfacts needs fiscal-period alignment, Q4
 * derivation, restatement handling and per-issuer tag selection, and this repository already documents
 * one of those traps by name ("the AAPL stale-`Revenues` trap", /api/financials). An extractor written
 * alongside a licensing removal and shipped unverified would produce plausible, wrong P/E ratios for
 * 18,000 securities — fabrication by bug, which is worse than a blank, and the rule here is explicit
 * that unavailable beats invented.
 *
 * So the ingest stops, nothing is written, and the read gate stops serving the Polygon-derived rows
 * that remain on disk. The Screener's fundamental columns read "—" until a SEC extractor is built and
 * verified on its own. That work is scoped, not vague: extract the concept maps and period logic from
 * src/app/api/financials/route.js into a shared module, prove it against the ticker pages that already
 * render those statements, then write with source 'sec'.
 *
 * ⚠️ AND THE ROWS ARE NOT DELETED. They stay for the inventory, auditable, and unreachable.
 */
export const FUNDAMENTALS_INGEST_ENABLED = false;

export async function backfillFundamentals({ cap = 3000, concurrency = 6, staleDays = 30, force = false } = {}) {
  await ensureScreenerTables();
  if (!FUNDAMENTALS_INGEST_ENABLED) {
    return {
      disabled: true, saved: 0,
      reason: 'screener fundamentals have no licensed source; Polygon Financials was retired and a verified SEC XBRL extractor is not yet built',
    };
  }
  const uni = await db.select({ t: screenerStocks.ticker, vol: screenerStocks.volume }).from(screenerStocks);
  const have = new Map((await db.select({
    t: screenerFundamentals.ticker, u: screenerFundamentals.updatedAt,
    eps: screenerFundamentals.epsTtm, attempts: screenerFundamentals.attempts,
    last: screenerFundamentals.lastAttemptAt,
  }).from(screenerFundamentals)).map((r) => [r.t, r]));
  const cutoff = Date.now() - staleDays * 86400000;

  // WHY A SYMBOL THAT RETURNS NOTHING MUST STILL BE REMEMBERED.
  //
  // A fetch that came back empty used to write no row at all, so `have` never learned about it and
  // the same symbol was selected again on every single run — forever. Sorted by volume descending,
  // the highest-volume symbols a company-fundamentals API can never cover sat permanently at the top
  // of a 3,000-a-day queue: 6,572 of the 13,578 missing tickers are ETFs, funds, warrants, rights or
  // units. Measured, daily rows saved decayed 3,507 -> 350 -> 97 -> 46 -> 65 -> 4 as the fetchable
  // symbols finished and the queue filled with permanently unfetchable ones. Roughly 97% of provider
  // calls were being spent re-asking questions already answered, and the genuinely fetchable
  // remainder further down the volume ranking was never reached.
  //
  // An empty answer is now recorded as an ATTEMPT, not as a verdict. The symbol leaves the queue for
  // a while and comes back later, because "no data today" is not the same as "no data ever" — a
  // newly listed company acquires fundamentals eventually. Backoff is linear in the number of failed
  // attempts and capped, so a permanently unsupported symbol costs one call a quarter rather than
  // one a day, while a temporarily empty one returns within the week.
  const retryDueAt = (h) => {
    const days = Math.min(7 * Math.max(1, h.attempts || 1), 90);
    return h.last ? new Date(h.last).getTime() + days * 86400000 : 0;
  };
  const needsWork = (r) => {
    const h = have.get(r.t);
    if (!h) return true;                                       // never attempted
    if (h.eps != null) return !h.u || new Date(h.u).getTime() < cutoff;   // has data -> refresh when stale
    return retryDueAt(h) <= Date.now();                        // attempted, empty -> only when due
  };
  // force = re-fetch everything (to backfill newly-added fields), oldest/never-fetched first so
  // successive runs advance through the universe. Normal = only what needs work, and among those a
  // symbol never tried outranks one already known to come back empty, so a run spends its budget on
  // new ground before re-testing old.
  const rank = (r) => (have.get(r.t) ? (have.get(r.t).eps != null ? 1 : 2) : 0);
  const need = (force
    ? uni.slice().sort((a, b) => (have.get(a.t)?.u ? new Date(have.get(a.t).u).getTime() : 0) - (have.get(b.t)?.u ? new Date(have.get(b.t).u).getTime() : 0))
    : uni.filter(needsWork).sort((a, b) => rank(a) - rank(b) || (b.vol || 0) - (a.vol || 0))
  ).slice(0, cap).map((r) => r.t);

  const rows = [];
  const emptied = [];
  for (let i = 0; i < need.length; i += concurrency) {
    const batch = need.slice(i, i + concurrency);
    const got = await Promise.all(batch.map(fetchFinancials));
    got.forEach((d, j) => {
      if (d) rows.push({ ...d, updatedAt: new Date(), attempts: 0, lastAttemptAt: new Date() });
      else emptied.push(batch[j]);
    });
  }
  let saved = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    await db.insert(screenerFundamentals).values(batch).onConflictDoUpdate({
      target: screenerFundamentals.ticker,
      set: {
        epsTtm: sql`excluded.eps_ttm`, revenueTtm: sql`excluded.revenue_ttm`, equity: sql`excluded.equity`, totalDebt: sql`excluded.total_debt`, cash: sql`excluded.cash`, ebitda: sql`excluded.ebitda`,
        grossMargin: sql`excluded.gross_margin`, operMargin: sql`excluded.oper_margin`, netMargin: sql`excluded.net_margin`, roe: sql`excluded.roe`, roa: sql`excluded.roa`,
        currentRatio: sql`excluded.current_ratio`, quickRatio: sql`excluded.quick_ratio`, debtEquity: sql`excluded.debt_equity`, ltDebtEquity: sql`excluded.lt_debt_equity`,
        epsGrowthTtm: sql`excluded.eps_growth_ttm`, revGrowthTtm: sql`excluded.rev_growth_ttm`, epsGrowthQoq: sql`excluded.eps_growth_qoq`, salesGrowthQoq: sql`excluded.sales_growth_qoq`,
        epsGrowth3y: sql`excluded.eps_growth_3y`, salesGrowth3y: sql`excluded.sales_growth_3y`,
        epsGrowth5y: sql`excluded.eps_growth_5y`, salesGrowth5y: sql`excluded.sales_growth_5y`, epsGrowthThisYr: sql`excluded.eps_growth_this_yr`, roic: sql`excluded.roic`, updatedAt: sql`now()`,
        // A symbol that answers clears its backoff, so a temporary outage never compounds.
        attempts: sql`0`, lastAttemptAt: sql`now()`,
      },
    });
    saved += batch.length;
  }

  // The empty answers, recorded so the queue moves on. Data columns are left exactly as they were —
  // this only ever touches the attempt counter, so a symbol that once had fundamentals and came back
  // empty today keeps yesterday's numbers rather than being blanked.
  let backedOff = 0;
  for (let i = 0; i < emptied.length; i += 500) {
    const b = emptied.slice(i, i + 500);
    await db.execute(sql`
      INSERT INTO screener_fundamentals (ticker, attempts, last_attempt_at)
      SELECT t, 1, now() FROM unnest(${b}::text[]) AS t
      ON CONFLICT (ticker) DO UPDATE
        SET attempts = screener_fundamentals.attempts + 1, last_attempt_at = now()`);
    backedOff += b.length;
  }
  return { requested: need.length, fetched: rows.length, saved, backedOff };
}

// Polygon primary_exchange (MIC) → our exchange label.
const EXCH_MAP = { XNAS: 'NASDAQ', XNGS: 'NASDAQ', XNCM: 'NASDAQ', XNMS: 'NASDAQ', ARCX: 'NYSE', XNYS: 'NYSE', XASE: 'AMEX', BATS: 'AMEX', XCBO: 'AMEX' };
// The coarse SIC→sector mapper that used to live here has been replaced by the canonical taxonomy
// in market-taxonomy.mjs. It described itself as "approximate; good enough for screening buckets"
// and was accurate about that — but it became what colours the market heatmap, where it put TSLA in
// Industrials, PG in Basic Materials and PLD in Financial Services. Sector derivation now has ONE
// definition, shared by the screener, the heatmap, ticker pages and research.

/**
 * ONE SECURITY'S REFERENCE DATA, FROM SEC AND FROM PRICES WE ARE LICENSED TO HOLD.
 *
 * ⚠️ THIS WAS TWO POLYGON REFERENCE CALLS, AND IT SUPPLIED THE SCREENER'S ENTIRE IDENTITY LAYER for
 * 15,944 securities: market cap, sector, industry, exchange, asset type, country, shares outstanding,
 * the annual dividend and the issuer name. Every one of those reached Free and Pro users on the
 * Screener and, through screener_meta, on the ticker page. Polygon's redistribution rights for public
 * commercial display were never established, so none of it could stay.
 *
 * ⚠️ WHAT IS GENUINELY SOURCED, AND WHAT IS NOW ABSENT. Honesty about the difference is the point:
 *
 *   sic / sector / industry   SEC's own submissions record, through the SAME sicToMarketSector()
 *                             taxonomy the rest of the product uses. No change in meaning.
 *   name                      SEC's registrant name.
 *   exchange                  SEC's `exchanges` array.
 *   sharesOut                 SEC XBRL dei:EntityCommonStockSharesOutstanding.
 *   marketCap                 DERIVED: sharesOut x the last licensed close. Both inputs approved, so
 *                             the product is too — and it is now a derivation rather than a figure
 *                             taken on trust, which is strictly more auditable.
 *   annualDividend            Tiingo corporate actions, the licensed provider, already used by the
 *                             ticker page's Dividends tab.
 *   country / ipoDate /       NOT SOURCED. SEC's state-of-incorporation is not the same fact as a
 *   assetType                 vendor's `locale`, a registrant record carries no listing date, and
 *                             `type` was a vendor taxonomy. These return null, the columns keep
 *                             whatever an approved source wrote, and the UI shows the em dash it
 *                             already shows for unknowns. Substituting a near-neighbour fact would be
 *                             the same mistake as substituting a vendor.
 */
const SEC_META_UA = { 'User-Agent': 'CatalystPit Research bcoghill88@gmail.com' };

/**
 * The provenance stamped on every screener_meta row this pipeline writes.
 *
 * ⚠️ IT NAMES BOTH INPUTS, because the row is a join of two: SEC's registrant record and the licensed
 * close that turns shares outstanding into a market cap. A value of 'polygon' can never appear here
 * again, and a row with NO source is a pre-audit row of unestablished origin — which the read gate
 * treats as unservable rather than guessing on its behalf.
 */
export const SCREENER_META_SOURCE = 'sec+tiingo';

async function fetchDetail(t, { index = null } = {}) {
  try {
    const idx = index || await secTickerIndex();
    const cik = idx?.get(String(t).toUpperCase());
    if (!cik) return null;                       // not an SEC registrant — nothing approved to say
    const pad = String(cik).padStart(10, '0');

    const [subR, shR] = await Promise.all([
      fetch(`https://data.sec.gov/submissions/CIK${pad}.json`, { headers: SEC_META_UA, cache: 'no-store' }),
      fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${pad}/dei/EntityCommonStockSharesOutstanding.json`,
        { headers: SEC_META_UA, cache: 'no-store' }),
    ]);
    if (!subR.ok) return null;
    const j = await subR.json();

    const sic = parseInt(String(j?.sic ?? ''), 10);
    const sicCode = Number.isFinite(sic) && sic > 0 ? sic : null;

    // Shares outstanding: the most recently reported cover-page figure.
    let sharesOut = null;
    try {
      if (shR.ok) {
        const units = (await shR.json())?.units || {};
        const arr = units.shares || Object.values(units)[0] || [];
        const newest = arr.filter((x) => Number.isFinite(x?.val) && x.val > 0)
          .sort((a, b) => String(a.end || '').localeCompare(String(b.end || '')))
          .pop();
        sharesOut = newest ? newest.val : null;
      }
    } catch { /* an absent cover-page fact is an absent field, not a failure */ }

    // ⚠️ A SHARE COUNT AND A PRICE MUST DESCRIBE THE SAME INSTRUMENT, AND FOR AN ADR THEY DO NOT.
    //
    // This produced a market capitalisation of $11.8 TRILLION for TSM — roughly twice the largest company
    // that has ever existed, and comfortably the most confident-looking wrong number in this whole change.
    // The cause is structural rather than arithmetic: SEC's dei:EntityCommonStockSharesOutstanding reports
    // the registrant's ORDINARY shares, while the US-listed line is an American Depositary Share
    // representing some multiple of them (five, for TSM). Multiplying ordinary shares by the ADS price
    // overstates the result by exactly the depositary ratio, and that ratio appears nowhere in SEC data.
    //
    // A foreign private issuer files 20-F or 40-F rather than 10-K/10-Q, and the form list is already in
    // the submissions payload fetched above — so the guard costs no extra request. Their market cap is
    // left NULL, which the Screener and the ticker page already render as an em dash.
    //
    // ⚠️ AND IT IS A WHITELIST ON THE DOMESTIC FORMS, not a blacklist on the foreign ones. A registrant
    // that files neither is an unknown shape, and an unknown shape should not get a number.
    const recentForms = new Set(j?.filings?.recent?.form || []);
    const filesDomestic = recentForms.has('10-K') || recentForms.has('10-Q');
    const filesForeign = recentForms.has('20-F') || recentForms.has('40-F');

    // Market cap from the last LICENSED close. A Polygon row still on disk must not sneak in here.
    let marketCap = null;
    if (sharesOut > 0 && filesDomestic && !filesForeign) {
      const px = await db.execute(sql`
        select close from ticker_daily_candles
         where ticker = ${t} and source = any(${sql.raw(LICENSED_CANDLE_SOURCES_SQL)})
         order by date desc limit 1`);
      const close = Number((px.rows ?? px)[0]?.close);
      if (Number.isFinite(close) && close > 0) marketCap = sharesOut * close;
    }

    // Trailing annual dividend from the licensed provider's corporate actions.
    let annualDividend = null;
    try {
      const { getCorporateActions } = await import('./market/tiingo.mjs');
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
      const ca = await getCorporateActions(t, { from, to });
      if (ca?.ok) {
        const paid = (ca.dividends || []).filter((d) => Number(d.amount) > 0);
        if (paid.length) annualDividend = +paid.reduce((s, d) => s + Number(d.amount), 0).toFixed(6);
      }
    } catch { /* no licensed dividend history → null, never a guess */ }

    const exchange = Array.isArray(j?.exchanges) && j.exchanges.length ? String(j.exchanges[0]).toUpperCase() : null;

    return {
      ticker: t,
      marketCap,
      // ⚠️ THE CODE IS RETAINED, NOT JUST THE DERIVED SECTOR. The classification used to be decided
      // once at ingest with its source discarded, so when the mapping turned out to be wrong — TSLA in
      // Industrials, PG in Basic Materials, PLD in Financial Services — there was nothing left to
      // reclassify FROM. Keeping sic_code makes the sector a DERIVATION that can be replayed.
      sicCode,
      sector: sicCode ? sicToMarketSector(sicCode) : null,
      industry: j?.sicDescription || null,
      exchange,
      assetType: null,
      country: null,
      sharesOut,
      annualDividend,
      ipoDate: null,
      name: typeof j?.name === 'string' && j.name.trim() ? j.name.trim() : null,
    };
  } catch { return null; }
}

// Populate screener_meta from SEC registrant data plus licensed prices. Bounded per run, prioritized
// by volume, skips rows refreshed within staleDays — so it accumulates full coverage over a few runs.
//
// ⚠️ SEC RATE-LIMITS TO 10 REQUESTS A SECOND and asks for an identifying agent, so the concurrency
// that was sized for a vendor with no published limit is lowered here. fetchDetail makes two SEC
// requests per ticker, so 4 in flight is ~8/s at worst.
export async function backfillMeta({ cap = 6000, concurrency = 4, staleDays = 14, force = false, only = null } = {}) {
  await ensureScreenerTables();
  let uni = await db.select({ t: screenerStocks.ticker, vol: screenerStocks.volume }).from(screenerStocks);
  // `only` narrows the run to named tickers. Added for the security-master backfill: the vendor's
  // name field is the only source that knows ETFs, and we had been discarding it, so the rows that
  // needed re-fetching were a known 2,700 rather than the whole universe.
  if (only?.length) {
    const want = new Set(only.map((t) => String(t).toUpperCase()));
    uni = uni.filter((r) => want.has(String(r.t).toUpperCase()));
  }
  const have = new Map((await db.select({ t: screenerMeta.ticker, u: screenerMeta.updatedAt }).from(screenerMeta)).map((r) => [r.t, r.u]));
  const cutoff = Date.now() - staleDays * 86400000;
  // force = re-fetch everything (to backfill newly-added fields), oldest/never-fetched first so
  // successive runs advance through the universe. Normal = only stale, prioritized by volume.
  const need = (force
    ? uni.slice().sort((a, b) => (have.get(a.t) ? new Date(have.get(a.t)).getTime() : 0) - (have.get(b.t) ? new Date(have.get(b.t)).getTime() : 0))
    : uni.filter((r) => { const u = have.get(r.t); return !u || new Date(u).getTime() < cutoff; }).sort((a, b) => (b.vol || 0) - (a.vol || 0))
  ).slice(0, cap).map((r) => r.t);

  // ⚠️ SEC UNREACHABLE MEANS WRITE NOTHING, NOT WRITE NULLS. Without the ticker→CIK index every
  // fetchDetail would return null and the run would blank the reference data for the whole universe —
  // a transient outage turning into a wave of "unknown" sectors. Bail instead.
  const secIndex = await secTickerIndex();
  if (!secIndex) return { error: 'SEC ticker index unavailable — nothing written' };

  const rows = [];
  for (let i = 0; i < need.length; i += concurrency) {
    // ⚠️ THE SEC TICKER INDEX IS RESOLVED ONCE AND PASSED IN. .map(fetchDetail) handed the array
    // INDEX to the second parameter, which was harmless only because the helper memoises the index
    // internally. Being explicit costs nothing and removes the trap.
    const got = await Promise.all(need.slice(i, i + concurrency).map((t) => fetchDetail(t, { index: secIndex })));
    // Every row written here is SEC-sourced plus a licensed close, so it earns a provenance.
    got.forEach((d) => { if (d) rows.push({ ...d, source: SCREENER_META_SOURCE, updatedAt: new Date() }); });
  }
  let saved = 0;
  for (let i = 0; i < rows.length; i += 300) {
    const batch = rows.slice(i, i + 300);
    await db.insert(screenerMeta).values(batch).onConflictDoUpdate({
      target: screenerMeta.ticker,
      set: { marketCap: sql`excluded.market_cap`, sector: sql`excluded.sector`, industry: sql`excluded.industry`, sicCode: sql`excluded.sic_code`, exchange: sql`excluded.exchange`, assetType: sql`excluded.asset_type`, country: sql`excluded.country`, sharesOut: sql`excluded.shares_out`, annualDividend: sql`excluded.annual_dividend`, ipoDate: sql`excluded.ipo_date`, name: sql`coalesce(excluded.name, screener_meta.name)`, source: sql`excluded.source`, updatedAt: sql`now()` },
    });
    saved += batch.length;
  }

  // ⚠️ THE SEC FALLBACK, AND IT WRITES TO screener_meta BECAUSE THAT IS THE DURABLE TABLE.
  //
  // Polygon supplies no sic_code for foreign private issuers, which left 113 of the Top 500 with a
  // null sector — TSM, HSBC, BABA, SAP, BP, NVS, SAN, SONY, UBS, ING, BHP. They are not missing
  // data: they file 20-F and EDGAR assigns them a SIC like any other filer. So where the vendor
  // returned nothing, SEC is asked.
  //
  // ⚠️ screener_meta, NOT screener_stocks. The previous attempt at this lived in a one-off script
  // that wrote to screener_stocks — a table rebuildScreener() DELETEs nightly and repopulates FROM
  // screener_meta, so every repair it made was erased at 08:30 UTC and nothing reported it. Writing
  // here makes the recovery survive the rebuild by construction, and puts it on the same cron that
  // already maintains the rest of the metadata, so new listings are covered without a second job.
  //
  // Bounded to the rows in THIS run that came back without a SIC, so it costs nothing once coverage
  // is established: a steady-state run resolves zero.
  let secResolved = 0;
  try {
    const missing = rows.filter((r) => !Number.isFinite(r.sicCode)).map((r) => r.ticker);
    if (missing.length) {
      const found = await resolveClassifications(missing);
      for (const [ticker, c] of found) {
        // ⚠️ coalesce ON THE EXISTING ROW, never a blind overwrite. If Polygon later starts
        // supplying a code, this must not clobber it, and a null from SEC must not erase a good
        // value — the map only contains tickers SEC could actually classify, and the write only
        // fills what is empty.
        await db.execute(sql`
          update screener_meta
             set sic_code = coalesce(sic_code, ${c.sicCode}),
                 sector   = coalesce(nullif(trim(sector), ''), ${c.sector}),
                 industry = coalesce(nullif(trim(industry), ''), ${c.industry}),
                 updated_at = now()
           where ticker = ${ticker}`);
        if (c.sector) secResolved += 1;
      }
    }
  } catch (e) {
    // A SEC outage is missing classification, not wrong classification. Logged, never fatal — the
    // Polygon-derived metadata this function exists for has already been saved above.
    console.log(`[screener-meta] SEC classification fallback skipped: ${e.message}`);
  }

  return { requested: need.length, fetched: rows.length, saved, secResolved };
}

// Backfill technicals market-wide from our own LICENSED daily candles. Pulls `days` trading days,
// computes RSI/SMA/52w/ATR/perf in memory (universe tickers only), writes the technical columns to
// screener_stocks. Idempotent; run after the main rebuild.
//
// ⚠️ EVERY ONE OF THESE INDICATORS WAS POLYGON-DERIVED, AND THAT IS THE POINT OF THIS SECTION. The
// inputs came from ~260 Polygon grouped-daily calls plus two more for the 3y/5y anchors, so RSI, the
// moving averages, the 52-week range, ATR, every performance column, volatility, beta, the
// distance-from-high figures and the candlestick/pattern labels were all restatements of unlicensed
// data. A metric is not licensing-safe because we calculated it; it inherits its inputs.
//
// The arithmetic below is UNCHANGED. Only the source of the bars changed: ticker_daily_candles,
// filtered to licensed rows. That also removes ~262 vendor requests per run.
export async function backfillTechnicals({ days = 260 } = {}) {
  await ensureScreenerTables();
  const uni = new Set((await db.select({ t: screenerStocks.ticker }).from(screenerStocks)).map((r) => r.t));
  if (!uni.size) return { error: 'empty universe. Run the main rebuild first' };

  const now = new Date();
  const series = new Map();   // ticker -> chronological [{close,high,low,date}]
  const spy = [];             // SPY chronological closes (market proxy for beta)
  let gotDays = 0;
  // CALENDAR DAYS TO WALK BACK FOR `days` TRADING DAYS. The old bound was days + 30, which assumed
  // roughly 30 non-trading days in any window. The real ratio is about 30% — weekends alone are
  // 28.6% — so asking for 150 delivered 123, measured, and every indicator with a longer lookback
  // than that silently returned null for the whole market: perf_6m needs 127 closes and had 0.6%
  // coverage, missing by four.
  //
  // 252 trading days per 365 calendar days is the standard ratio; 1.5 plus a small constant absorbs
  // holiday clusters. This costs nothing when the data is there, because the loop stops the moment
  // gotDays reaches days — it only spends the extra iterations when a window really is sparse.
  const calendarBudget = Math.ceil(days * 1.5) + 10;
  // ⚠️ READ IN TICKER CHUNKS, NOT IN ONE STATEMENT. The window is ~260 sessions across an 18,000-name
  // universe, which is a couple of million rows; materialising that in one result set is how a 300s
  // function runs out of memory instead of finishing. Chunking keeps each result a few hundred
  // thousand rows and costs ~36 indexed queries.
  const windowFrom = ymd(new Date(now.getTime() - calendarBudget * 86400000));
  const unis = [...uni];
  const CHUNK = 500;
  for (let i = 0; i < unis.length; i += CHUNK) {
    const part = unis.slice(i, i + CHUNK);
    const res = await db.execute(sql`
      select ticker, date::text as date, open, high, low, close
        from ticker_daily_candles
       where source = any(${sql.raw(LICENSED_CANDLE_SOURCES_SQL)})
         and ticker = any(${sql.raw(textArrayLiteral(part))})
         and date >= ${windowFrom}::date
       order by ticker, date desc`);
    for (const r of (res.rows ?? res)) {
      if (r.close == null) continue;
      const a = series.get(r.ticker) || [];
      // Newest→oldest, matching what the compute below expects before it reverses.
      a.push({ open: Number(r.open), close: Number(r.close), high: Number(r.high), low: Number(r.low), date: r.date });
      series.set(r.ticker, a);
    }
  }
  // SPY is the market proxy for beta and is fetched on its own because it need not be in the universe.
  {
    const res = await db.execute(sql`
      select date::text as date, close from ticker_daily_candles
       where source = any(${sql.raw(LICENSED_CANDLE_SOURCES_SQL)}) and ticker = 'SPY' and date >= ${windowFrom}::date
       order by date asc`);
    for (const r of (res.rows ?? res)) if (r.close != null) spy.push(Number(r.close));   // chronological
  }
  gotDays = spy.length;

  // SPY daily returns (chronological) for beta.
  const spyRet = [];
  for (let i = 1; i < spy.length; i++) if (spy[i - 1] > 0) spyRet.push(spy[i] / spy[i - 1] - 1);
  const spyVar = variance(spyRet);
  const yearStart = `${now.getUTCFullYear()}-01-01`;

  // Perf 3Y/5Y anchors: the first licensed close on or after the anniversary, per ticker. This was two
  // Polygon grouped snapshots; it is now one indexed query over history we already hold, which also
  // fixes a smaller problem — a grouped snapshot on a single historical date missed any security that
  // did not trade that day, and `distinct on` picks the nearest available session instead.
  async function closesAgo(yearsBack) {
    const anchor = new Date(now); anchor.setUTCFullYear(now.getUTCFullYear() - yearsBack);
    const from = ymd(anchor);
    const to = ymd(new Date(anchor.getTime() + 10 * 86400000));
    const out = new Map();
    for (let i = 0; i < unis.length; i += CHUNK) {
      const part = unis.slice(i, i + CHUNK);
      const res = await db.execute(sql`
        select distinct on (ticker) ticker, close from ticker_daily_candles
         where source = any(${sql.raw(LICENSED_CANDLE_SOURCES_SQL)}) and ticker = any(${sql.raw(textArrayLiteral(part))})
           and date >= ${from}::date and date <= ${to}::date
         order by ticker, date asc`);
      for (const r of (res.rows ?? res)) if (r.close != null) out.set(r.ticker, Number(r.close));
    }
    return out;
  }
  const close3y = await closesAgo(3);
  const close5y = await closesAgo(5);

  const rowsT = [];
  for (const [t, revArr] of series) {
    if (revArr.length < 2) continue;
    const arr = revArr.slice().reverse();            // chronological (oldest→newest)
    const closes = arr.map((a) => a.close);
    const last = closes[closes.length - 1];
    const yr = closes.slice(-252);
    const rets = [];
    for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
    const maxN = (n) => { const w = closes.slice(-n); return w.length ? Math.max(...w) : null; };
    const ytdBase = arr.find((a) => a.date >= yearStart)?.close ?? null;
    rowsT.push({
      ticker: t,
      rsi14: rsi(closes), sma20: smaN(closes, 20), sma50: smaN(closes, 50), sma200: smaN(closes, 200),
      hi52: yr.length ? Math.max(...yr) : null, lo52: yr.length ? Math.min(...yr) : null, atr14: atr(arr),
      perf1w: perf(closes, 5), perf1m: perf(closes, 21), perf3m: perf(closes, 63), perf6m: perf(closes, 126), perf1y: perf(closes, 252),
      perfYtd: (ytdBase > 0) ? (last / ytdBase - 1) * 100 : null,
      perf3y: (close3y.get(t) > 0) ? (last / close3y.get(t) - 1) * 100 : null,
      perf5y: (close5y.get(t) > 0) ? (last / close5y.get(t) - 1) * 100 : null,
      volatility: rets.length ? stddev(rets) * Math.sqrt(252) * 100 : null,   // annualized %
      beta: (spyVar > 0) ? beta(rets, spyRet, spyVar) : null,
      // % from N-day high (0 = at high, negative = below) — Finviz-style distance-from-high
      high20d: (maxN(20) > 0) ? (last / maxN(20) - 1) * 100 : null,
      high50d: (maxN(50) > 0) ? (last / maxN(50) - 1) * 100 : null,
      allTimeHigh: closes.length ? (last / Math.max(...closes) - 1) * 100 : null,
      candlestick: detectCandle(arr[arr.length - 1], arr[arr.length - 2]),
      pattern: detectPattern(arr),
    });
  }
  let updated = 0;
  for (let i = 0; i < rowsT.length; i += 300) {
    const batch = rowsT.slice(i, i + 300);
    await db.insert(screenerStocks).values(batch).onConflictDoUpdate({
      target: screenerStocks.ticker,
      set: {
        rsi14: sql`excluded.rsi14`, sma20: sql`excluded.sma20`, sma50: sql`excluded.sma50`, sma200: sql`excluded.sma200`,
        hi52: sql`excluded.hi52`, lo52: sql`excluded.lo52`, atr14: sql`excluded.atr14`,
        perf1w: sql`excluded.perf_1w`, perf1m: sql`excluded.perf_1m`, perf3m: sql`excluded.perf_3m`, perf6m: sql`excluded.perf_6m`, perf1y: sql`excluded.perf_1y`,
        perfYtd: sql`excluded.perf_ytd`, perf3y: sql`excluded.perf_3y`, perf5y: sql`excluded.perf_5y`,
        volatility: sql`excluded.volatility`, beta: sql`excluded.beta`,
        high20d: sql`excluded.high20d`, high50d: sql`excluded.high50d`, allTimeHigh: sql`excluded.all_time_high`,
        candlestick: sql`excluded.candlestick`, pattern: sql`excluded.pattern`,
      },
    });
    updated += batch.length;
  }
  return { days: gotDays, tickers: updated };
}

// ── stats helpers for volatility/beta ──
const variance = (a) => { if (a.length < 2) return 0; const m = a.reduce((s, x) => s + x, 0) / a.length; return a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length; };
const stddev = (a) => Math.sqrt(variance(a));
function beta(rets, spyRet, spyVar) {
  const n = Math.min(rets.length, spyRet.length);
  if (n < 20 || !spyVar) return null;
  const r = rets.slice(-n), m = spyRet.slice(-n);
  const rm = r.reduce((s, x) => s + x, 0) / n, mm = m.reduce((s, x) => s + x, 0) / n;
  let cov = 0; for (let i = 0; i < n; i++) cov += (r[i] - rm) * (m[i] - mm);
  return (cov / n) / spyVar;
}

// ── technical helpers (operate on chronological arrays) ──
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const smaN = (closes, n) => closes.length >= n ? mean(closes.slice(-n)) : null;
function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  const ag = g / n, al = l / n;
  if (al === 0) return 100;
  const rs = ag / al;
  return 100 - 100 / (1 + rs);
}
function atr(candles, n = 14) {
  if (candles.length < n + 1) return null;
  const trs = [];
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return mean(trs);
}
const perf = (closes, back) => closes.length > back ? ((closes[closes.length - 1] / closes[closes.length - 1 - back]) - 1) * 100 : null;

// ── candlestick detection (last candle; engulfing needs the prior candle) ──
function detectCandle(cur, prev) {
  if (!cur || cur.open == null || cur.close == null || cur.high == null || cur.low == null) return null;
  const range = cur.high - cur.low; if (!(range > 0)) return null;
  if (prev && prev.open != null) {
    const pBull = prev.close > prev.open, pBear = prev.close < prev.open;
    const cBull = cur.close > cur.open, cBear = cur.close < cur.open;
    if (cBull && pBear && cur.open <= prev.close && cur.close >= prev.open) return 'Engulfing';
    if (cBear && pBull && cur.open >= prev.close && cur.close <= prev.open) return 'Engulfing';
  }
  const body = Math.abs(cur.close - cur.open);
  const upper = cur.high - Math.max(cur.open, cur.close);
  const lower = Math.min(cur.open, cur.close) - cur.low;
  if (body <= range * 0.1) return 'Doji';
  if (body >= range * 0.9) return 'Marubozu';
  if (lower >= body * 2 && upper <= body * 0.6) return 'Hammer';
  if (upper >= body * 2 && lower <= body * 0.6) return 'Shooting Star';
  return null;
}

// least-squares fit over x = 0..n-1 → { slope, r2 }
function linReg(ys) {
  const n = ys.length; if (n < 2) return { slope: 0, r2: 0 };
  const xm = (n - 1) / 2, ym = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = i - xm, dy = ys[i] - ym; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return { slope: sxx ? sxy / sxx : 0, r2: (sxx && syy) ? (sxy * sxy) / (sxx * syy) : 0 };
}

// ── chart-pattern heuristic over the last ~40 sessions (conservative; tags only on clear signals) ──
function detectPattern(arr) {
  const w = arr.slice(-40); if (w.length < 20) return null;
  const closes = w.map((a) => a.close), highs = w.map((a) => a.high), lows = w.map((a) => a.low);
  const last = closes[closes.length - 1]; if (!(last > 0)) return null;
  const { slope, r2 } = linReg(closes);
  const drift = (slope * closes.length) / last;   // total trend move over window, as % of price
  if (r2 >= 0.6) {                                 // clean linear channel
    if (drift > 0.05) return 'Channel Up';
    if (drift < -0.05) return 'Channel Down';
  }
  // Double top/bottom: matched extremes in each half, reversal off them
  const half = Math.floor(w.length / 2);
  const max1 = Math.max(...highs.slice(0, half)), max2 = Math.max(...highs.slice(half));
  const min1 = Math.min(...lows.slice(0, half)), min2 = Math.min(...lows.slice(half));
  const mid = lows.slice(Math.floor(w.length * 0.3), Math.floor(w.length * 0.7));
  const trough = mid.length ? Math.min(...mid) : last;
  if (Math.abs(max1 - max2) / Math.max(max1, max2) < 0.03 && trough < Math.max(max1, max2) * 0.93 && last < Math.max(max1, max2) * 0.98) return 'Double Top';
  if (Math.abs(min1 - min2) / Math.max(min1, min2) < 0.03 && last > Math.min(min1, min2) * 1.02) return 'Double Bottom';
  // Converging range → Triangle (lower highs + higher lows)
  const hi = linReg(highs), lo = linReg(lows);
  if (hi.slope < 0 && lo.slope > 0) return 'Triangle';
  return null;
}

const WINDOW = 90;
// ⚠️ THE FINNHUB KEY BINDING IS GONE WITH THE FALLBACK IT POWERED. See step 5 in rebuildScreener
// for what that fallback did and why chaining two unlicensed providers was the worst shape it could
// have taken.
const MAX_QUOTES = 180;                        // live-quote fetches/run (stay under Finnhub 60/min)
const KV_READ_CAP = 3000;                      // how many prioritized tickers to price from the KV cache
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared quote cache (same key/shape as /api/ticker + /api/watchlist) → prices persist across the
// screener's nightly clean-rebuild and are reused from anywhere a ticker was quoted.
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const qKey = (s) => `catalystpit:ticker:${s}:quote`;
async function kvGetQuote(t) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(qKey(t))}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.result) return null;
    const q = JSON.parse(d.result);
    return (q && q.c) ? { price: q.c, changePct: q.dp ?? null } : null;
  } catch { return null; }
}
async function kvSetQuote(t, q) {
  if (!KV_URL || !KV_TOKEN) return;
  try { await fetch(`${KV_URL}/set/${encodeURIComponent(qKey(t))}?ex=86400`, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' }, body: JSON.stringify(q) }); } catch { /* non-fatal */ }
}

// ── LICENSED EOD: the last two sessions, read from our own candle table. ────────────────────────
//
// ⚠️ THIS WAS POLYGON'S GROUPED-DAILY ENDPOINT, AND IT WAS THE PRODUCT'S LARGEST LICENSING EXPOSURE.
// One call returned OHLCV for the whole US market, which is why it was used — and Polygon's
// redistribution rights for public commercial display were never established. It supplied the
// Screener's price, volume and change columns for 18,052 securities, discovered the universe itself,
// and wrote 2.8 million rows into ticker_daily_candles that forty other files then read.
//
// It is replaced by a read, not by another vendor. ticker_daily_candles is now rebuilt from Tiingo
// (scripts/backfill-licensed-candles.mjs), so the last two sessions already hold everything this
// function needs: close, open, volume and the previous close. The nightly rebuild therefore makes NO
// market-data vendor request at all, which is both licensing-safe and strictly cheaper.
//
// ⚠️ AND IT READS ONLY LICENSED ROWS. The source filter is the whole point: a Polygon row still on
// disk must not re-enter the Screener through the back door while it waits to be replaced.
const ymd = (d) => d.toISOString().slice(0, 10);

async function licensedEod() {
  // The two most recent sessions that exist in licensed candles — walking the calendar is
  // unnecessary when the table knows which days it has.
  const ds = await db.execute(sql`
    select distinct date::text as date from ticker_daily_candles
     where source = any(${sql.raw(LICENSED_CANDLE_SOURCES_SQL)}) order by date desc limit 2`);
  const dates = (ds.rows ?? ds).map((r) => r.date);
  if (!dates.length) return null;

  const rows = await db.execute(sql`
    select ticker, date::text as date, open, high, low, close, volume
      from ticker_daily_candles
     where source = any(${sql.raw(LICENSED_CANDLE_SOURCES_SQL)}) and date::text = any(${sql.raw(textArrayLiteral(dates))})`);

  const latest = dates[0], prev = dates[1] || null;
  const prevClose = new Map();
  const today = new Map();
  for (const r of (rows.rows ?? rows)) {
    if (r.date === prev) prevClose.set(r.ticker, Number(r.close));
    else if (r.date === latest) today.set(r.ticker, r);
  }
  if (!today.size) return null;

  const map = new Map();
  for (const [t, x] of today) {
    const c = Number(x.close), o = Number(x.open), v = Number(x.volume);
    const pc = prevClose.get(t);
    map.set(t, {
      price: c, open: o, volume: v,
      changePct: (pc && pc > 0) ? ((c - pc) / pc) * 100 : null,
      changeFromOpen: (o && o > 0 && c != null) ? ((c - o) / o) * 100 : null,
      gap: (pc && pc > 0 && o != null) ? ((o - pc) / pc) * 100 : null,
    });
  }
  // ⚠️ NO `res`. That field existed only so the rebuild could write today's vendor bars into
  // ticker_daily_candles; the candle table is now the INPUT here rather than the output, and the
  // Tiingo rebuild owns the writes. Returning it would invite a writer back.
  return { date: latest, map };
}

// 8-K item code → screener News Category (mirrors eightk.js ITEM_MAP groupings). First match wins.
const EIGHTK_CAT = {
  '2.02': 'Earnings', '7.01': 'Guidance',
  '1.01': 'Contract', '2.01': 'M&A', '5.01': 'M&A',
  '3.02': 'Offering', '2.03': 'Debt', '2.04': 'Debt',
  '2.05': 'Impairment', '2.06': 'Impairment',
  '5.02': 'Management Change', '1.03': 'Bankruptcy', '3.01': 'Delisting',
  '1.05': 'Cybersecurity', '4.02': 'Restatement', '4.01': 'Auditor Change',
};
function eightkCategory(itemsCsv) {
  const codes = String(itemsCsv || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  for (const c of codes) if (EIGHTK_CAT[c]) return EIGHTK_CAT[c];
  return codes.length ? 'Other' : null;
}

// A "clean" common-stock symbol: 1–5 letters, no suffix (drops warrants/units/preferred/rights).
const CLEAN_SYM = /^[A-Z]{1,5}$/;
const MIN_LIQUID_VOL = 50000;   // FINRA breadth floor: skip dead/thin names (signal tickers bypass)

// CANONICAL COMPANY IDENTITY — now read from the security master, not derived here.
//
// screener_stocks.company must hold a trustworthy issuer name or NOTHING. It previously fell back to
// the SIC industry description when no name was at hand, which put "PHARMACEUTICAL PREPARATIONS"
// under ZTS, "PETROLEUM REFINING" under XOM and "RADIO BROADCASTING STATIONS" under SIRI — 2,805
// rows, 49% of every populated value. A page titled with an industry is a false fact about a real
// company; a page with no name is merely a page with no name. That rule is unchanged and is now
// enforced inside the resolver.
//
// WHAT CHANGED, AND WHY. The hierarchy used to be Form 4 issuer name, then 8-K registrant name, then
// null — SEC filings only, derived right here. Right about quality, wrong about COVERAGE: a security
// that files neither form has no name at all, and that is every closed-end fund, ETF, ADR, preferred
// line and unit trust. 3,343 covered tickers had no name, and the Dividend Calendar — largely a
// board of funds — printed "—" for all of them while SEC's own ticker file named them.
//
// Identity is a question several parts of the product ask, so it is answered in ONE place with a
// stated precedence (security-identity.mjs) and read here. 13F issuer names and FINRA security names
// remain deliberately excluded, for the reasons recorded there.
async function companyIdentity() {
  // The master, when it has been built. Falls through to the original derivation below on a fresh
  // database, so a first run still names everything it previously could rather than nothing.
  const master = await readSecurityIdentity();
  if (master) return master;
  console.log('[screener] security_identity empty — deriving names from filings inline');
  return companyIdentityFromFilings();
}

/**
 * The original filings-only derivation, kept for the window before the master has been built.
 *
 * It now shares the master's per-ticker resolver rather than using `distinct on`, because
 * `distinct on (ticker) order by filing_date desc` is not a TOTAL order and the ties are not
 * hypothetical: VKI had three Form 4 rows on one date, two naming the issuer and one naming a 10%
 * holder that had filed against it, and Postgres picked the holder — "BANK OF AMERICA CORP /DE/"
 * printed on an Invesco municipal trust. See resolveFilerName for how the tie is broken.
 */
async function companyIdentityFromFilings() {
  const [form4, registrant] = await Promise.all([
    filerNameMap(sql`insider_trades`, sql`filing_date`),
    filerNameMap(sql`eightk_filings`, sql`filed_at`),
  ]);
  const byTicker = new Map(form4);
  for (const [t, n] of registrant) if (!byTicker.has(t)) byTicker.set(t, n);   // Form 4 outranks registrant
  return byTicker;
}

export async function rebuildScreener({ maxCandleTickers = 2500 } = {}) {
  await ensureScreenerTables();
  // IDENTITY FIRST, so the rebuild's company column is filled from the freshly-resolved master.
  // Wrapped: identity is an improvement to the rebuild, never a precondition for it, and a bad night
  // at SEC must not cost us the nightly screener.
  try {
    const id = await refreshSecurityIdentity();
    console.log(`[screener] security identity: ${JSON.stringify(id)}`);
  } catch (e) {
    console.log(`[screener] security identity refresh failed, using the stored master: ${e.message}`);
  }
  const runTs = new Date();     // rows written this run get this exact stamp; stale rows are pruned
  const since90 = sql`current_date - make_interval(days => ${WINDOW})`;

  // 1) Proprietary aggregates (bulk, one query each).
  const insRows = await db.select({
    ticker: insiderTrades.ticker,
    net: sql`sum(case when ${insiderTrades.action}='BUY' then ${insiderTrades.totalValue} else -${insiderTrades.totalValue} end)`.mapWith(Number),
    buyers: sql`count(distinct case when ${insiderTrades.action}='BUY' then ${insiderTrades.executive} end)`.mapWith(Number),
    buy: sql`bool_or(${insiderTrades.action}='BUY')`,
    sell: sql`bool_or(${insiderTrades.action}='SELL')`,
    // NO company HERE. Identity used to be read off this aggregate, which is scoped to the 90-day,
    // value>0 SIGNAL window — so a company whose last Form 4 predated the window contributed no name
    // and fell through to an SIC description. See companyIdentity() for the all-history lookup.
    // Widening this query instead would have silently widened every insider signal with it.
  }).from(insiderTrades).where(and(gte(insiderTrades.transactionDate, since90), sql`${insiderTrades.totalValue} > 0`, sql`insider_trades.superseded_by IS NULL`)).groupBy(insiderTrades.ticker);

  const conRows = await db.select({
    ticker: congressTrades.ticker,
    net: sql`sum(case when ${congressTrades.action}='BUY' then ${congressTrades.amountMid} else -${congressTrades.amountMid} end)`.mapWith(Number),
    buy: sql`bool_or(${congressTrades.action}='BUY')`,
  }).from(congressTrades).where(and(gte(congressTrades.transactionDate, since90), isNotNull(congressTrades.ticker))).groupBy(congressTrades.ticker);

  // 13F QoQ net (latest 2 quarters) — mirrors the confluence fund logic.
  const qRows = await db.select({ q: fundFilings.quarter }).from(fundFilings).groupBy(fundFilings.quarter).orderBy(desc(fundFilings.quarter)).limit(2);
  const [q0, q1] = qRows.map((r) => r.q);
  // THE SAME RULE, COMPUTED WHERE THE ROWS ALREADY ARE.
  //
  // This used to pull both quarters of holdings into memory — every row, four columns — and fold them
  // in JS. On 2026-09-13 that stopped working and took the whole nightly rebuild with it: the window
  // had grown to 2,702,527 rows (~82 MB) and Neon's HTTP endpoint refuses a response over 64 MB with
  // HTTP 507. Nothing in the code changed; institutional ingestion simply backfilled 1.85M rows and
  // the query crossed the ceiling. It fails identically on Vercel, so the screener froze on its
  // 2026-09-12 08:30 rebuild and every run since was a no-op.
  //
  // THE SCORING IS UNCHANGED, DELIBERATELY AND PROVABLY. `array_agg(shares order by id desc)[1]` is
  // the row the JS loop kept last, because the loop overwrote on every row and the read came back in
  // id order — so this picks the same share count, per (ticker, cik), per quarter, and compares them
  // the same way. It invents no aggregation policy: summing or maxing the duplicate rows would each
  // be a different answer, and choosing between them needs the 26,537 duplicate groups understood
  // first (they are mostly several DIFFERENT securities sharing one ticker, not components of one
  // position). Verified against the previous algorithm across all 14,366 tickers: zero differences.
  //
  // 2,702,527 rows transferred becomes 14,366, and 25s becomes 6s.
  const fundNet = new Map();
  if (q0) {
    // When only one quarter exists, prevQ is null: `quarter = NULL` is never true, so the filter
    // matches nothing, prev stays 0 and every holder scores +1 — exactly what the old
    // `[q0, q1].filter(Boolean)` produced. The null carries the same meaning in the WHERE clause.
    const prevQ = q1 ?? null;
    const rows = await db.execute(sql`
      -- 1. THE SECURITY THE TICKER NAMES. Filers report far more against an issuer than the one line
      --    a ticker stands for: MSTR's filers report four convertible-note CUSIPs beside the common
      --    stock, and a note's shares column is FACE VALUE (1,972,000 of principal), so adding it
      --    to 564,358 common shares produces a number that means nothing.
      --
      --    security_position_class already classifies every position from the filing's own evidence.
      --    It is applied ONLY to a CUSIP that is not the ticker's own, and that restriction is
      --    load-bearing. Filers describe a bond ETF with bond words — BSV's own CUSIP carries
      --    "SHORT TRM BOND" on 3,147 rows and "ETF" on 392 — so classifying positions in isolation
      --    deleted BSV, VCSH, GOVT and VGIT outright, and resolving each CUSIP to its majority
      --    verdict deleted them too. Measured: SGOV is ONE CUSIP classified four different ways
      --    depending on whether a filer wrote "0-3 MNTH TREASRY" or "0-3 MTH TREASURY", which made
      --    inclusion depend on spelling.
      --
      --    The primary CUSIP is the one carrying the most positions for the ticker. It only ever
      --    PROTECTS a security from exclusion; it never assigns a ticker to one, so it does not
      --    touch the separate cross-issuer mapping defect.
      with primary_cusip as (
        select distinct on (ticker) ticker, cusip
          from (select h.ticker, h.cusip, count(*)::int c
                  from fund_holdings h
                 where (h.quarter = ${q0} or h.quarter = ${prevQ})
                   and h.ticker is not null and h.put_call = ''
                 group by h.ticker, h.cusip) z
         order by ticker, c desc, cusip
      ),
      -- 1b. THE ONE HOLE IN THE PRIMARY-CUSIP PROTECTION. Rule 1 protects the ticker's own CUSIP
      --     from exclusion, which is what keeps the bond ETFs alive. But an OPTION on that same
      --     security is often filed against the underlying's CUSIP, and 1,161 such rows carry a
      --     BLANK put_call, so the put_call filter lets them in and the protection then shields
      --     them. SPY scored 9 option lines as share positions, NVDA 6, AAPL 3.
      --
      --     The evidence used is the filers' own disagreement, not a new class regex. A security
      --     that MOST filers report with an explicit put_call is a derivative; a blank put_call on
      --     that same (cusip, class) is one filer omitting the field, not an equity position.
      --     Measured over the window this matches 1,457 pairs and the only class strings it ever
      --     selects are PUT and CALL.
      --
      --     Deliberately a majority test rather than "any filer labelled it". 84 of QQQE's own
      --     holdings share a (cusip, class) with 13 option lines, and 51 of HYGH's with one, so
      --     presence alone would have deleted real ETF positions. The majority never does: the
      --     excluded set is 64 rows on 29 tickers, all of kind option, and it touches no bond ETF
      --     (BSV, VCSH, GOVT, VGIT), no rate-hedged or equal-weight fund whose name the classifier
      --     misreads as a right or a warrant (TFLO, LQDH, IGHG, IGBH, IVOL, QQQE, KLIP), and no
      --     ticker that IS a warrant or a right (OXY.WS, GME.WS, OPENW, XRXDW, GENVR).
      mislabelled_option as (
        select f.cusip, f.class
          from fund_holdings f
          join security_position_class s
            on s.cusip = f.cusip and s.cls = f.class and s.put_call = ''
         where (f.quarter = ${q0} or f.quarter = ${prevQ})
           and s.kind in ('option', 'warrant', 'right')
         group by f.cusip, f.class
        having count(*) filter (where coalesce(f.put_call, '') <> '')
             > count(*) filter (where coalesce(f.put_call, '') = '')
      ),
      scoped as (
        select h.ticker, h.cik, h.quarter, h.cusip, h.class, h.shares, h.accession, h.filed_date
          from fund_holdings h
          left join primary_cusip p on p.ticker = h.ticker
          left join security_position_class s
            on s.cusip = h.cusip and s.cls = h.class and s.put_call = h.put_call
          left join mislabelled_option m on m.cusip = h.cusip and m.class = h.class
         where (h.quarter = ${q0} or h.quarter = ${prevQ})
           and h.ticker is not null and h.put_call = ''
           -- a derivative most filers label as one is never a share position, whose CUSIP it sits on
           and m.cusip is null
           -- the ticker's own security always counts; anything else must not be debt or a derivative
           and (h.cusip = p.cusip
                or s.kind is null
                or s.kind not in ('debt', 'option', 'warrant', 'right', 'preferred'))
      ),
      -- 2. AMENDMENTS. A 13F-HR/A restates the securities it re-lists, so an original and its
      --    amendment must not both contribute. The LATEST filing wins — filed_date then accession,
      --    both descending, so the answer never depends on physical row order. Choosing the FILING and
      --    then taking its rows, rather than ranking rows, is what keeps a filing whole.
      --
      --    ⚠️ PER POSITION, WHICH INCLUDES class. This deduped on (cik, quarter, cusip) and then kept
      --    only the winning accession's rows, so a CUSIP carrying two share classes reported by two
      --    accessions of one quarter lost a real position — and since per_security below sums classes
      --    together, the loss landed silently in the net. 3,324 groups in the live corpus are in that
      --    shape. A filer using ONE CUSIP for SEVERAL securities is not a parser bug: verified against
      --    the SEC document, First Trust files cusip 336917109 thirty-four times in one information
      --    table under 31 different titleOfClass values. fund_holdings is unique on
      --    (cik, quarter, cusip, class, put_call) for exactly that reason, and put_call is already
      --    pinned to the empty string by scoped above. Same fix, same reason, as runOwnershipAggregate.
      latest as (
        select distinct on (cik, quarter, cusip, class) cik, quarter, cusip, class, accession
          from scoped
         order by cik, quarter, cusip, class, filed_date desc nulls last, accession desc
      ),
      kept as (
        select sc.ticker, sc.cik, sc.quarter, sc.cusip, sc.shares
          from scoped sc
          join latest l on l.cik = sc.cik and l.quarter = sc.quarter
                       and l.cusip = sc.cusip and l.class = sc.class
                       and l.accession = sc.accession
      ),
      -- 3. MANAGER LINES. 13F lets one filer report a security across several internal managers, one
      --    line each — 10,349 groups do. Those lines ARE one position, and this is the only level
      --    where summing belongs.
      per_security as (
        select ticker, cik, quarter, cusip, sum(shares)::numeric as shares
          from kept group by ticker, cik, quarter, cusip
      ),
      -- 4. ONE SCORE PER FILER. The filer's whole position in the ticker is built first, then scored
      --    once, so a filer holding two share classes cannot vote twice.
      per_filer as (
        select ticker, cik,
               coalesce(sum(shares) filter (where quarter = ${q0}), 0) as cur,
               coalesce(sum(shares) filter (where quarter = ${prevQ}), 0) as prev
          from per_security group by ticker, cik
      )
      select ticker, sum(case when cur > prev then 1 when cur < prev then -1 else 0 end)::int as net
        from per_filer group by ticker`);
    for (const r of (rows.rows ?? rows)) fundNet.set(r.ticker, Number(r.net) || 0);
  }

  // Pit Consensus score per ticker (bull).
  const consensus = new Map();
  try { for (const r of await computeConfluence('bull')) consensus.set(r.ticker, r.score); } catch { /* non-fatal */ }

  // Recent material 8-K (last 7d).
  const ek = await db.select({ ticker: eightkFilings.ticker }).from(eightkFilings)
    .where(and(eq(eightkFilings.material, true), sql`${eightkFilings.filedAt} >= now() - interval '7 days'`)).groupBy(eightkFilings.ticker);
  const has8k = new Set(ek.map((r) => r.ticker));

  // 8-K catalyst category + "breaking today" from the last 14d of filings (most-recent per ticker).
  const ekAll = await db.select({ ticker: eightkFilings.ticker, items: eightkFilings.items, filedAt: eightkFilings.filedAt })
    .from(eightkFilings).where(sql`${eightkFilings.filedAt} >= now() - interval '14 days'`).orderBy(desc(eightkFilings.filedAt));
  const newsCat = new Map();
  const breaking = new Set();
  const todayStr = ymd(new Date());
  for (const r of ekAll) {
    if (!r.ticker) continue;
    if (!newsCat.has(r.ticker)) { const cat = eightkCategory(r.items); if (cat) newsCat.set(r.ticker, cat); }
    if (r.filedAt && ymd(new Date(r.filedAt)) === todayStr) breaking.add(r.ticker);
  }

  // Latest short interest + float (FINRA is market-wide → also our breadth + volume source).
  const si = await db.selectDistinctOn([shortInterest.ticker], { ticker: shortInterest.ticker, shares: shortInterest.shortIntShares, dtc: shortInterest.daysToCover, avg: shortInterest.avgDailyVolume })
    .from(shortInterest).orderBy(shortInterest.ticker, desc(shortInterest.settlementDate));
  const siByT = new Map(si.map((r) => [r.ticker, r]));
  const fl = await db.select({ ticker: tickerFloat.ticker, floatShares: tickerFloat.floatShares, sharesOut: tickerFloat.outstandingShares }).from(tickerFloat);
  const flByT = new Map(fl.map((r) => [r.ticker, r]));

  // Canonical company names. Separate query, separate concern: nothing about it is scoped to a
  // signal window, and nothing in the signal aggregates supplies a name.
  const nameByT = await companyIdentity();

  // Persistent descriptive meta (market cap / sector / exchange / asset type) from Polygon details.
  // ⚠️ screener_stocks IS DERIVED, AND DERIVED DATA INHERITS ITS INPUTS' PROVENANCE. This copied sector,
  // industry, exchange, country, asset type, market cap, shares outstanding and the annual dividend
  // straight out of screener_meta — and 14,535 of those rows are pre-audit rows that record no origin,
  // every one of them Polygon reference data. Copying them into a table with no provenance column at all
  // would launder exactly the exposure this change removes: the Screener would serve the same vendor
  // values one hop further from their source, where no gate could see them.
  //
  // So the reference columns are taken ONLY from rows whose provenance is approved. A ticker whose meta
  // row is still unknown keeps its own identity fields (company name, price, volume, technicals — all
  // from licensed inputs) and shows an em dash for sector and market cap until backfillMeta rewrites it
  // from SEC. Fewer filled cells, no laundered ones.
  const metaRows = await db.select().from(screenerMeta);
  const metaByT = new Map(metaRows.filter((r) => servableMetaSource(r.source)).map((r) => [r.ticker, r]));
  const metaWithheld = metaRows.length - metaByT.size;

  // INSTITUTIONAL OWNERSHIP %, which the screener has always OFFERED as a filter ("Inst Own %") and
  // never populated: the column was declared in the schema, wired into screener-filters, and left
  // null for all 17,643 rows, so selecting it silently matched nothing. The rollup that holds the
  // number has 14,232 rows and is rebuilt nightly by institutions-ownership; it just was not read.
  //
  // Values above 100% are dropped rather than shown. Institutions cannot hold more than the shares
  // outstanding; every one of the 570 such rows traces to a stale or wrong shares_out in
  // screener_meta, and the tail is absurd on its face — the worst reads 728,573%. A wrong denominator
  // is not a signal, and publishing it would be worse than leaving the cell empty.
  const ownPctByT = new Map((await db.select({
    ticker: tickerInstitutionalOwnership.ticker, pct: tickerInstitutionalOwnership.ownershipPct,
  }).from(tickerInstitutionalOwnership))
    .filter((r) => r.pct != null && r.pct > 0 && r.pct <= 100)
    .map((r) => [r.ticker, r.pct]));
  // Persistent fundamentals (price-independent computed values + raw inputs) from Polygon Financials.
  // ⚠️ GATED ON PROVENANCE, FOR THE SAME REASON screener_meta IS. 4,477 rows in this table predate the
  // licensing work and were derived from Polygon Financials with a NULL source. They are the rows that
  // produced the Screener's P/E, EPS and revenue columns, so reading them here would put the removed
  // provider's fundamentals back on the board — one hop from their source, in a table that records none.
  //
  // 'sec' is the only servable value, written by scripts/ingest-sec-fundamentals.mjs and enforced by a
  // CHECK constraint on the column so nothing else can appear there.
  const fundRows = await db.select().from(screenerFundamentals);
  const fundByT = new Map(fundRows.filter((r) => r.source === 'sec').map((r) => [r.ticker, r]));
  const fundWithheld = fundRows.length - fundByT.size;

  // 2) Universe = union of all tickers we have any signal/candle for.
  //
  // ⚠️ GATED, because this is where "NONE" entered the product.
  //
  // The universe is built from signal tables, and insider_trades carries a filing's
  // issuerTradingSymbol verbatim — which for an unlisted issuer is the literal string "NONE" (26
  // rows today, plus 6 "N/A"). That created a screener_stocks row for a security that does not
  // exist, named after a non-traded fund, with no price, no market cap and no exchange, and it
  // reached the homepage as a ticker card.
  //
  // Deleting that row without this gate would be theatre: the next rebuild reads the same insider
  // rows and recreates it. The raw filings are correct and stay as they are — this is the boundary
  // where a filing's text becomes a claim that a security exists, and it is the right place to
  // refuse. `add` is the single entry point, so nothing can join the universe around it.
  const universe = new Set();
  const addTicker = (t) => { if (isRenderableTicker(t)) universe.add(t); };
  insRows.forEach((r) => addTicker(r.ticker));
  conRows.forEach((r) => addTicker(r.ticker));
  fundNet.forEach((_, t) => addTicker(t));
  consensus.forEach((_, t) => addTicker(t));
  has8k.forEach((t) => addTicker(t));
  newsCat.forEach((_, t) => addTicker(t));
  // FINRA breadth, filtered to clean, liquid common-stock symbols (signal tickers are already in).
  si.forEach((r) => { if (r.ticker && CLEAN_SYM.test(r.ticker) && (r.avg || 0) >= MIN_LIQUID_VOL) addTicker(r.ticker); });

  // Polygon grouped-daily → market-wide EOD price/volume/change (the real universe + prices).
  const poly = await licensedEod();
  if (poly) poly.map.forEach((_, t) => { if (CLEAN_SYM.test(t)) addTicker(t); });
  const insByT = new Map(insRows.map((r) => [r.ticker, r]));
  const conByT = new Map(conRows.map((r) => [r.ticker, r]));

  const candleTickers = (await db.selectDistinct({ ticker: tickerDailyCandles.ticker }).from(tickerDailyCandles)).map((r) => r.ticker);
  candleTickers.forEach((t) => addTicker(t));

  // 3) Technicals from candles (chunked). Only for tickers we have candles for.
  const tech = new Map();
  const candleSet = candleTickers.slice(0, maxCandleTickers);
  for (let i = 0; i < candleSet.length; i += 150) {
    const batch = candleSet.slice(i, i + 150);
    const rows = await db.select({ ticker: tickerDailyCandles.ticker, date: tickerDailyCandles.date, high: tickerDailyCandles.high, low: tickerDailyCandles.low, close: tickerDailyCandles.close, volume: tickerDailyCandles.volume })
      .from(tickerDailyCandles).where(inArray(tickerDailyCandles.ticker, batch)).orderBy(tickerDailyCandles.ticker, tickerDailyCandles.date);
    const grouped = new Map();
    for (const r of rows) { const a = grouped.get(r.ticker) || []; a.push(r); grouped.set(r.ticker, a); }
    for (const [t, series] of grouped) {
      if (series.length < 2) continue;
      const closes = series.map((s) => s.close);
      const last = series[series.length - 1], prev = series[series.length - 2];
      const vols = series.map((s) => s.volume);
      const avgVol = mean(vols.slice(-30));
      const yr = closes.slice(-252);
      tech.set(t, {
        price: last.close, changePct: prev.close ? ((last.close - prev.close) / prev.close) * 100 : null,
        volume: last.volume, avgVol, relVol: avgVol ? last.volume / avgVol : null,
        rsi14: rsi(closes), sma20: smaN(closes, 20), sma50: smaN(closes, 50), sma200: smaN(closes, 200),
        hi52: yr.length ? Math.max(...yr) : null, lo52: yr.length ? Math.min(...yr) : null, atr14: atr(series),
        perf1w: perf(closes, 5), perf1m: perf(closes, 21), perf3m: perf(closes, 63), perf6m: perf(closes, 126), perf1y: perf(closes, 252),
      });
    }
  }

  // Global symbol sanity: only real stock symbols (1–5 letters, optional single-letter class like
  // BRK.B). Drops anything number-leading or malformed regardless of which source added it.
  //
  // ⚠️ AND THE EXCHANGES' RESERVED TEST NAMESPACES, which pass every shape test because they are
  // MEANT to look like symbols. Polygon's grouped-daily feed is market-wide and carries them with
  // real test quotes, so six were reaching the production Screener — one, ZTEST, at $7,616, which
  // distorts any price-ordered board. Corroborated against screener_meta rather than taken on the
  // pattern alone, because `TEST` is a genuine classified ETF: see isExchangeTestSymbol.
  const testSyms = [];
  const tickers = [...universe].filter((t) => {
    if (!t || !/^[A-Z]{1,5}(\.[A-Z])?$/.test(t)) return false;
    // ⚠️ "DO WE KNOW THIS SECURITY" IS AN IDENTITY QUESTION, NOT A PROVENANCE ONE, and conflating the two
    // dropped a real ETF out of the Screener. `classified` used to be metaByT.has(t) — but metaByT is now
    // filtered to rows whose vendor-derived reference COLUMNS may be served, so TEST (the YieldMax ETF,
    // whose meta row predates the provenance work and carries a NULL source) stopped counting as known and
    // was refused as an exchange test symbol. Measured: TEST vanished from screener_stocks entirely.
    //
    // Whether we may publish a sector is a different question from whether the symbol denotes a real
    // company, and the security master answers the second one on its own terms — a name there comes from
    // SEC filings and our own resolution, not from a retired vendor. So the name decides.
    if (isExchangeTestSymbol(t, { classified: metaByT.has(t), named: !!nameByT.get(t) })) { testSyms.push(t); return false; }
    return true;
  });
  if (testSyms.length) console.log(`[screener] refused ${testSyms.length} exchange test symbol(s): ${testSyms.join(', ')}`);

  // Prices from the shared KV quote cache (persisted from prior runs + ticker-page/watchlist views),
  // for the prioritized set that lacks a candle price. Free, no rate limit — just cache reads.
  const isSignal = (t) => insByT.has(t) || conByT.has(t) || consensus.has(t) || fundNet.has(t) || has8k.has(t);
  const prioritize = (a, bb) => { const sa = isSignal(a) ? 0 : 1, sb = isSignal(bb) ? 0 : 1; return sa !== sb ? sa - sb : (siByT.get(bb)?.avg || 0) - (siByT.get(a)?.avg || 0); };
  const priceMap = new Map();
  // Only fall back to the KV cache when Polygon didn't provide a price for this ticker.
  if (!poly) {
    const needPrice = tickers.filter((t) => !tech.has(t)).sort(prioritize);
    for (let i = 0; i < Math.min(needPrice.length, KV_READ_CAP); i += 50) {
      const batch = needPrice.slice(i, i + 50);
      const got = await Promise.all(batch.map(kvGetQuote));
      got.forEach((q, j) => { if (q) priceMap.set(batch[j], q); });
    }
  }

  // TECHNICALS SURVIVE THE REBUILD. They belong to backfillTechnicals, which owns twenty-two columns
  // this rebuild does not compute at all (perf_ytd/3y/5y, volatility, beta, high20d, high50d,
  // all_time_high, candlestick, pattern) and computes the rest for at most `maxCandleTickers` of the
  // 13,301 tickers that have candles. Clearing the table therefore used to null every technical for
  // the whole market until the next technicals run: measured at 9.1% rsi14 and 0.0% for all ten of
  // the fields above, which is what a user filtering on RSI or a 200-day average actually saw for
  // the twenty minutes after the 08:30 rebuild, and for the rest of the day after any manual one.
  //
  // Read them before the delete and carry them forward for any ticker this run cannot recompute. A
  // ticker that leaves the universe still disappears, because carry-forward only applies to rows
  // being reinserted. Roughly 3 MB, one read.
  const prevTech = new Map((await db.select({
    ticker: screenerStocks.ticker,
    rsi14: screenerStocks.rsi14, sma20: screenerStocks.sma20, sma50: screenerStocks.sma50, sma200: screenerStocks.sma200,
    hi52: screenerStocks.hi52, lo52: screenerStocks.lo52, atr14: screenerStocks.atr14,
    perf1w: screenerStocks.perf1w, perf1m: screenerStocks.perf1m, perf3m: screenerStocks.perf3m,
    perf6m: screenerStocks.perf6m, perf1y: screenerStocks.perf1y, perfYtd: screenerStocks.perfYtd,
    perf3y: screenerStocks.perf3y, perf5y: screenerStocks.perf5y,
    volatility: screenerStocks.volatility, beta: screenerStocks.beta,
    high20d: screenerStocks.high20d, high50d: screenerStocks.high50d, allTimeHigh: screenerStocks.allTimeHigh,
    candlestick: screenerStocks.candlestick, pattern: screenerStocks.pattern,
  }).from(screenerStocks)).map((r) => [r.ticker, r]));

  // Clean rebuild: clear the table, then insert the fresh universe. Prevents any accumulation of
  // delisted/junk tickers across runs (why the count was stuck at 25k).
  await db.delete(screenerStocks);

  // 4) Insert the universe FIRST (fast, no network) so stocks always land even if the later quote
  // pass is slow/times out.
  const rowsOut = tickers.map((t) => {
    const i = insByT.get(t), c = conByT.get(t), tk = tech.get(t), s = siByT.get(t), f = flByT.get(t), pg = poly?.map.get(t), m = metaByT.get(t), fd = fundByT.get(t), pv = prevTech.get(t);
    const floatShares = f?.floatShares ?? null;
    const vol = tk?.volume ?? pg?.volume ?? s?.avg ?? null;
    const px = tk?.price ?? pg?.price ?? priceMap.get(t)?.price ?? null;
    const mcap = m?.marketCap ?? null;
    const ev = (mcap != null) ? mcap + (fd?.totalDebt || 0) - (fd?.cash || 0) : null;   // enterprise value
    return {
      // NEVER m?.industry. An industry description is not a company name, and null is the honest
      // answer when no SEC filing has told us who this issuer is.
      ticker: t, company: nameByT.get(t) ?? null,
      exchange: m?.exchange ?? null, sector: m?.sector ?? null, industry: m?.industry ?? null, sicCode: m?.sicCode ?? null, country: m?.country ?? null, assetType: m?.assetType ?? null, marketCap: mcap, ipoDate: m?.ipoDate ?? null,
      price: px, changePct: tk?.changePct ?? pg?.changePct ?? priceMap.get(t)?.changePct ?? null,
      changeFromOpen: pg?.changeFromOpen ?? null, gap: pg?.gap ?? null,
      dividendYield: (m?.annualDividend && px > 0) ? (m.annualDividend / px) * 100 : null,
      volume: vol, avgVol: tk?.avgVol ?? s?.avg ?? null, relVol: tk?.relVol ?? null,
      // fundamentals — price-dependent ratios computed here with fresh price; rest copied from the table
      // ⚠️ `> 0` IS NOT THE SAME TEST AS "IS A REPORTED EARNINGS FIGURE".
      //
      // This read `fd?.epsTtm > 0`, which correctly refuses negative and zero earnings — that is why
      // no row carries a negative or zero P/E, and why the UI never implies an unavailable P/E is 0.
      // What it does not refuse is a DENORMAL: ASTX (a 2x leveraged ETF) carried
      // eps_ttm = 3.469446951953614e-18, the residue of subtracting two nearly-equal doubles, and
      // 10.29 / 3.47e-18 stored a P/E of 2,965,890,570,601,113,600. Arithmetically derived, and not a
      // ratio about anything.
      //
      // The floor is a tenth of a cent, chosen from the data rather than to taste: across 2,179
      // positive eps_ttm values exactly ONE sits below $0.001, and the next smallest is $0.01 — four
      // orders of magnitude of clearance, so nothing a filer could actually report is excluded. It is
      // a tripwire for arithmetic residue, not a view about which companies deserve a P/E.
      //
      // Measured on the other six price-dependent ratios below: revenue bottoms at $438, equity at
      // $1,252, ebitda at $68,696, and none produces a ratio above 1e6. eps is the only denominator
      // that reaches a denormal, so it is the only one floored.
      pe: (px != null && fd?.epsTtm >= MIN_MEANINGFUL_EPS) ? px / fd.epsTtm : null,
      ps: (mcap != null && fd?.revenueTtm > 0) ? mcap / fd.revenueTtm : null,
      pb: (mcap != null && fd?.equity > 0) ? mcap / fd.equity : null,
      pCash: (mcap != null && fd?.cash > 0) ? mcap / fd.cash : null,
      evSales: (ev != null && fd?.revenueTtm > 0) ? ev / fd.revenueTtm : null,
      evEbitda: (ev != null && fd?.ebitda > 0) ? ev / fd.ebitda : null,
      grossMargin: fd?.grossMargin ?? null, operMargin: fd?.operMargin ?? null, netMargin: fd?.netMargin ?? null,
      roe: fd?.roe ?? null, roa: fd?.roa ?? null, currentRatio: fd?.currentRatio ?? null, quickRatio: fd?.quickRatio ?? null,
      debtEquity: fd?.debtEquity ?? null, ltDebtEquity: fd?.ltDebtEquity ?? null,
      epsGrowthTtm: fd?.epsGrowthTtm ?? null, revGrowthTtm: fd?.revGrowthTtm ?? null,
      epsGrowthQoq: fd?.epsGrowthQoq ?? null, salesGrowthQoq: fd?.salesGrowthQoq ?? null,
      epsGrowth3y: fd?.epsGrowth3y ?? null, salesGrowth3y: fd?.salesGrowth3y ?? null,
      epsGrowth5y: fd?.epsGrowth5y ?? null, salesGrowth5y: fd?.salesGrowth5y ?? null,
      epsGrowthThisYr: fd?.epsGrowthThisYr ?? null, roic: fd?.roic ?? null,
      // Same denominator, same floor — a payout ratio against a denormal eps is the same artifact.
      payoutRatio: (m?.annualDividend > 0 && fd?.epsTtm >= MIN_MEANINGFUL_EPS) ? (m.annualDividend / fd.epsTtm) * 100 : null,
      floatShares, sharesOut: f?.sharesOut ?? m?.sharesOut ?? null,
      shortFloat: (s?.shares && floatShares) ? (s.shares / floatShares) * 100 : null, daysToCover: s?.dtc ?? null,
      // This run's candle-derived value if it has one, else whatever the technicals job last wrote.
      // pv supplies the twenty-two columns outright where this run computes nothing.
      rsi14: tk?.rsi14 ?? pv?.rsi14 ?? null, sma20: tk?.sma20 ?? pv?.sma20 ?? null,
      sma50: tk?.sma50 ?? pv?.sma50 ?? null, sma200: tk?.sma200 ?? pv?.sma200 ?? null,
      hi52: tk?.hi52 ?? pv?.hi52 ?? null, lo52: tk?.lo52 ?? pv?.lo52 ?? null, atr14: tk?.atr14 ?? pv?.atr14 ?? null,
      perf1w: tk?.perf1w ?? pv?.perf1w ?? null, perf1m: tk?.perf1m ?? pv?.perf1m ?? null,
      perf3m: tk?.perf3m ?? pv?.perf3m ?? null, perf6m: tk?.perf6m ?? pv?.perf6m ?? null,
      perf1y: tk?.perf1y ?? pv?.perf1y ?? null,
      perfYtd: pv?.perfYtd ?? null, perf3y: pv?.perf3y ?? null, perf5y: pv?.perf5y ?? null,
      volatility: pv?.volatility ?? null, beta: pv?.beta ?? null,
      high20d: pv?.high20d ?? null, high50d: pv?.high50d ?? null, allTimeHigh: pv?.allTimeHigh ?? null,
      candlestick: pv?.candlestick ?? null, pattern: pv?.pattern ?? null,
      insiderNet90d: i?.net ?? null, insiderBuyers90d: i?.buyers ?? null, insiderBuy90d: !!i?.buy, insiderSell90d: !!i?.sell,
      congressNet90d: c?.net ?? null, congressBuy90d: !!c?.buy,
      instOwnPct: ownPctByT.get(t) ?? null,
      fundNetQoq: fundNet.get(t) ?? null, consensusScore: consensus.get(t) ?? null,
      hasMaterial8k: has8k.has(t), newsRecent: has8k.has(t),
      newsCategory: newsCat.get(t) ?? null, breakingToday: breaking.has(t),
      updatedAt: runTs,
    };
  });

  let upserts = 0;
  for (let i = 0; i < rowsOut.length; i += 200) {
    const batch = rowsOut.slice(i, i + 200);
    await db.insert(screenerStocks).values(batch).onConflictDoUpdate({
      target: screenerStocks.ticker,
      set: {
        // The old clause coalesced the incoming name with the row's existing one, to keep a
        // previously-known name when a run produced none — but now that null is a MEANING ("no SEC
        // filing names this issuer") rather than an absence, preserving the old value would let a
        // retired or contaminated name survive a correction forever. The rebuild deletes the table
        // first, so this path is not normally taken; it must still be correct when it is.
        company: sql`excluded.company`,
        exchange: sql`excluded.exchange`, sector: sql`excluded.sector`, industry: sql`excluded.industry`, sicCode: sql`excluded.sic_code`, country: sql`excluded.country`, assetType: sql`excluded.asset_type`, marketCap: sql`excluded.market_cap`, ipoDate: sql`excluded.ipo_date`,
        pe: sql`excluded.pe`, ps: sql`excluded.ps`, pb: sql`excluded.pb`, pCash: sql`excluded.p_cash`, evSales: sql`excluded.ev_sales`, evEbitda: sql`excluded.ev_ebitda`,
        grossMargin: sql`excluded.gross_margin`, operMargin: sql`excluded.oper_margin`, netMargin: sql`excluded.net_margin`, roe: sql`excluded.roe`, roa: sql`excluded.roa`,
        currentRatio: sql`excluded.current_ratio`, quickRatio: sql`excluded.quick_ratio`, debtEquity: sql`excluded.debt_equity`, ltDebtEquity: sql`excluded.lt_debt_equity`,
        epsGrowthTtm: sql`excluded.eps_growth_ttm`, revGrowthTtm: sql`excluded.rev_growth_ttm`, epsGrowthQoq: sql`excluded.eps_growth_qoq`, salesGrowthQoq: sql`excluded.sales_growth_qoq`,
        epsGrowth3y: sql`excluded.eps_growth_3y`, salesGrowth3y: sql`excluded.sales_growth_3y`,
        epsGrowth5y: sql`excluded.eps_growth_5y`, salesGrowth5y: sql`excluded.sales_growth_5y`, epsGrowthThisYr: sql`excluded.eps_growth_this_yr`, roic: sql`excluded.roic`, payoutRatio: sql`excluded.payout_ratio`,
        changeFromOpen: sql`excluded.change_from_open`, gap: sql`excluded.gap`, dividendYield: sql`excluded.dividend_yield`,
        price: sql`coalesce(excluded.price, screener_stocks.price)`, changePct: sql`coalesce(excluded.change_pct, screener_stocks.change_pct)`,
        volume: sql`coalesce(excluded.volume, screener_stocks.volume)`, avgVol: sql`coalesce(excluded.avg_vol, screener_stocks.avg_vol)`, relVol: sql`excluded.rel_vol`,
        floatShares: sql`excluded.float_shares`, sharesOut: sql`excluded.shares_out`, shortFloat: sql`excluded.short_float`, daysToCover: sql`excluded.days_to_cover`,
        rsi14: sql`excluded.rsi14`, sma20: sql`excluded.sma20`, sma50: sql`excluded.sma50`, sma200: sql`excluded.sma200`,
        hi52: sql`excluded.hi52`, lo52: sql`excluded.lo52`, atr14: sql`excluded.atr14`,
        perf1w: sql`excluded.perf_1w`, perf1m: sql`excluded.perf_1m`, perf3m: sql`excluded.perf_3m`, perf6m: sql`excluded.perf_6m`, perf1y: sql`excluded.perf_1y`,
        // Carried forward above rather than recomputed here; listed so the conflict path agrees with
        // the insert path. backfillTechnicals remains the only writer that derives them.
        perfYtd: sql`excluded.perf_ytd`, perf3y: sql`excluded.perf_3y`, perf5y: sql`excluded.perf_5y`,
        volatility: sql`excluded.volatility`, beta: sql`excluded.beta`,
        high20d: sql`excluded.high20d`, high50d: sql`excluded.high50d`, allTimeHigh: sql`excluded.all_time_high`,
        candlestick: sql`excluded.candlestick`, pattern: sql`excluded.pattern`,
        insiderNet90d: sql`excluded.insider_net_90d`, insiderBuyers90d: sql`excluded.insider_buyers_90d`, insiderBuy90d: sql`excluded.insider_buy_90d`, insiderSell90d: sql`excluded.insider_sell_90d`,
        congressNet90d: sql`excluded.congress_net_90d`, congressBuy90d: sql`excluded.congress_buy_90d`,
        instOwnPct: sql`excluded.inst_own_pct`,
        fundNetQoq: sql`excluded.fund_net_qoq`, consensusScore: sql`excluded.consensus_score`,
        hasMaterial8k: sql`excluded.has_material_8k`, newsRecent: sql`excluded.news_recent`,
        newsCategory: sql`excluded.news_category`, breakingToday: sql`excluded.breaking_today`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
    upserts += batch.length;
  }

  // 4b) REMOVED — THE CANDLE TABLE IS NOW AN INPUT HERE, NOT AN OUTPUT.
  //
  // ⚠️ THIS BLOCK WROTE 2.8 MILLION UNLICENSED ROWS, about 7,400 a session, each tagged
  // `source: 'polygon'`. It was added for an entirely reasonable reason — so market-wide technicals
  // could accumulate over time — and the `source` column it set was read by nobody as a licence
  // signal, so forty files went on to serve those rows as ordinary history. Daily bars now arrive
  // from Tiingo (scripts/backfill-licensed-candles.mjs and the gap-fill in market/daily-series.mjs),
  // and this rebuild READS them above in licensedEod(). A writer here would put the exposure back.

  // 5) REMOVED — THE FALLBACK THAT CHAINED TWO UNAPPROVED PROVIDERS TOGETHER.
  //
  // ⚠️ `if (FINNHUB_KEY && !poly)` was "Polygon did not cover the universe, so quote the gaps from
  // Finnhub" — one unlicensed vendor failing over to another, writing prices into screener_stocks AND
  // through to the KV quote cache that the ticker pages read. It fired only during a Polygon outage,
  // which is the worst possible moment to discover a licensing problem.
  //
  // There is no replacement fallback, deliberately. If a security has no licensed candle it has no
  // price here, the column is null, and the UI renders the em dash it already renders for unknown
  // values. An absent price is visible and recoverable; an unlicensed one is neither.
  const quoted = 0;

  const [{ n }] = await db.select({ n: sql`count(*)`.mapWith(Number) }).from(screenerStocks);
  // POINT-IN-TIME CAPTURE, last and wrapped.
  //
  // screener_stocks is DELETEd and rewritten by this function, so today's fundamentals exist only
  // until tomorrow's run overwrites them — there is no way to reconstruct them afterwards and no
  // provider sells us ours back. The capture therefore runs here, immediately after the rebuild that
  // produced the values, reading the table it just wrote.
  //
  // WRAPPED, because this is data collection for future research and must never be able to fail the
  // nightly rebuild that the whole product depends on. A missed day is a missed day; a broken
  // screener is an outage.
  let snapshot = null;
  try {
    snapshot = await captureFundamentalSnapshot();
    console.log(`[screener] fundamental snapshot: ${JSON.stringify(snapshot)}`);
  } catch (e) {
    console.log(`[screener] fundamental snapshot failed (non-fatal): ${e.message}`);
  }

  // ⚠️ THE FIELDS WERE NAMED AFTER THE VENDOR, and a job result that says `polygon: 13390` is exactly
  // the kind of thing the next audit will read as a live Polygon dependency. They now describe what they
  // measure: how many securities the licensed end-of-day read covered, and which session it came from.
  return { universe: tickers.length, technicals: tech.size, metaWithheld, fundWithheld, licensedEod: poly ? poly.map.size : 0, eodSession: poly?.date || null, quoted, tableCount: n, snapshot };
}
