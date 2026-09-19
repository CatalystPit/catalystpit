import { sql, and, eq, gte, inArray, desc, isNotNull } from 'drizzle-orm';
import { db } from './db';
import { insiderTrades, congressTrades, fundHoldings, fundFilings, eightkFilings, shortInterest, tickerFloat, tickerDailyCandles, screenerStocks, screenerMeta, screenerFundamentals, tickerInstitutionalOwnership } from './schema';
import { computeConfluence } from './confluence';
import { isSicDescription } from './sic-descriptions.mjs';
import { sicToMarketSector } from './market-taxonomy.mjs';
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
const fval = (r, stmt, key) => r?.financials?.[stmt]?.[key]?.value ?? null;
const sumField = (rows, stmt, key) => rows.reduce((s, r) => { const x = fval(r, stmt, key); return x == null ? s : s + x; }, 0);
const cagr = (end, start, yrs) => (start > 0 && end > 0) ? (Math.pow(end / start, 1 / yrs) - 1) * 100 : null;
const growth = (cur, prev) => (prev != null && prev !== 0 && cur != null) ? ((cur - prev) / Math.abs(prev)) * 100 : null;

async function fetchFinancials(t) {
  try {
    const [qR, aR] = await Promise.all([
      fetch(`https://api.polygon.io/vX/reference/financials?ticker=${encodeURIComponent(t)}&timeframe=quarterly&order=desc&limit=8&apiKey=${POLYGON_KEY}`, { cache: 'no-store' }),
      fetch(`https://api.polygon.io/vX/reference/financials?ticker=${encodeURIComponent(t)}&timeframe=annual&order=desc&limit=6&apiKey=${POLYGON_KEY}`, { cache: 'no-store' }),
    ]);
    const q = qR.ok ? ((await qR.json())?.results || []) : [];
    const a = aR.ok ? ((await aR.json())?.results || []) : [];
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

// Populate screener_fundamentals from Polygon Financials. Bounded, prioritized by volume, accumulates.
export async function backfillFundamentals({ cap = 3000, concurrency = 6, staleDays = 30, force = false } = {}) {
  await ensureScreenerTables();
  if (!POLYGON_KEY) return { error: 'no POLYGON_KEY' };
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

async function fetchDetail(t) {
  try {
    const [dR, divR] = await Promise.all([
      fetch(`https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(t)}?apiKey=${POLYGON_KEY}`, { cache: 'no-store' }),
      fetch(`https://api.polygon.io/v3/reference/dividends?ticker=${encodeURIComponent(t)}&limit=4&order=desc&sort=ex_dividend_date&apiKey=${POLYGON_KEY}`, { cache: 'no-store' }),
    ]);
    if (!dR.ok) return null;
    const d = (await dR.json())?.results;
    if (!d) return null;
    // Annual dividend = sum of the last 4 cash payouts (approximates trailing annual for quarterly payers).
    let annualDividend = null;
    try { const divs = divR.ok ? ((await divR.json())?.results || []) : []; if (divs.length) annualDividend = divs.reduce((s, x) => s + (x.cash_amount || 0), 0); } catch { /* ignore */ }
    return {
      ticker: t,
      marketCap: d.market_cap ?? null,
      // ⚠️ THE CODE IS RETAINED, NOT JUST THE DERIVED SECTOR.
      //
      // This used to store `sicToSector(d.sic_code)` and `d.sic_description` and throw the CODE
      // away. The classification was decided once at ingest and its source discarded, so when the
      // mapping turned out to be wrong — TSLA in Industrials, PG in Basic Materials, PLD in
      // Financial Services — there was nothing left to reclassify FROM, and correcting it would have
      // meant re-fetching the whole universe from the vendor.
      //
      // Keeping sic_code makes the sector a DERIVATION rather than a decision: the taxonomy can be
      // improved and replayed over existing rows in seconds.
      sicCode: Number.isFinite(parseInt(d.sic_code, 10)) ? parseInt(d.sic_code, 10) : null,
      sector: sicToMarketSector(d.sic_code),
      industry: d.sic_description || null,
      exchange: EXCH_MAP[d.primary_exchange] || null,
      assetType: d.type === 'ETF' ? 'ETF' : d.type === 'CS' ? 'Stock' : (d.type || null),
      country: d.locale === 'us' ? 'USA' : (d.locale ? d.locale.toUpperCase() : null),
      sharesOut: d.weighted_shares_outstanding ?? d.share_class_shares_outstanding ?? null,
      annualDividend,
      ipoDate: d.list_date || null,
      // The vendor names every security it returns, including the ETFs and fund lines that file no
      // Form 4 and appear in no SEC ticker file. We were discarding it on every one of these calls.
      // Stored here, at the provider boundary, and consumed by security_identity at the LOWEST
      // precedence — a vendor's name never outranks a name its owner filed.
      name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : null,
    };
  } catch { return null; }
}

// Populate screener_meta from Polygon ticker-details. Bounded per run, prioritized by volume, skips
// rows refreshed within staleDays — so it accumulates full coverage over a few runs and refreshes.
export async function backfillMeta({ cap = 6000, concurrency = 8, staleDays = 14, force = false, only = null } = {}) {
  await ensureScreenerTables();
  if (!POLYGON_KEY) return { error: 'no POLYGON_KEY' };
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

  const rows = [];
  for (let i = 0; i < need.length; i += concurrency) {
    const got = await Promise.all(need.slice(i, i + concurrency).map(fetchDetail));
    got.forEach((d) => { if (d) rows.push({ ...d, updatedAt: new Date() }); });
  }
  let saved = 0;
  for (let i = 0; i < rows.length; i += 300) {
    const batch = rows.slice(i, i + 300);
    await db.insert(screenerMeta).values(batch).onConflictDoUpdate({
      target: screenerMeta.ticker,
      set: { marketCap: sql`excluded.market_cap`, sector: sql`excluded.sector`, industry: sql`excluded.industry`, sicCode: sql`excluded.sic_code`, exchange: sql`excluded.exchange`, assetType: sql`excluded.asset_type`, country: sql`excluded.country`, sharesOut: sql`excluded.shares_out`, annualDividend: sql`excluded.annual_dividend`, ipoDate: sql`excluded.ipo_date`, name: sql`coalesce(excluded.name, screener_meta.name)`, updatedAt: sql`now()` },
    });
    saved += batch.length;
  }
  return { requested: need.length, fetched: rows.length, saved };
}

// Backfill technicals market-wide from Polygon grouped-daily history (Stocks Starter = unlimited
// calls). Pulls `days` trading days, computes RSI/SMA/52w/ATR/perf in memory (universe tickers only),
// writes the technical columns to screener_stocks. Idempotent; run after the main rebuild.
export async function backfillTechnicals({ days = 260 } = {}) {
  await ensureScreenerTables();
  if (!POLYGON_KEY) return { error: 'no POLYGON_KEY' };
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
  for (let i = 1; gotDays < days && i <= calendarBudget; i++) {
    const d = new Date(now); d.setUTCDate(now.getUTCDate() - i);
    const ds = ymd(d);
    const res = await fetchGrouped(ds);
    if (!res) continue;
    gotDays++;
    for (const x of res) {
      if (x.T === 'SPY' && x.c != null) spy.unshift(x.c);   // newest→oldest fetch; unshift = chronological
      if (!uni.has(x.T) || x.c == null) continue;
      const a = series.get(x.T) || [];
      a.push({ open: x.o, close: x.c, high: x.h, low: x.l, date: ds });
      series.set(x.T, a);
    }
  }
  // SPY daily returns (chronological) for beta.
  const spyRet = [];
  for (let i = 1; i < spy.length; i++) if (spy[i - 1] > 0) spyRet.push(spy[i] / spy[i - 1] - 1);
  const spyVar = variance(spyRet);
  const yearStart = `${now.getUTCFullYear()}-01-01`;

  // Perf 3Y/5Y: one grouped snapshot ~3y and ~5y ago gives every ticker's close then (cheap — 2 calls).
  async function closesAgo(yearsBack) {
    for (let off = 0; off < 8; off++) {
      const d = new Date(now); d.setUTCFullYear(now.getUTCFullYear() - yearsBack); d.setUTCDate(d.getUTCDate() - off);
      const res = await fetchGrouped(ymd(d));
      if (res) return new Map(res.map((x) => [x.T, x.c]));
    }
    return new Map();
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
const FINNHUB_KEY = process.env.FINNHUB_KEY;
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

// ── Polygon grouped-daily: EOD OHLCV for the WHOLE US market in one call (delayed/EOD, all tiers). ──
const POLYGON_KEY = process.env.POLYGON_KEY || process.env.POLYGON_API_KEY;
const ymd = (d) => d.toISOString().slice(0, 10);
async function fetchGrouped(dateStr) {
  try {
    const r = await fetch(`https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${POLYGON_KEY}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.results) && j.results.length ? j.results : null;   // [{T,o,h,l,c,v}]
  } catch { return null; }
}
// Latest two trading days (walk back over weekends/holidays) → price/volume + change% per ticker.
async function polygonEod() {
  if (!POLYGON_KEY) return null;
  const now = new Date();
  const found = [];
  for (let i = 1; i <= 6 && found.length < 2; i++) {
    const d = new Date(now); d.setUTCDate(now.getUTCDate() - i);
    const res = await fetchGrouped(ymd(d));
    if (res) found.push({ date: ymd(d), res });
  }
  if (!found.length) return null;
  const prevClose = new Map((found[1]?.res || []).map((x) => [x.T, x.c]));
  const map = new Map();
  for (const x of found[0].res) {
    const pc = prevClose.get(x.T);
    map.set(x.T, {
      price: x.c, open: x.o, volume: x.v,
      changePct: (pc && pc > 0) ? ((x.c - pc) / pc) * 100 : null,
      changeFromOpen: (x.o && x.o > 0 && x.c != null) ? ((x.c - x.o) / x.o) * 100 : null,
      gap: (pc && pc > 0 && x.o != null) ? ((x.o - pc) / pc) * 100 : null,
    });
  }
  return { date: found[0].date, map, res: found[0].res };
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
  }).from(insiderTrades).where(and(gte(insiderTrades.transactionDate, since90), sql`${insiderTrades.totalValue} > 0`)).groupBy(insiderTrades.ticker);

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
        select h.ticker, h.cik, h.quarter, h.cusip, h.shares, h.accession, h.filed_date
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
      --    amendment must not both contribute. Measured on live data, 9 of 13 multi-accession
      --    filings look like restatements, not additive ones. Per (cik, quarter, cusip) the LATEST
      --    filing wins — filed_date then accession, both descending, so the answer never depends on
      --    physical row order. Choosing the FILING and then taking its rows, rather than ranking
      --    rows, is what keeps a filing whole.
      latest as (
        select distinct on (cik, quarter, cusip) cik, quarter, cusip, accession
          from scoped
         order by cik, quarter, cusip, filed_date desc nulls last, accession desc
      ),
      kept as (
        select sc.ticker, sc.cik, sc.quarter, sc.cusip, sc.shares
          from scoped sc
          join latest l on l.cik = sc.cik and l.quarter = sc.quarter
                       and l.cusip = sc.cusip and l.accession = sc.accession
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
  const metaByT = new Map((await db.select().from(screenerMeta)).map((r) => [r.ticker, r]));

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
  const fundByT = new Map((await db.select().from(screenerFundamentals)).map((r) => [r.ticker, r]));

  // 2) Universe = union of all tickers we have any signal/candle for.
  const universe = new Set();
  insRows.forEach((r) => r.ticker && universe.add(r.ticker));
  conRows.forEach((r) => r.ticker && universe.add(r.ticker));
  fundNet.forEach((_, t) => universe.add(t));
  consensus.forEach((_, t) => universe.add(t));
  has8k.forEach((t) => universe.add(t));
  newsCat.forEach((_, t) => universe.add(t));
  // FINRA breadth, filtered to clean, liquid common-stock symbols (signal tickers are already in).
  si.forEach((r) => { if (r.ticker && CLEAN_SYM.test(r.ticker) && (r.avg || 0) >= MIN_LIQUID_VOL) universe.add(r.ticker); });

  // Polygon grouped-daily → market-wide EOD price/volume/change (the real universe + prices).
  const poly = await polygonEod();
  if (poly) poly.map.forEach((_, t) => { if (CLEAN_SYM.test(t)) universe.add(t); });
  const insByT = new Map(insRows.map((r) => [r.ticker, r]));
  const conByT = new Map(conRows.map((r) => [r.ticker, r]));

  const candleTickers = (await db.selectDistinct({ ticker: tickerDailyCandles.ticker }).from(tickerDailyCandles)).map((r) => r.ticker);
  candleTickers.forEach((t) => universe.add(t));

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
  const tickers = [...universe].filter((t) => t && /^[A-Z]{1,5}(\.[A-Z])?$/.test(t));

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
      pe: (px != null && fd?.epsTtm > 0) ? px / fd.epsTtm : null,
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
      payoutRatio: (m?.annualDividend > 0 && fd?.epsTtm > 0) ? (m.annualDividend / fd.epsTtm) * 100 : null,
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

  // 4b) Store today's Polygon bars into ticker_daily_candles so technicals (RSI/SMA/52w/perf)
  // accumulate market-wide over time (the existing candle compute picks them up next runs).
  if (poly) {
    const candleRows = poly.res.filter((x) => CLEAN_SYM.test(x.T) && x.c != null)
      .map((x) => ({ ticker: x.T, date: poly.date, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v ?? 0, source: 'polygon' }));
    for (let i = 0; i < candleRows.length; i += 500) {
      try { await db.insert(tickerDailyCandles).values(candleRows.slice(i, i + 500)).onConflictDoNothing(); } catch { /* skip */ }
    }
  }

  // 5) Delayed prices — ONLY when Polygon didn't cover the universe (fallback). Candles gave EOD for
  // the warmed set; pull a throttled Finnhub quote for the top unpriced names + write-through to KV.
  let quoted = 0;
  if (FINNHUB_KEY && !poly) {
    // Only names still missing a price (no candle, not in KV cache) — fetch fresh + write-through to
    // KV so they persist and reuse next run / on ticker pages.
    const need = tickers.filter((t) => !tech.has(t) && !priceMap.has(t)).sort(prioritize);
    for (const t of need.slice(0, MAX_QUOTES)) {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t)}&token=${FINNHUB_KEY}`, { cache: 'no-store' });
        if (r.ok) {
          const q = await r.json();
          if (q && q.c) {
            await db.update(screenerStocks).set({ price: q.c, changePct: q.dp ?? null }).where(eq(screenerStocks.ticker, t));
            await kvSetQuote(t, { c: q.c, d: q.d ?? null, dp: q.dp ?? null, h: q.h ?? null, l: q.l ?? null, o: q.o ?? null, pc: q.pc ?? null });
            quoted++;
          }
        }
      } catch { /* skip */ }
      await sleep(1100);
    }
  }

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

  return { universe: tickers.length, technicals: tech.size, polygon: poly ? poly.map.size : 0, polygonDate: poly?.date || null, quoted, tableCount: n, snapshot };
}
