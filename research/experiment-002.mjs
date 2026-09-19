// EXPERIMENT 002 — insider and institutional evidence after size, sector and momentum controls.
//
// Spec frozen in experiment-002-spec.md BEFORE this was run. Nothing here may quietly differ from it.
//
// ⚠️ RESEARCH ONLY. Reads the database, writes nothing, changes no score.
//   node --env-file=.env.local research/experiment-002.mjs

import { neon } from '@neondatabase/serverless';
import { SECTOR_ETF } from '../src/lib/scan/relative-strength.mjs';
import { horizonOutcome, priceOn } from './outcomes.mjs';
import { describe, tStatistic, overlapFactorFor, bonferroniThreshold, walkForwardSplits, inRange } from './validation.mjs';

const sql = neon(process.env.DATABASE_URL);
const H = 63;                      // trading days — unchanged from Experiment 001, deliberately
const MIN_N = 30;
const MIN_FILERS = 1000;           // a quarter below this cannot support a QoQ comparison
const HOLDOUT_DAYS = 120;          // protected; exploration must not touch it

const pctS = (v) => (v == null ? '   —  ' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const pad = (s, n) => String(s).padEnd(n);
let hypotheses = 0;

console.log('EXPERIMENT 002 — spec frozen in research/experiment-002-spec.md\n');

// ── 13F QUARTER VALIDITY ─────────────────────────────────────────────────────
// A quarter pair produces meaningful acc/red ONLY when both quarters have a real filer population.
// Experiment 001 compared quarters holding ONE fund against quarters holding thousands, so every
// holding looked like a new initiation. That arm of it is not usable; this is the guard.
const qStats = await sql`
  select quarter::text q, count(distinct cik)::int funds, min(filed_date)::text first_filed
    from fund_holdings group by 1 order by 1`;
console.log('13F quarters (funds / first filed):');
for (const r of qStats) console.log(`  ${r.q}  funds=${String(r.funds).padStart(5)}  first filed ${r.first_filed}  ${r.funds >= MIN_FILERS ? 'USABLE' : 'too sparse'}`);
const validPairs = [];
for (let i = 1; i < qStats.length; i += 1) {
  if (qStats[i].funds >= MIN_FILERS && qStats[i - 1].funds >= MIN_FILERS) {
    validPairs.push({ cur: qStats[i].q, prev: qStats[i - 1].q, firstFiled: qStats[i].first_filed });
  }
}
console.log(`valid QoQ pairs: ${validPairs.length ? validPairs.map((p) => `${p.prev}→${p.cur}`).join(', ') : 'NONE'}\n`);

// ── OBSERVATIONS: every (ticker, filing_date) with open-market buy OR sell ───
const last = (await sql`select max(date)::text d from ticker_daily_candles`)[0].d;
const obs = await sql`
  select i.ticker, i.filing_date::text as day,
         sum(case when i.action='BUY'  then i.total_value else 0 end)::float buy_val,
         sum(case when i.action='SELL' then i.total_value else 0 end)::float sell_val,
         count(distinct case when i.action='BUY'  then i.executive end)::int buyers,
         count(distinct case when i.action='SELL' then i.executive end)::int sellers,
         count(*) filter (where i.action='BUY')::int  buy_txns,
         count(*) filter (where i.action='SELL')::int sell_txns,
         bool_or(i.action='BUY'  and i.title ~* '(chief exec|\\mceo\\M)')      ceo_buy,
         bool_or(i.action='SELL' and i.title ~* '(chief exec|\\mceo\\M)')      ceo_sell,
         bool_or(i.action='BUY'  and i.title ~* '(chief financ|\\mcfo\\M)')    cfo_buy,
         bool_or(i.action='SELL' and i.title ~* '(chief financ|\\mcfo\\M)')    cfo_sell,
         bool_or(i.action='BUY'  and i.title ~* 'director')                    dir_buy,
         bool_or(i.action='SELL' and i.title ~* 'director')                    dir_sell,
         bool_or(i.action='BUY'  and i.title ~* '10%')                         ten_buy,
         bool_or(i.action='SELL' and i.title ~* '10%')                         ten_sell,
         bool_or(i.action='BUY'  and i.title ~* '(chief|officer|president|vice pres)') off_buy,
         max(i.is_repeat_buyer::int)::int repeat_buyer
    from insider_trades i
   where i.total_value > 0 and i.filing_date is not null and i.action in ('BUY','SELL')
     and i.filing_date <= ${last}::date - 95
   group by i.ticker, i.filing_date`;
console.log(`raw insider observation windows (buy or sell, PIT-dated): ${obs.length}`);

// ── PRICES ───────────────────────────────────────────────────────────────────
const tickers = [...new Set(obs.map((o) => o.ticker))];
const need = [...new Set([...tickers, ...Object.values(SECTOR_ETF), 'SPY'])];
const arr = `{${need.map((t) => `"${t.replace(/["\\]/g, '')}"`).join(',')}}`;
// CHUNKED. 46,410 observation windows span enough tickers that one fetch exceeds the driver's 64MB
// response cap; bars are also bounded to the period the study can actually use.
const bars = new Map();
let barCount = 0;
const earliest = obs.reduce((a, o) => (o.day < a ? o.day : a), '9999');
const floorDay = new Date(Date.parse(`${earliest}T00:00:00Z`) - 200 * 86_400_000).toISOString().slice(0, 10);
for (let i = 0; i < need.length; i += 400) {
  const chunk = need.slice(i, i + 400);
  const a = `{${chunk.map((t) => `"${t.replace(/["\\]/g, '')}"`).join(',')}}`;
  const rs = await sql`
    select ticker, date::text date, close, high, low, volume
      from ticker_daily_candles
     where ticker = any(${a}::text[]) and date >= ${floorDay}::date
     order by ticker, date`;
  for (const b of rs) {
    if (!bars.has(b.ticker)) bars.set(b.ticker, []);
    bars.get(b.ticker).push({ date: b.date, close: Number(b.close), high: Number(b.high), low: Number(b.low), volume: Number(b.volume) });
    barCount += 1;
  }
}
console.log(`price series: ${bars.size} tickers, ${barCount.toLocaleString()} bars (from ${floorDay})`);

