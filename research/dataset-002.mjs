// THE EXPERIMENT 002 DATASET — one definition, shared by every run of it.
//
// Extracted from experiment-002.mjs so the institutional rerun cannot drift from the original. The
// specification is FROZEN (research/experiment-002-spec.md); if two scripts each built the dataset
// their own way, "rerun under the frozen spec" would be a claim nobody could check. Now there is one
// builder and the rerun differs only in what it REPORTS.
//
// ⚠️ RESEARCH ONLY. Reads the database, writes nothing, consumed by no production path.
//
// Every rule here is the frozen one:
//   Form 4 dated by filing_date · 13F by filed_date · prices ≤ observation for features, > for
//   outcomes · 63-day horizon · size proxy = median 60-session dollar volume from bars strictly
//   before the observation · cohorts = size tercile × sector, benchmarked against the peer universe
//   · a 13F quarter pair is usable only when BOTH quarters carry ≥ MIN_FILERS filers.

import { neon } from '@neondatabase/serverless';
import { SECTOR_ETF } from '../src/lib/scan/relative-strength.mjs';
import { horizonOutcome, priceOn } from './outcomes.mjs';
import { describe } from './validation.mjs';

export const H = 63;
export const MIN_N = 30;
export const MIN_FILERS = 1000;      // ⚠️ FROZEN. Not to be lowered to make a quarter usable.
export const HOLDOUT_DAYS = 120;

// LAZY, so importing the pure helpers does not require a database URL.
//
// The research suite tests dollarVolProxy, priorReturn and instDirection — all pure — and must stay
// runnable with no credentials. Building the client at module scope made `node
// scripts/verify-research.mjs` fail outright unless DATABASE_URL happened to be set, which turns a
// pure suite into a credentialed one for no reason.
let _sql = null;
const sql = (...args) => {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('dataset-002: DATABASE_URL required to build the dataset');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql(...args);
};

/** Quarters, their filer counts, and which consecutive pairs can support a QoQ comparison. */
export async function quarterState() {
  const qStats = await sql`
    select quarter::text q, count(distinct cik)::int funds, count(*)::int holdings,
           count(distinct ticker)::int tickers, min(filed_date)::text first_filed
      from fund_holdings group by 1 order by 1`;
  const validPairs = [];
  for (let i = 1; i < qStats.length; i += 1) {
    // BOTH sides must be real. Experiment 001 compared thousand-fund quarters against one-fund
    // quarters, so every holding looked like a new initiation and the counts were fiction.
    if (qStats[i].funds >= MIN_FILERS && qStats[i - 1].funds >= MIN_FILERS) {
      validPairs.push({ cur: qStats[i].q, prev: qStats[i - 1].q, firstFiled: qStats[i].first_filed });
    }
  }
  return { qStats, validPairs };
}

/** Median daily dollar volume over the 60 sessions strictly BEFORE `day`. Point-in-time by design. */
export function dollarVolProxy(series, day) {
  const before = [];
  for (const b of series) { if (b.date >= day) break; before.push(b); }
  const w = before.slice(-60).map((b) => b.close * b.volume).filter(Number.isFinite).sort((a, b) => a - b);
  return w.length >= 30 ? w[w.length >> 1] : null;
}

/** Return over the previous `n` sessions, from bars strictly before `day`. */
export function priorReturn(series, day, n) {
  const before = [];
  for (const b of series) { if (b.date >= day) break; before.push(b); }
  if (before.length < n + 1) return null;
  const a = before[before.length - 1 - n]?.close, z = before[before.length - 1]?.close;
  return (a > 0 && z > 0) ? ((z - a) / a) * 100 : null;
}

/**
 * Institutional direction from a quarter's breadth.
 *
 * BREADTH, NOT RAW COUNTS — a mega-cap held by 2,000 funds would otherwise dominate a small-cap held
 * by 40 purely by arithmetic. Fewer than five moving funds is `sparse`, because a 2-1 split among
 * three funds is not a verdict about institutional conviction.
 */
export function instDirection(inst) {
  if (!inst) return null;
  const net = (inst.inc + inst.init) - (inst.dec + inst.exited);
  const tot = inst.inc + inst.init + inst.dec + inst.exited;
  if (tot < 5) return 'sparse';
  const breadth = net / tot;
  return breadth > 0.1 ? 'accumulation' : breadth < -0.1 ? 'distribution' : 'mixed';
}

