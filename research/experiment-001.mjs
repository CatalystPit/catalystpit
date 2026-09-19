// EXPERIMENT 001 — insider open-market buying, and whether 13F accumulation adds to it.
//
// The specification was frozen and committed in experiment-001-spec.md BEFORE this was run. Read it
// first; nothing here may quietly differ from it.
//
// ⚠️ RESEARCH ONLY. Reads the database, writes nothing, changes no score. Run:
//   node --env-file=.env.local research/experiment-001.mjs

import { neon } from '@neondatabase/serverless';
import { SECTOR_ETF } from '../src/lib/scan/relative-strength.mjs';
import { horizonOutcome, priceOn } from './outcomes.mjs';
import {
  describe, tStatistic, overlapFactorFor, bonferroniThreshold, walkForwardSplits, inRange, stability,
} from './validation.mjs';

const sql = neon(process.env.DATABASE_URL);
const HORIZON = 63;
const MIN_N = 30;
const pct = (v) => (v == null ? '   —  ' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const pad = (s, n) => String(s).padEnd(n);

console.log('EXPERIMENT 001 — spec frozen in research/experiment-001-spec.md\n');

// ── 1. OBSERVATIONS, dated by the information date ───────────────────────────
// One observation per (ticker, filing_date): multiple insiders filing the same day are one EVENT.
const lastSession = (await sql`select max(date)::text d from ticker_daily_candles`)[0].d;
const obsRows = await sql`
  with ev as (
    select i.ticker, i.filing_date::text as day,
           sum(i.total_value)::float as dollars,
           count(distinct i.executive)::int as buyers,
           bool_or(i.title ~* '(chief|ceo|cfo|president)') as has_officer
      from insider_trades i
     where i.action = 'BUY' and i.total_value > 0 and i.filing_date is not null
     group by i.ticker, i.filing_date
  )
  select ev.*, coalesce(s.sector, m.sector) as sector,
         coalesce(s.market_cap, m.market_cap) as market_cap,
         q.usable as q_usable, q.last_break::text as q_last_break
    from ev
    left join screener_stocks s on s.ticker = ev.ticker
    left join screener_meta   m on m.ticker = ev.ticker
    left join ticker_price_quality q on q.ticker = ev.ticker
   where ev.day <= (${lastSession}::date - 95)::text`;
console.log(`raw insider-buy events (PIT-dated, room for 63 sessions): ${obsRows.length}`);

// ── 2. PRICES. One fetch per ticker, reused across that ticker's observations. ──
const tickers = [...new Set(obsRows.map((r) => r.ticker))];
const sectorEtfs = [...new Set(Object.values(SECTOR_ETF))];
const need = [...new Set([...tickers, ...sectorEtfs, 'SPY'])];
const arr = `{${need.map((t) => `"${t.replace(/["\\]/g, '')}"`).join(',')}}`;
const barRows = await sql`
  select ticker, date::text as date, close, high, low
    from ticker_daily_candles where ticker = any(${arr}::text[]) order by ticker, date`;
const bars = new Map();
for (const b of barRows) {
  if (!bars.has(b.ticker)) bars.set(b.ticker, []);
  bars.get(b.ticker).push({ date: b.date, close: Number(b.close), high: Number(b.high), low: Number(b.low) });
}
console.log(`price series loaded: ${bars.size} tickers, ${barRows.length} bars`);

// ── 3. 13F STATE AS OF EACH OBSERVATION, strictly by filed_date ──────────────
// The most recent quarter FILED before the observation date — never the quarter that had merely
// ended by then, which is the six-week look-ahead this rule exists to prevent.
// ⚠️ DEFECT FOUND AND FIXED ON THE FIRST RUN, recorded here rather than silently corrected.
//
// The first run read `fund_qoq`, which produced 0 of 4,073 observations with a 13F. The cause is not
// a bug in the join: `fund_qoq` is a PRECOMPUTED SUMMARY OF THE CURRENT QUARTER ONLY — it holds one
// quarter (2026-06-30, first filed 2026-07-01), so no observation old enough to have 63 forward
// sessions can have a 13F filed before it. The table is a production cache, not a history.
//
// The history does exist: `fund_holdings` carries 9 quarters. So quarter-over-quarter accumulation
// is computed here from the holdings themselves, per quarter pair, exactly as rollupFundQoqLive does
// it in production — and keyed by each quarter's FILED date so the point-in-time rule survives.
const qFiled = await sql`
  select quarter::text as quarter, min(filed_date)::text as first_filed
    from fund_holdings where filed_date is not null group by quarter order by quarter`;
