// Detects share-count splits between two 13F quarters and records a factor per ticker.
//
// The signal, and why it is trustworthy: our candles are retroactively SPLIT-ADJUSTED, while 13F
// share counts and dollar values are AS FILED. So across a quarter boundary we have two independent
// views of the same price move:
//
//   priceRatio   = adjusted close at Q / adjusted close at Q-1        (split-neutral by construction)
//   impliedRatio = median(value/shares) at Q / median at Q-1          (carries the raw share basis)
//
// With no split the two agree and their ratio is ~1. After a 10-for-1 forward split the filers'
// shares decuple while their per-share value divides by ten, so impliedRatio/priceRatio lands near
// 1/10. Nothing else moves those two measures apart by an integer-ish multiple, which is what makes
// this specific rather than a heuristic about big numbers.
//
// The median across filers is what makes it safe. One filer misreporting cannot move it; a real
// split moves every filer at once.
//
// CONSERVATIVE BY DESIGN. A factor is recorded only when the divergence sits close to a plausible
// split ratio AND enough filers agree AND both quarters have a usable price. Anything else is
// 'undetermined', and the aggregate must exclude those tickers from QoQ rather than guess.
//
//   node --env-file=.env.local scripts/detect-split-factors.mjs [--dry]
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const DRY = process.argv.includes('--dry');

const MIN_SAMPLES = 4;      // filers on BOTH sides; below this the medians are not evidence
const TOLERANCE = 0.06;     // how close the divergence must sit to a candidate ratio (6%)
const FLAT_BAND = 0.15;     // divergence within 15% of 1.0 is simply "no split"
// Ratios actually used by listed companies. Expressed as the factor applied to PRIOR-quarter shares.
const CANDIDATES = [
  ['2-for-1', 2], ['3-for-1', 3], ['4-for-1', 4], ['5-for-1', 5], ['10-for-1', 10], ['20-for-1', 20],
  ['3-for-2', 1.5], ['5-for-4', 1.25],
  ['1-for-2', 0.5], ['1-for-3', 1 / 3], ['1-for-4', 0.25], ['1-for-5', 0.2],
  ['1-for-10', 0.1], ['1-for-15', 1 / 15], ['1-for-20', 0.05], ['1-for-25', 0.04], ['1-for-50', 0.02],
];

const qs = [];
for (const { q } of await sql`select distinct quarter::text as q from fund_holdings order by q desc limit 8`) {
  const [c] = await sql`select count(distinct cik)::int n from fund_holdings where quarter = ${q}::date`;
  if (c.n >= 100) qs.push(q);
}
const quarter = qs[0], prev = qs[1];
if (!quarter || !prev) { console.error('need two real quarters'); process.exit(1); }
console.log(`${prev} -> ${quarter}${DRY ? ' [DRY]' : ''}`);

const rows = await sql`
  with pc as (select distinct on (ticker) ticker, close from ticker_daily_candles
              where date <= ${quarter}::date and date > ${quarter}::date - 12 order by ticker, date desc),
  pp as (select distinct on (ticker) ticker, close from ticker_daily_candles
         where date <= ${prev}::date and date > ${prev}::date - 12 order by ticker, date desc),
  cur as (
    select h.ticker,
           percentile_disc(0.5) within group (order by (h.value * s.scale_factor) / h.shares)::float med,
           count(*)::int n
      from fund_holdings h
      join security_position_class c on c.cusip = h.cusip and c.cls = h.class and c.put_call = h.put_call
      join fund_filing_scale s on s.cik = h.cik and s.quarter = h.quarter and s.confidence = 'high'
     where h.quarter = ${quarter}::date and c.rankable and h.shares > 0 and h.value > 0
     group by h.ticker),
  prv as (
    select h.ticker,
           percentile_disc(0.5) within group (order by (h.value * s.scale_factor) / h.shares)::float med,
           count(*)::int n
      from fund_holdings h
      join security_position_class c on c.cusip = h.cusip and c.cls = h.class and c.put_call = h.put_call
      join fund_filing_scale s on s.cik = h.cik and s.quarter = h.quarter and s.confidence = 'high'
     where h.quarter = ${prev}::date and c.rankable and h.shares > 0 and h.value > 0
     group by h.ticker)
  select cur.ticker, cur.med cur_med, prv.med prv_med, least(cur.n, prv.n)::int samples,
         pc.close::float cur_px, pp.close::float prv_px
    from cur
    join prv on prv.ticker = cur.ticker
    left join pc on pc.ticker = cur.ticker
    left join pp on pp.ticker = cur.ticker`;

console.log(`tickers with positions in both quarters: ${rows.length.toLocaleString()}`);

const out = [];
const tally = { none: 0, split: 0, undetermined: 0 };
const found = [];
for (const r of rows) {
  const curPx = Number(r.cur_px), prvPx = Number(r.prv_px);
  const curMed = Number(r.cur_med), prvMed = Number(r.prv_med);
  let status = 'undetermined', factor = null, confidence = 'none', divergence = null,
    priceRatio = null, impliedRatio = null;

  const priced = curPx > 0 && prvPx > 0;
  const implied = curMed > 0 && prvMed > 0;
  if (priced && implied && r.samples >= MIN_SAMPLES) {
    priceRatio = curPx / prvPx;
    impliedRatio = curMed / prvMed;
    divergence = impliedRatio / priceRatio;
    if (Math.abs(divergence - 1) <= FLAT_BAND) {
      status = 'none'; factor = 1; confidence = 'high';
    } else {
      // A forward split divides the implied per-share value, so divergence ~ 1/factor.
      const hit = CANDIDATES.find(([, f]) => Math.abs(divergence - 1 / f) <= TOLERANCE / f);
      if (hit) { status = 'split'; factor = hit[1]; confidence = 'high'; found.push([r.ticker, hit[0], divergence]); }
    }
  }
  tally[status]++;
  out.push([r.ticker, quarter, prev, factor, status, confidence, priceRatio, impliedRatio, divergence, r.samples]);
}

console.log(`  no split ${tally.none.toLocaleString()} | split ${tally.split} | undetermined ${tally.undetermined.toLocaleString()}`);
for (const [t, label, d] of found.slice(0, 25)) console.log(`    ${t.padEnd(8)} ${label.padEnd(9)} divergence ${d.toFixed(4)}`);
if (DRY) { console.log('\nnothing written'); process.exit(0); }

await sql`delete from ticker_split_factor where quarter = ${quarter}::date`;
for (let i = 0; i < out.length; i += 400) {
  const b = out.slice(i, i + 400);
  const vals = b.map((_, j) => { const o = j * 10;
    return `($${o+1},$${o+2}::date,$${o+3}::date,$${o+4}::float8,$${o+5},$${o+6},$${o+7}::float8,$${o+8}::float8,$${o+9}::float8,$${o+10}::int)`; }).join(',');
  await sql.query(
    `INSERT INTO ticker_split_factor (ticker, quarter, prev_quarter, factor, status, confidence,
       price_ratio, implied_ratio, divergence, samples) VALUES ${vals}`, b.flat());
}
console.log(`wrote ${out.length.toLocaleString()} rows`);