// Sector + a CURRENT market cap, used ONLY to sanity-check the point-in-time proxy — never as a feature.
const meta = new Map();
for (const r of await sql`
  select s.ticker, coalesce(s.sector, m.sector) sector, coalesce(s.market_cap, m.market_cap) mcap
    from screener_stocks s left join screener_meta m on m.ticker = s.ticker`)
  meta.set(r.ticker, { sector: r.sector, mcap: r.mcap == null ? null : Number(r.mcap) });

// ── INSTITUTIONAL STATE, only from valid pairs, only filed before the observation ──
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
  console.log(`  QoQ ${p.prev} → ${p.cur}: ${rs.length} tickers`);
}
function instAsOf(ticker, day) {
  let best = null;
  for (const p of validPairs) if (p.firstFiled && p.firstFiled < day) best = p.cur;   // strictly before
  if (!best) return null;
  return qq.get(`${best}|${ticker}`) ?? null;
}

// ── FEATURES: size proxy, momentum, outcomes ─────────────────────────────────
// SIZE PROXY: median daily dollar volume over the 60 sessions strictly BEFORE the observation.
// Point-in-time by construction. It conflates size with turnover — stated in the spec, not hidden.
function dollarVolProxy(series, day) {
  const before = [];
  for (const b of series) { if (b.date >= day) break; before.push(b); }
  const w = before.slice(-60).map((b) => b.close * b.volume).filter(Number.isFinite).sort((a, b) => a - b);
  return w.length >= 30 ? w[w.length >> 1] : null;
}
function priorReturn(series, day, n) {
  const before = [];
  for (const b of series) { if (b.date >= day) break; before.push(b); }
  if (before.length < n + 1) return null;
  const a = before[before.length - 1 - n]?.close, z = before[before.length - 1]?.close;
  return (a > 0 && z > 0) ? ((z - a) / a) * 100 : null;
}

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
  rows.push({
    ticker: o.ticker, day: o.day, asOfMs: Date.parse(`${o.day}T00:00:00Z`), month: o.day.slice(0, 7),
    sector: m.sector, mcapNow: m.mcap, proxy,
    buyVal: Number(o.buy_val), sellVal: Number(o.sell_val),
    buyers: o.buyers, sellers: o.sellers, buyTxns: o.buy_txns, sellTxns: o.sell_txns,
    ceoBuy: o.ceo_buy, ceoSell: o.ceo_sell, cfoBuy: o.cfo_buy, cfoSell: o.cfo_sell,
    dirBuy: o.dir_buy, dirSell: o.dir_sell, tenBuy: o.ten_buy, tenSell: o.ten_sell, offBuy: o.off_buy,
    repeatBuyer: o.repeat_buyer === 1,
    conflict: buy && sell ? 'both' : buy ? 'buy_only' : sell ? 'sell_only' : 'neither',
    mom63: priorReturn(series, o.day, 63),
    ret: out.returnPct,
    relSpy: spy ? out.returnPct - spy.returnPct : null,
    relSec: sec ? out.returnPct - sec.returnPct : null,
    mfe: out.maxFavorablePct, mae: out.maxAdversePct,
    inst: instAsOf(o.ticker, o.day),
  });
}
console.log(`usable observations: ${rows.length}   dropped: ${JSON.stringify(drop)}`);