console.log(`13F quarters available: ${qFiled.map((q) => `${q.quarter}(filed ${q.first_filed})`).join(', ')}`);

const qq = new Map();
for (let i = 1; i < qFiled.length; i += 1) {
  const cur = qFiled[i].quarter, prev = qFiled[i - 1].quarter;
  const rs = await sql`
    with per_fund as (
      select ticker, cik,
             sum(case when quarter = ${cur}::date then shares else 0 end) cur,
             sum(case when quarter = ${prev}::date then shares else 0 end) prev
        from fund_holdings
       where quarter in (${cur}::date, ${prev}::date) and ticker = any(${arr}::text[]) and put_call = ''
       group by ticker, cik)
    select ticker, count(*) filter (where cur > prev)::int acc, count(*) filter (where cur < prev)::int red
      from per_fund group by ticker`;
  for (const r of rs) qq.set(`${cur}|${r.ticker}`, Number(r.acc) - Number(r.red));
  console.log(`  QoQ ${prev} → ${cur}: ${rs.length} tickers`);
}

function instNetAsOf(ticker, day) {
  let best = null;
  for (const q of qFiled) if (q.first_filed && q.first_filed < day) best = q.quarter;   // strictly before
  if (!best) return null;
  const v = qq.get(`${best}|${ticker}`);
  return v === undefined ? null : v;
}

// ── 4. BUILD THE DATASET ─────────────────────────────────────────────────────
const drop = { noSector: 0, noBars: 0, shortWindow: 0, brokenSeries: 0, noSectorEtf: 0 };
const rows = [];
for (const o of obsRows) {
  const etf = o.sector ? SECTOR_ETF[o.sector] : null;
  if (!o.sector) { drop.noSector += 1; continue; }
  if (!etf) { drop.noSectorEtf += 1; continue; }
  // A return spanning a reused symbol or an unadjusted split is fabricated.
  if (o.q_usable === false || (o.q_last_break && o.q_last_break >= o.day)) { drop.brokenSeries += 1; continue; }
  const own = bars.get(o.ticker);
  if (!own || priceOn(own, o.day) == null) { drop.noBars += 1; continue; }
  const out = horizonOutcome(own, o.day, HORIZON);
  if (!out) { drop.shortWindow += 1; continue; }
  const sec = horizonOutcome(bars.get(etf), o.day, HORIZON);
  const spy = horizonOutcome(bars.get('SPY'), o.day, HORIZON);
  if (!sec) { drop.noSectorEtf += 1; continue; }

  rows.push({
    ticker: o.ticker, day: o.day, asOfMs: Date.parse(`${o.day}T00:00:00Z`),
    sector: o.sector, marketCap: o.market_cap == null ? null : Number(o.market_cap),
    dollars: Number(o.dollars), buyers: Number(o.buyers), hasOfficer: o.has_officer === true,
    ret: out.returnPct,
    rel: out.returnPct - sec.returnPct,
    vsSpy: spy ? out.returnPct - spy.returnPct : null,
    mfe: out.maxFavorablePct, mae: out.maxAdversePct, dd: out.maxDrawdownPct,
    instNet: instNetAsOf(o.ticker, o.day),
  });
}
console.log(`usable observations: ${rows.length}`);
console.log(`dropped: ${JSON.stringify(drop)}\n`);

// ── 5. REPORTING ─────────────────────────────────────────────────────────────
const OVERLAP = overlapFactorFor(HORIZON, 1);   // sampled daily; 63-day labels overlap ~63x
let hypotheses = 0;

