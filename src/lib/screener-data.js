import { sql, and, eq, gte, inArray, desc, isNotNull } from 'drizzle-orm';
import { db } from './db';
import { insiderTrades, congressTrades, fundHoldings, fundFilings, eightkFilings, shortInterest, tickerFloat, tickerDailyCandles, screenerStocks } from './schema';
import { computeConfluence } from './confluence';

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
  _ensured = true;
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

const WINDOW = 90;
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const MAX_QUOTES = 120;                       // live-quote fetches/run (stay under Finnhub 60/min)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A "clean" common-stock symbol: 1–5 letters, no suffix (drops warrants/units/preferred/rights).
const CLEAN_SYM = /^[A-Z]{1,5}$/;
const MIN_LIQUID_VOL = 50000;   // FINRA breadth floor: skip dead/thin names (signal tickers bypass)

export async function rebuildScreener({ maxCandleTickers = 2500 } = {}) {
  await ensureScreenerTables();
  const runTs = new Date();     // rows written this run get this exact stamp; stale rows are pruned
  const since90 = sql`current_date - make_interval(days => ${WINDOW})`;

  // 1) Proprietary aggregates (bulk, one query each).
  const insRows = await db.select({
    ticker: insiderTrades.ticker,
    net: sql`sum(case when ${insiderTrades.action}='BUY' then ${insiderTrades.totalValue} else -${insiderTrades.totalValue} end)`.mapWith(Number),
    buyers: sql`count(distinct case when ${insiderTrades.action}='BUY' then ${insiderTrades.executive} end)`.mapWith(Number),
    buy: sql`bool_or(${insiderTrades.action}='BUY')`,
    sell: sql`bool_or(${insiderTrades.action}='SELL')`,
    company: sql`max(${insiderTrades.company})`,
  }).from(insiderTrades).where(and(gte(insiderTrades.transactionDate, since90), sql`${insiderTrades.totalValue} > 0`)).groupBy(insiderTrades.ticker);

  const conRows = await db.select({
    ticker: congressTrades.ticker,
    net: sql`sum(case when ${congressTrades.action}='BUY' then ${congressTrades.amountMid} else -${congressTrades.amountMid} end)`.mapWith(Number),
    buy: sql`bool_or(${congressTrades.action}='BUY')`,
  }).from(congressTrades).where(and(gte(congressTrades.transactionDate, since90), isNotNull(congressTrades.ticker))).groupBy(congressTrades.ticker);

  // 13F QoQ net (latest 2 quarters) — mirrors the confluence fund logic.
  const qRows = await db.select({ q: fundFilings.quarter }).from(fundFilings).groupBy(fundFilings.quarter).orderBy(desc(fundFilings.quarter)).limit(2);
  const [q0, q1] = qRows.map((r) => r.q);
  const fundNet = new Map();
  if (q0) {
    const holds = await db.select({ ticker: fundHoldings.ticker, cik: fundHoldings.cik, quarter: fundHoldings.quarter, shares: fundHoldings.shares })
      .from(fundHoldings).where(and(inArray(fundHoldings.quarter, [q0, q1].filter(Boolean)), isNotNull(fundHoldings.ticker), eq(fundHoldings.putCall, '')));
    const byKey = new Map();
    for (const h of holds) { const k = `${h.ticker}|${h.cik}`; const e = byKey.get(k) || { cur: 0, prev: 0 }; if (h.quarter === q0) e.cur = h.shares || 0; else e.prev = h.shares || 0; byKey.set(k, e); }
    for (const [k, e] of byKey) { const t = k.split('|')[0]; const f = fundNet.get(t) || 0; fundNet.set(t, f + (e.cur > e.prev ? 1 : e.cur < e.prev ? -1 : 0)); }
  }

  // Pit Consensus score per ticker (bull).
  const consensus = new Map();
  try { for (const r of await computeConfluence('bull')) consensus.set(r.ticker, r.score); } catch { /* non-fatal */ }

  // Recent material 8-K (last 7d).
  const ek = await db.select({ ticker: eightkFilings.ticker }).from(eightkFilings)
    .where(and(eq(eightkFilings.material, true), sql`${eightkFilings.filedAt} >= now() - interval '7 days'`)).groupBy(eightkFilings.ticker);
  const has8k = new Set(ek.map((r) => r.ticker));

  // Latest short interest + float (FINRA is market-wide → also our breadth + volume source).
  const si = await db.selectDistinctOn([shortInterest.ticker], { ticker: shortInterest.ticker, shares: shortInterest.shortIntShares, dtc: shortInterest.daysToCover, avg: shortInterest.avgDailyVolume })
    .from(shortInterest).orderBy(shortInterest.ticker, desc(shortInterest.settlementDate));
  const siByT = new Map(si.map((r) => [r.ticker, r]));
  const fl = await db.select({ ticker: tickerFloat.ticker, floatShares: tickerFloat.floatShares, sharesOut: tickerFloat.outstandingShares }).from(tickerFloat);
  const flByT = new Map(fl.map((r) => [r.ticker, r]));

  // 2) Universe = union of all tickers we have any signal/candle for.
  const universe = new Set();
  insRows.forEach((r) => r.ticker && universe.add(r.ticker));
  conRows.forEach((r) => r.ticker && universe.add(r.ticker));
  fundNet.forEach((_, t) => universe.add(t));
  consensus.forEach((_, t) => universe.add(t));
  has8k.forEach((t) => universe.add(t));
  // FINRA breadth, filtered to clean, liquid common-stock symbols (signal tickers are already in).
  si.forEach((r) => { if (r.ticker && CLEAN_SYM.test(r.ticker) && (r.avg || 0) >= MIN_LIQUID_VOL) universe.add(r.ticker); });
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

  // Clean rebuild: clear the table, then insert the fresh universe. Prevents any accumulation of
  // delisted/junk tickers across runs (why the count was stuck at 25k).
  await db.delete(screenerStocks);

  // 4) Insert the universe FIRST (fast, no network) so stocks always land even if the later quote
  // pass is slow/times out.
  const rowsOut = tickers.map((t) => {
    const i = insByT.get(t), c = conByT.get(t), tk = tech.get(t), s = siByT.get(t), f = flByT.get(t);
    const floatShares = f?.floatShares ?? null;
    return {
      ticker: t, company: i?.company || null,
      price: tk?.price ?? null, changePct: tk?.changePct ?? null,
      volume: tk?.volume ?? s?.avg ?? null, avgVol: tk?.avgVol ?? s?.avg ?? null, relVol: tk?.relVol ?? null,
      floatShares, sharesOut: f?.sharesOut ?? null,
      shortFloat: (s?.shares && floatShares) ? (s.shares / floatShares) * 100 : null, daysToCover: s?.dtc ?? null,
      rsi14: tk?.rsi14 ?? null, sma20: tk?.sma20 ?? null, sma50: tk?.sma50 ?? null, sma200: tk?.sma200 ?? null,
      hi52: tk?.hi52 ?? null, lo52: tk?.lo52 ?? null, atr14: tk?.atr14 ?? null,
      perf1w: tk?.perf1w ?? null, perf1m: tk?.perf1m ?? null, perf3m: tk?.perf3m ?? null, perf6m: tk?.perf6m ?? null, perf1y: tk?.perf1y ?? null,
      insiderNet90d: i?.net ?? null, insiderBuyers90d: i?.buyers ?? null, insiderBuy90d: !!i?.buy, insiderSell90d: !!i?.sell,
      congressNet90d: c?.net ?? null, congressBuy90d: !!c?.buy,
      fundNetQoq: fundNet.get(t) ?? null, consensusScore: consensus.get(t) ?? null,
      hasMaterial8k: has8k.has(t), newsRecent: has8k.has(t),
      updatedAt: runTs,
    };
  });

  let upserts = 0;
  for (let i = 0; i < rowsOut.length; i += 200) {
    const batch = rowsOut.slice(i, i + 200);
    await db.insert(screenerStocks).values(batch).onConflictDoUpdate({
      target: screenerStocks.ticker,
      set: {
        company: sql`coalesce(excluded.company, screener_stocks.company)`,
        price: sql`coalesce(excluded.price, screener_stocks.price)`, changePct: sql`coalesce(excluded.change_pct, screener_stocks.change_pct)`,
        volume: sql`coalesce(excluded.volume, screener_stocks.volume)`, avgVol: sql`coalesce(excluded.avg_vol, screener_stocks.avg_vol)`, relVol: sql`excluded.rel_vol`,
        floatShares: sql`excluded.float_shares`, sharesOut: sql`excluded.shares_out`, shortFloat: sql`excluded.short_float`, daysToCover: sql`excluded.days_to_cover`,
        rsi14: sql`excluded.rsi14`, sma20: sql`excluded.sma20`, sma50: sql`excluded.sma50`, sma200: sql`excluded.sma200`,
        hi52: sql`excluded.hi52`, lo52: sql`excluded.lo52`, atr14: sql`excluded.atr14`,
        perf1w: sql`excluded.perf_1w`, perf1m: sql`excluded.perf_1m`, perf3m: sql`excluded.perf_3m`, perf6m: sql`excluded.perf_6m`, perf1y: sql`excluded.perf_1y`,
        insiderNet90d: sql`excluded.insider_net_90d`, insiderBuyers90d: sql`excluded.insider_buyers_90d`, insiderBuy90d: sql`excluded.insider_buy_90d`, insiderSell90d: sql`excluded.insider_sell_90d`,
        congressNet90d: sql`excluded.congress_net_90d`, congressBuy90d: sql`excluded.congress_buy_90d`,
        fundNetQoq: sql`excluded.fund_net_qoq`, consensusScore: sql`excluded.consensus_score`,
        hasMaterial8k: sql`excluded.has_material_8k`, newsRecent: sql`excluded.news_recent`, updatedAt: sql`excluded.updated_at`,
      },
    });
    upserts += batch.length;
  }

  // 5) Delayed prices (AFTER the write). Candles gave EOD close for the warmed set; for the most
  // relevant unpriced names (signals first, then most liquid by FINRA avg vol) pull a throttled
  // Finnhub quote and update price-only. Coalesced, so coverage accumulates across nightly runs.
  let quoted = 0;
  if (FINNHUB_KEY) {
    const isSignal = (t) => insByT.has(t) || conByT.has(t) || consensus.has(t) || fundNet.has(t) || has8k.has(t);
    const need = tickers.filter((t) => !tech.has(t)).sort((a, bb) => {
      const sa = isSignal(a) ? 0 : 1, sb = isSignal(bb) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return (siByT.get(bb)?.avg || 0) - (siByT.get(a)?.avg || 0);
    });
    for (const t of need.slice(0, MAX_QUOTES)) {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t)}&token=${FINNHUB_KEY}`, { cache: 'no-store' });
        if (r.ok) {
          const q = await r.json();
          if (q && q.c) { await db.update(screenerStocks).set({ price: q.c, changePct: q.dp ?? null }).where(eq(screenerStocks.ticker, t)); quoted++; }
        }
      } catch { /* skip */ }
      await sleep(1100);
    }
  }

  const [{ n }] = await db.select({ n: sql`count(*)`.mapWith(Number) }).from(screenerStocks);
  return { universe: tickers.length, technicals: tech.size, upserts, quoted, tableCount: n };
}