/** Build the whole frozen dataset. Deterministic given the database contents. */
export async function buildDataset({ log = () => {} } = {}) {
  const { qStats, validPairs } = await quarterState();
  log('13F quarters (funds / first filed):');
  for (const r of qStats) {
    log(`  ${r.q}  funds=${String(r.funds).padStart(5)}  holdings=${String(r.holdings.toLocaleString()).padStart(11)}  ` +
      `tickers=${String(r.tickers).padStart(6)}  first filed ${r.first_filed}  ${r.funds >= MIN_FILERS ? 'USABLE' : 'too sparse'}`);
  }
  log(`valid QoQ pairs: ${validPairs.length ? validPairs.map((p) => `${p.prev}→${p.cur}`).join(', ') : 'NONE'}\n`);

  const last = (await sql`select max(date)::text d from ticker_daily_candles`)[0].d;
  const obs = await sql`
    select i.ticker, i.filing_date::text as day,
           sum(case when i.action='BUY'  then i.total_value else 0 end)::float buy_val,
           sum(case when i.action='SELL' then i.total_value else 0 end)::float sell_val,
           count(distinct case when i.action='BUY'  then i.executive end)::int buyers,
           count(distinct case when i.action='SELL' then i.executive end)::int sellers,
           bool_or(i.action='BUY'  and i.title ~* '(chief exec|\\mceo\\M)')   ceo_buy,
           bool_or(i.action='SELL' and i.title ~* '(chief exec|\\mceo\\M)')   ceo_sell,
           bool_or(i.action='BUY'  and i.title ~* '(chief financ|\\mcfo\\M)') cfo_buy,
           bool_or(i.action='BUY'  and i.title ~* 'director')                 dir_buy,
           bool_or(i.action='SELL' and i.title ~* 'director')                 dir_sell,
           bool_or(i.action='BUY'  and i.title ~* '10%')                      ten_buy
      from insider_trades i
     where i.total_value > 0 and i.filing_date is not null and i.action in ('BUY','SELL')
       and i.filing_date <= ${last}::date - 95
     group by i.ticker, i.filing_date`;
  log(`raw insider observation windows (buy or sell, PIT-dated): ${obs.length}`);

  const need = [...new Set([...obs.map((o) => o.ticker), ...Object.values(SECTOR_ETF), 'SPY'])];
  const arr = `{${need.map((t) => `"${t.replace(/["\\]/g, '')}"`).join(',')}}`;
  const earliest = obs.reduce((a, o) => (o.day < a ? o.day : a), '9999');
  const floorDay = new Date(Date.parse(`${earliest}T00:00:00Z`) - 200 * 86_400_000).toISOString().slice(0, 10);

  const bars = new Map();
  let barCount = 0;
  for (let i = 0; i < need.length; i += 400) {
    const chunk = need.slice(i, i + 400);
    const a = `{${chunk.map((t) => `"${t.replace(/["\\]/g, '')}"`).join(',')}}`;
    const rs = await sql`
      select ticker, date::text date, close, high, low, volume
        from ticker_daily_candles where ticker = any(${a}::text[]) and date >= ${floorDay}::date
       order by ticker, date`;
    for (const b of rs) {
      if (!bars.has(b.ticker)) bars.set(b.ticker, []);
      bars.get(b.ticker).push({ date: b.date, close: Number(b.close), high: Number(b.high), low: Number(b.low), volume: Number(b.volume) });
      barCount += 1;
    }
  }
  log(`price series: ${bars.size} tickers, ${barCount.toLocaleString()} bars (from ${floorDay})`);

  const meta = new Map();
  for (const r of await sql`
    select s.ticker, coalesce(s.sector, m.sector) sector, coalesce(s.market_cap, m.market_cap) mcap
      from screener_stocks s left join screener_meta m on m.ticker = s.ticker`)
    meta.set(r.ticker, { sector: r.sector, mcap: r.mcap == null ? null : Number(r.mcap) });

  // Institutional state per valid pair. `holders` and the four movement counts are kept raw so the
  // reporting layer can express breadth ratios rather than being handed a single collapsed number.
  const qq = new Map();
  for (const p of validPairs) {
    const rs = await sql`
      with per_fund as (
        select ticker, cik,
               sum(case when quarter = ${p.cur}::date then shares else 0 end) cur,
               sum(case when quarter = ${p.prev}::date then shares else 0 end) prev
          from fund_holdings
         where quarter in (${p.cur}::date, ${p.prev}::date) and ticker = any(${arr}::text[]) and put_call = ''
         group by ticker, cik)
      select ticker,
             count(*) filter (where cur > prev and prev > 0)::int inc,
             count(*) filter (where cur < prev and cur > 0)::int dec,
             count(*) filter (where prev = 0 and cur > 0)::int init,
             count(*) filter (where cur = 0 and prev > 0)::int exited,
             count(*) filter (where cur > 0)::int holders
        from per_fund group by ticker`;
    for (const r of rs) {
      qq.set(`${p.cur}|${r.ticker}`, {
        inc: Number(r.inc), dec: Number(r.dec), init: Number(r.init), exited: Number(r.exited), holders: Number(r.holders),
      });
    }
    log(`  QoQ ${p.prev} → ${p.cur}: ${rs.length} tickers`);
  }
  // STRICTLY BEFORE the observation: a quarter filed the same day is not information we had.
  const instAsOf = (ticker, day) => {
    let best = null;
    for (const p of validPairs) if (p.firstFiled && p.firstFiled < day) best = p.cur;
    return best ? (qq.get(`${best}|${ticker}`) ?? null) : null;
  };

  const drop = { noSector: 0, noEtf: 0, noBars: 0, shortWindow: 0, noProxy: 0 };
  const rows = [];
  for (const o of obs) {
    const m = meta.get(o.ticker);
    if (!m?.sector) { drop.noSector += 1; continue; }
    const etf = SECTOR_ETF[m.sector];
    if (!etf) { drop.noEtf += 1; continue; }
    const series = bars.get(o.ticker);
    if (!series || priceOn(series, o.day) == null) { drop.noBars += 1; continue; }
    const out = horizonOutcome(series, o.day, H);
    if (!out) { drop.shortWindow += 1; continue; }
    const proxy = dollarVolProxy(series, o.day);
    if (proxy == null) { drop.noProxy += 1; continue; }
    const sec = horizonOutcome(bars.get(etf), o.day, H);
    const spy = horizonOutcome(bars.get('SPY'), o.day, H);
    const buy = Number(o.buy_val) > 0, sell = Number(o.sell_val) > 0;
    const inst = instAsOf(o.ticker, o.day);
    rows.push({
      ticker: o.ticker, day: o.day, asOfMs: Date.parse(`${o.day}T00:00:00Z`), month: o.day.slice(0, 7),
      sector: m.sector, mcapNow: m.mcap, proxy,
      buyVal: Number(o.buy_val), sellVal: Number(o.sell_val), buyers: o.buyers, sellers: o.sellers,
      ceoBuy: o.ceo_buy, ceoSell: o.ceo_sell, cfoBuy: o.cfo_buy, dirBuy: o.dir_buy, dirSell: o.dir_sell, tenBuy: o.ten_buy,
      conflict: buy && sell ? 'both' : buy ? 'buy_only' : sell ? 'sell_only' : 'neither',
      mom63: priorReturn(series, o.day, 63),
      ret: out.returnPct,
      relSpy: spy ? out.returnPct - spy.returnPct : null,
      relSec: sec ? out.returnPct - sec.returnPct : null,
      mfe: out.maxFavorablePct, mae: out.maxAdversePct,
      inst, instDir: instDirection(inst),
    });
  }
  log(`usable observations: ${rows.length}   dropped: ${JSON.stringify(drop)}`);

  // Size terciles WITHIN each calendar month, so the breakpoints are point-in-time.
  const byMonth = new Map();
  for (const r of rows) { if (!byMonth.has(r.month)) byMonth.set(r.month, []); byMonth.get(r.month).push(r); }
  for (const [, rs] of byMonth) {
    const sorted = [...rs].sort((a, b) => a.proxy - b.proxy);
    const t1 = sorted[Math.floor(sorted.length / 3)]?.proxy ?? Infinity;
    const t2 = sorted[Math.floor((2 * sorted.length) / 3)]?.proxy ?? Infinity;
    for (const r of rs) r.sizeTercile = r.proxy <= t1 ? 'small' : r.proxy <= t2 ? 'mid' : 'large';
  }

  // The cohort benchmark comes from the PEER universe, not from the observations — a benchmark built
  // only from names insiders traded would be a sample of itself.
  const universe = [];
  for (const [ticker, series] of bars) {
    const m = meta.get(ticker);
    if (m?.sector && SECTOR_ETF[m.sector]) universe.push({ ticker, series, sector: m.sector });
  }
  const cohortMedian = new Map();
  for (const month of [...new Set(rows.map((r) => r.month))].sort()) {
    const pool = [];
    for (const u of universe) {
      const firstDay = u.series.find((b) => b.date.slice(0, 7) === month)?.date;
      if (!firstDay) continue;
      const proxy = dollarVolProxy(u.series, firstDay);
      const o = horizonOutcome(u.series, firstDay, H);
      if (proxy == null || !o) continue;
      pool.push({ sector: u.sector, proxy, ret: o.returnPct });
    }
    if (pool.length < 30) continue;
    const sorted = [...pool].sort((a, b) => a.proxy - b.proxy);
    const t1 = sorted[Math.floor(pool.length / 3)].proxy, t2 = sorted[Math.floor((2 * pool.length) / 3)].proxy;
    const cells = new Map();
    for (const p of pool) {
      const tier = p.proxy <= t1 ? 'small' : p.proxy <= t2 ? 'mid' : 'large';
      const k = `${month}|${tier}|${p.sector}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(p.ret);
    }
    for (const [k, xs] of cells) if (xs.length >= 10) cohortMedian.set(k, describe(xs).median);
  }
  let matched = 0;
  for (const r of rows) {
    const base = cohortMedian.get(`${r.month}|${r.sizeTercile}|${r.sector}`);
    r.relCohort = base == null ? null : r.ret - base;
    if (r.relCohort != null) matched += 1;
  }
  log(`cohort benchmarks built: ${cohortMedian.size} cells; observations matched: ${matched}/${rows.length}\n`);

  const maxMs = Math.max(...rows.map((r) => r.asOfMs));
  const holdoutFrom = maxMs - HOLDOUT_DAYS * 86_400_000;
  return {
    rows, qStats, validPairs,
    explore: rows.filter((r) => r.asOfMs < holdoutFrom),
    holdout: rows.filter((r) => r.asOfMs >= holdoutFrom),
  };
}