function report(label, subset, { indent = 0 } = {}) {
  hypotheses += 1;
  const pre = ' '.repeat(indent);
  if (subset.length < MIN_N) {
    console.log(`${pre}${pad(label, 40)} n=${pad(subset.length, 5)} UNDERPOWERED (min ${MIN_N})`);
    return null;
  }
  const rel = describe(subset.map((r) => r.rel));
  const abs = describe(subset.map((r) => r.ret));
  const t = tStatistic(subset.map((r) => r.rel), { overlapFactor: OVERLAP });
  console.log(`${pre}${pad(label, 40)} n=${pad(subset.length, 5)} ` +
    `rel med ${pct(rel.median)}  mean ${pct(rel.mean)}  hit ${(rel.hitRate * 100).toFixed(0)}%  ` +
    `abs med ${pct(abs.median)}  t=${t ? t.t.toFixed(2) : '—'}`);
  return { label, n: subset.length, rel, abs, t };
}

console.log('=== A. INSIDER BUYING ALONE (63-day, sector-relative) ===');
const all = report('all insider-buy events', rows);
console.log('\n  the baselines it must beat:');
const uni = describe(rows.map((r) => r.ret));
const spyRel = describe(rows.filter((r) => r.vsSpy != null).map((r) => r.vsSpy));
console.log(`  ${pad('universe absolute (own mean)', 40)} n=${pad(rows.length, 5)} med ${pct(uni.median)}  mean ${pct(uni.mean)}`);
console.log(`  ${pad('vs SPY', 40)} n=${pad(spyRel.n, 5)} med ${pct(spyRel.median)}  mean ${pct(spyRel.mean)}`);

console.log('\n=== B. INSIDER STRATA (pre-declared, not searched) ===');
console.log('  by dollar size:');
report('< $50k', rows.filter((r) => r.dollars < 50e3), { indent: 4 });
report('$50k - $250k', rows.filter((r) => r.dollars >= 50e3 && r.dollars < 250e3), { indent: 4 });
report('$250k - $1M', rows.filter((r) => r.dollars >= 250e3 && r.dollars < 1e6), { indent: 4 });
report('>= $1M', rows.filter((r) => r.dollars >= 1e6), { indent: 4 });
console.log('  by distinct buyers that day:');
report('1 buyer', rows.filter((r) => r.buyers === 1), { indent: 4 });
report('2 buyers', rows.filter((r) => r.buyers === 2), { indent: 4 });
report('3+ buyers (cluster)', rows.filter((r) => r.buyers >= 3), { indent: 4 });
console.log('  by role:');
report('includes an officer (CEO/CFO/Chief)', rows.filter((r) => r.hasOfficer), { indent: 4 });
report('no officer', rows.filter((r) => !r.hasOfficer), { indent: 4 });

console.log('\n=== C. DOES 13F ACCUMULATION ADD ANYTHING? ===');
const known = rows.filter((r) => r.instNet != null);
console.log(`  observations with a 13F filed before them: ${known.length} of ${rows.length}`);
const insAcc = known.filter((r) => r.instNet > 0);
const insDist = known.filter((r) => r.instNet < 0);
const insFlat = known.filter((r) => r.instNet === 0);
report('insider buy + institutions ACCUMULATING', insAcc, { indent: 2 });
report('insider buy + institutions DISTRIBUTING', insDist, { indent: 2 });
report('insider buy + institutions flat', insFlat, { indent: 2 });
report('insider buy, 13F unknown', rows.filter((r) => r.instNet == null), { indent: 2 });

console.log('\n=== D. AGREEMENT vs CONTRADICTION ===');
console.log('  (insider SELLING is kept structurally separate and is NOT the inverse of buying —');
console.log('   it is not measured here, and no result below may be read as a claim about selling.)');
const strong = known.filter((r) => r.instNet >= 5);
const weakAcc = known.filter((r) => r.instNet > 0 && r.instNet < 5);
report('agreement: insider buy + strong accumulation (net>=5)', strong, { indent: 2 });
report('agreement: insider buy + mild accumulation', weakAcc, { indent: 2 });
report('contradiction: insider buy + distribution', insDist, { indent: 2 });