// ── COHORTS: size tercile (within month) × sector; benchmark from the PEER universe ──
const byMonth = new Map();
for (const r of rows) { if (!byMonth.has(r.month)) byMonth.set(r.month, []); byMonth.get(r.month).push(r); }
for (const [, rs] of byMonth) {
  const sorted = [...rs].sort((a, b) => a.proxy - b.proxy);
  const t1 = sorted[Math.floor(sorted.length / 3)]?.proxy ?? Infinity;
  const t2 = sorted[Math.floor((2 * sorted.length) / 3)]?.proxy ?? Infinity;
  for (const r of rs) r.sizeTercile = r.proxy <= t1 ? 'small' : r.proxy <= t2 ? 'mid' : 'large';
}

// The peer benchmark: the median 63-day forward return of EVERY eligible security in the cohort,
// measured from the month's first session — not only the ones an insider traded, which would make
// the benchmark a sample of itself.
const universe = [];
for (const [ticker, series] of bars) {
  const m = meta.get(ticker);
  if (!m?.sector || !SECTOR_ETF[m.sector]) continue;
  universe.push({ ticker, series, sector: m.sector });
}
const monthStarts = [...new Set(rows.map((r) => r.month))].sort();
const cohortMedian = new Map();   // `${month}|${tercile}|${sector}` → median 63d return
for (const month of monthStarts) {
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
  const t1 = sorted[Math.floor(sorted.length / 3)].proxy, t2 = sorted[Math.floor((2 * sorted.length) / 3)].proxy;
  const cells = new Map();
  for (const p of pool) {
    const tier = p.proxy <= t1 ? 'small' : p.proxy <= t2 ? 'mid' : 'large';
    const k = `${month}|${tier}|${p.sector}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(p.ret);
  }
  for (const [k, xs] of cells) if (xs.length >= 10) cohortMedian.set(k, describe(xs).median);
}
let cohortHits = 0;
for (const r of rows) {
  const k = `${r.month}|${r.sizeTercile}|${r.sector}`;
  const base = cohortMedian.get(k);
  r.relCohort = base == null ? null : r.ret - base;
  if (r.relCohort != null) cohortHits += 1;
}
console.log(`cohort benchmarks built: ${cohortMedian.size} cells; observations matched: ${cohortHits}/${rows.length}\n`);

// ── HOLDOUT: protected, and exploration structurally cannot see it ───────────
const maxMs = Math.max(...rows.map((r) => r.asOfMs));
const holdoutFrom = maxMs - HOLDOUT_DAYS * 86_400_000;
const explore = rows.filter((r) => r.asOfMs < holdoutFrom);
const holdout = rows.filter((r) => r.asOfMs >= holdoutFrom);
console.log(`exploratory set: ${explore.length}   protected holdout: ${holdout.length} (last ${HOLDOUT_DAYS} days)\n`);

const OVERLAP = overlapFactorFor(H, 1);
function report(label, subset, { indent = 2, set = explore } = {}) {
  hypotheses += 1;
  const pre = ' '.repeat(indent);
  if (subset.length < MIN_N) { console.log(`${pre}${pad(label, 44)} n=${pad(subset.length, 5)} UNDERPOWERED`); return null; }
  const coh = describe(subset.map((r) => r.relCohort));
  const sec = describe(subset.map((r) => r.relSec));
  const spy = describe(subset.map((r) => r.relSpy));
  const abs = describe(subset.map((r) => r.ret));
  const t = tStatistic(subset.map((r) => r.relCohort), { overlapFactor: OVERLAP });
  console.log(`${pre}${pad(label, 44)} n=${pad(subset.length, 5)} coh ${pctS(coh.median)}  sec ${pctS(sec.median)}  ` +
    `spy ${pctS(spy.median)}  abs ${pctS(abs.median)}  hit ${coh.hitRate == null ? '—' : (coh.hitRate * 100).toFixed(0) + '%'}  t=${t ? t.t.toFixed(2) : '—'}`);
  return { label, n: subset.length, coh, sec, spy, abs, t };
}

console.log('  (coh = cohort-relative, the size×sector control · sec = sector ETF · spy = SPY · abs = absolute)\n');
console.log('=== D. INSIDER FAMILY ===');
report('ALL observations', explore);
report('buy_only', explore.filter((r) => r.conflict === 'buy_only'));
report('sell_only', explore.filter((r) => r.conflict === 'sell_only'));
report('both buys and sells', explore.filter((r) => r.conflict === 'both'));

console.log('\n  buy side, by size (predeclared buckets):');
const buys = explore.filter((r) => r.conflict === 'buy_only');
report('< $50k', buys.filter((r) => r.buyVal < 50e3), { indent: 4 });
report('$50k - $250k', buys.filter((r) => r.buyVal >= 50e3 && r.buyVal < 250e3), { indent: 4 });
report('$250k - $1M', buys.filter((r) => r.buyVal >= 250e3 && r.buyVal < 1e6), { indent: 4 });
report('>= $1M', buys.filter((r) => r.buyVal >= 1e6), { indent: 4 });
console.log('  buy side, by independent actors:');
report('1 buyer', buys.filter((r) => r.buyers === 1), { indent: 4 });
report('2 buyers', buys.filter((r) => r.buyers === 2), { indent: 4 });
report('3+ buyers', buys.filter((r) => r.buyers >= 3), { indent: 4 });
console.log('  buy side, by role:');
report('CEO bought', buys.filter((r) => r.ceoBuy), { indent: 4 });
report('CFO bought', buys.filter((r) => r.cfoBuy), { indent: 4 });
report('director bought', buys.filter((r) => r.dirBuy), { indent: 4 });
report('10% owner bought', buys.filter((r) => r.tenBuy), { indent: 4 });
report('repeat buyer', buys.filter((r) => r.repeatBuyer), { indent: 4 });

console.log('\n  sell side (NOT assumed bearish, NOT the inverse of buying):');
const sells = explore.filter((r) => r.conflict === 'sell_only');
report('< $250k', sells.filter((r) => r.sellVal < 250e3), { indent: 4 });
report('$250k - $1M', sells.filter((r) => r.sellVal >= 250e3 && r.sellVal < 1e6), { indent: 4 });
report('>= $1M', sells.filter((r) => r.sellVal >= 1e6), { indent: 4 });
report('CEO sold', sells.filter((r) => r.ceoSell), { indent: 4 });
report('director sold', sells.filter((r) => r.dirSell), { indent: 4 });
report('3+ sellers', sells.filter((r) => r.sellers >= 3), { indent: 4 });

console.log('\n  mixed windows, with the role structure retained:');
const both = explore.filter((r) => r.conflict === 'both');
report('CEO buying while a director sells', both.filter((r) => r.ceoBuy && r.dirSell), { indent: 4 });
report('CEO selling while a director buys', both.filter((r) => r.ceoSell && r.dirBuy), { indent: 4 });
report('more buyers than sellers', both.filter((r) => r.buyers > r.sellers), { indent: 4 });
report('more sellers than buyers', both.filter((r) => r.sellers > r.buyers), { indent: 4 });

console.log('\n=== E/F. INSTITUTIONS, and the agreement/contradiction matrix ===');
const withInst = explore.filter((r) => r.inst != null);
console.log(`  observations with a VALID 13F filed before them: ${withInst.length} of ${explore.length}`);
const instDir = (r) => {
  if (!r.inst) return null;
  const net = (r.inst.inc + r.inst.init) - (r.inst.dec + r.inst.exited);
  const tot = r.inst.inc + r.inst.init + r.inst.dec + r.inst.exited;
  if (tot < 5) return 'sparse';
  const breadth = net / tot;
  return breadth > 0.1 ? 'accumulation' : breadth < -0.1 ? 'distribution' : 'mixed';
};
for (const r of rows) r.instDir = instDir(r);
report('institutions accumulating', withInst.filter((r) => r.instDir === 'accumulation'));
report('institutions mixed', withInst.filter((r) => r.instDir === 'mixed'));
report('institutions distributing', withInst.filter((r) => r.instDir === 'distribution'));

console.log('\n  the matrix (NOT labelled bullish or bearish in advance):');
for (const ins of ['buy_only', 'sell_only', 'both']) {
  for (const inst of ['accumulation', 'mixed', 'distribution']) {
    report(`${ins} + ${inst}`, withInst.filter((r) => r.conflict === ins && r.instDir === inst), { indent: 4 });
  }
}

console.log('\n=== H. MOMENTUM CONTROL ===');
const withMom = explore.filter((r) => r.mom63 != null);
const ms = [...withMom].sort((a, b) => a.mom63 - b.mom63);
const m1 = ms[Math.floor(ms.length / 3)]?.mom63, m2 = ms[Math.floor((2 * ms.length) / 3)]?.mom63;
const momTier = (r) => (r.mom63 == null ? null : r.mom63 <= m1 ? 'low' : r.mom63 <= m2 ? 'mid' : 'high');
console.log(`  prior-63-session momentum terciles: <=${m1?.toFixed(1)}% / <=${m2?.toFixed(1)}% / above`);
for (const tier of ['low', 'mid', 'high']) {
  console.log(`  momentum ${tier}:`);
  report('buy_only', withMom.filter((r) => momTier(r) === tier && r.conflict === 'buy_only'), { indent: 4 });
  report('sell_only', withMom.filter((r) => momTier(r) === tier && r.conflict === 'sell_only'), { indent: 4 });
}

console.log('\n=== PATH: MFE / MAE / downside ===');
for (const [label, set] of [['buy_only', buys], ['sell_only', sells], ['both', both]]) {
  if (set.length < MIN_N) continue;
  const mfe = describe(set.map((r) => r.mfe)), mae = describe(set.map((r) => r.mae)), coh = describe(set.map((r) => r.relCohort));
  console.log(`  ${pad(label, 12)} n=${pad(set.length, 5)} MFE med ${pctS(mfe.median)}  MAE med ${pctS(mae.median)}  ` +
    `coh p25 ${pctS(coh.p25)}  coh p10 ${pctS(coh.p10)}`);
}

console.log('\n=== I. WALK-FORWARD (exploratory only) ===');
const days = explore.map((r) => r.asOfMs).sort((a, b) => a - b);
const splits = walkForwardSplits({ startMs: days[0], endMs: days[days.length - 1], trainDays: 150, validateDays: 60, stepDays: 60, embargoDays: 92 });
console.log(`  folds: ${splits.length}`);
for (const s of splits) {
  const va = inRange(explore, s.validate);
  const b = va.filter((r) => r.conflict === 'buy_only');
  const d = describe(b.map((r) => r.relCohort));
  console.log(`  fold ${s.index}  buy_only out-of-sample n=${pad(d.n, 5)} coh med ${pctS(d.median)} hit ${d.hitRate == null ? '—' : (d.hitRate * 100).toFixed(0) + '%'}`);
}

console.log('\n=== PROTECTED HOLDOUT (read once, after exploration) ===');
report('ALL observations', holdout, { indent: 2, set: holdout });
report('buy_only', holdout.filter((r) => r.conflict === 'buy_only'), { indent: 2 });
report('sell_only', holdout.filter((r) => r.conflict === 'sell_only'), { indent: 2 });

console.log('\n=== SANITY: is the size proxy a reasonable stand-in? ===');
const paired = rows.filter((r) => r.mcapNow != null && r.proxy != null);
const rank = (xs) => { const s = [...xs].map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const out = new Array(xs.length); s.forEach(([, i], k) => { out[i] = k; }); return out; };
const rp = rank(paired.map((r) => r.proxy)), rm = rank(paired.map((r) => r.mcapNow));
const n = paired.length;
const d2 = rp.reduce((a, v, i) => a + (v - rm[i]) ** 2, 0);
const spearman = n > 2 ? 1 - (6 * d2) / (n * (n * n - 1)) : null;
console.log(`  Spearman(dollar-volume proxy, CURRENT market cap) = ${spearman?.toFixed(3)} over n=${n}`);
console.log('  (a sanity check only — current market cap is never used as a feature)');

console.log('\n=== MULTIPLE TESTING ===');
const bt = bonferroniThreshold(hypotheses, 0.05);
console.log(`  hypotheses tried: ${bt.hypothesesTried}  → adjusted alpha ${bt.adjustedAlpha.toExponential(2)} (|t| ≈ 3.5+)`);
console.log(`  overlap factor on every t: ${OVERLAP.toFixed(0)}×`);