console.log('\n=== E. PATH, not just the endpoint ===');
for (const [label, subset] of [['all events', rows], ['+ accumulation', insAcc], ['+ distribution', insDist]]) {
  if (subset.length < MIN_N) continue;
  const mfe = describe(subset.map((r) => r.mfe));
  const mae = describe(subset.map((r) => r.mae));
  const dd = describe(subset.map((r) => r.dd));
  const rel = describe(subset.map((r) => r.rel));
  console.log(`  ${pad(label, 22)} n=${pad(subset.length, 5)} MFE med ${pct(mfe.median)}  MAE med ${pct(mae.median)}  ` +
    `maxDD med ${pct(dd.median)}  rel p10 ${pct(rel.p10)}  rel p90 ${pct(rel.p90)}`);
}

console.log('\n=== F. CONFOUNDERS ===');
console.log('  by market cap (PIT caveat: cap is a CURRENT snapshot — indicative only, not a PIT control):');
for (const [label, lo, hi] of [['< $300M', 0, 3e8], ['$300M - $2B', 3e8, 2e9], ['$2B - $10B', 2e9, 1e10], ['>= $10B', 1e10, Infinity]])
  report(label, rows.filter((r) => r.marketCap != null && r.marketCap >= lo && r.marketCap < hi), { indent: 4 });
console.log('  by sector (top 6 by sample):');
const bySector = new Map();
for (const r of rows) { if (!bySector.has(r.sector)) bySector.set(r.sector, []); bySector.get(r.sector).push(r); }
for (const [s, rs] of [...bySector.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6))
  report(s, rs, { indent: 4 });
console.log('  by calendar half-year:');
const byHalf = new Map();
for (const r of rows) { const k = `${r.day.slice(0, 4)}-H${r.day.slice(5, 7) <= '06' ? 1 : 2}`; if (!byHalf.has(k)) byHalf.set(k, []); byHalf.get(k).push(r); }
for (const [k, rs] of [...byHalf.entries()].sort()) report(k, rs, { indent: 4 });

console.log('\n=== G. WALK-FORWARD (chronological, 63-session embargo) ===');
const days = rows.map((r) => r.asOfMs).sort((a, b) => a - b);
const splits = walkForwardSplits({
  startMs: days[0], endMs: days[days.length - 1],
  trainDays: 180, validateDays: 90, stepDays: 90, embargoDays: 92,   // 63 sessions ≈ 92 calendar days
});
console.log(`  folds: ${splits.length}`);
const foldStats = [];
for (const s of splits) {
  const tr = inRange(rows, s.train), va = inRange(rows, s.validate);
  const trD = describe(tr.map((r) => r.rel)), vaD = describe(va.map((r) => r.rel));
  foldStats.push({ observed: vaD });
  console.log(`  fold ${s.index}  in-sample n=${pad(trD.n, 5)} med ${pct(trD.median)}   ` +
    `OUT-OF-SAMPLE n=${pad(vaD.n, 5)} med ${pct(vaD.median)} mean ${pct(vaD.mean)} hit ${vaD.hitRate == null ? '—' : (vaD.hitRate * 100).toFixed(0) + '%'}`);
}
const stab = stability(foldStats);
console.log(`  stability: ${JSON.stringify(stab)}`);

console.log('\n=== H. MULTIPLE TESTING ===');
const bt = bonferroniThreshold(hypotheses, 0.05);
console.log(`  hypotheses tried: ${bt.hypothesesTried}   alpha ${bt.alpha} → adjusted ${bt.adjustedAlpha.toExponential(2)}`);
console.log(`  overlap factor applied to every t: ${OVERLAP.toFixed(1)}x (63-day labels sampled daily)`);
console.log('\n  ⚠️ t-statistics here are a filter for "obviously nothing", not evidence of significance.');
console.log('     Overlapping labels and same-day cross-sectional correlation both inflate |t|.');
