// Decides, per 13F filing, whether `value` is in dollars or thousands, and records the verdict in
// fund_filing_scale. READ ONLY against fund_holdings: the SEC-reported numbers are never touched.
//
// Method, deterministic and reproducible:
//   1. Sample the filing's COMMON stock positions (no puts/calls) that have a resolved ticker,
//      positive shares, positive value, and a market close on or before the quarter end.
//   2. ratio = (value / shares) / close. A filing reporting dollars lands near 1. One reporting
//      thousands lands near 0.001, because its value column is the dollar figure over 1000.
//   3. Take the MEDIAN ratio across the sample. A median resists the handful of bad rows every
//      large filing has; a mean does not.
//   4. Classify only when the sample is big enough AND tight enough. A wide interquartile spread
//      means the ratios disagree with each other, so the median is not evidence of a unit choice
//      and the filing is left undetermined rather than guessed at.
//
//   dollars    median in [0.5, 2]        -> scale 1
//   thousands  median in [0.0005, 0.002] -> scale 1000
//   inflated   median in [500, 2000]     -> scale 0.001   (rare, the mirror error)
//   otherwise  undetermined, scale NULL, and consumers must exclude the filing from value math
//
//   node --env-file=.env.local scripts/detect-filer-scale.mjs [--quarter=2026-06-30] [--dry]
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const arg = (k) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.split('=')[1] : null; };
const DRY = process.argv.includes('--dry');
const ONE_Q = arg('quarter');

const MIN_SAMPLE = 5;      // below this the median is not evidence
const MAX_IQR = 0.60;      // interquartile spread, relative to the median, above which we decline
const BANDS = [
  { method: 'dollars',   scale: 1,     lo: 0.5,    hi: 2 },
  { method: 'thousands', scale: 1000,  lo: 0.0005, hi: 0.002 },
  { method: 'inflated',  scale: 0.001, lo: 500,    hi: 2000 },
];

const quarters = ONE_Q
  ? [{ quarter: ONE_Q }]
  : await sql`select distinct quarter::text as quarter from fund_holdings order by quarter`;

let wrote = 0;
const tally = {};
for (const { quarter } of quarters) {
  // One pass per quarter keeps the working set bounded while the backfill is still writing.
  const rows = await sql`
    with px as (
      -- Close on or before the quarter end, so a quarter ending on a holiday still prices.
      select distinct on (k.ticker) k.ticker, k.close
        from ticker_daily_candles k
       where k.date <= ${quarter}::date and k.date > ${quarter}::date - 10
       order by k.ticker, k.date desc
    )
    select h.cik,
           percentile_disc(0.5)  within group (order by (h.value / h.shares) / p.close)::float as med,
           percentile_disc(0.25) within group (order by (h.value / h.shares) / p.close)::float as q1,
           percentile_disc(0.75) within group (order by (h.value / h.shares) / p.close)::float as q3,
           count(*)::int as n
      from fund_holdings h
      join px p on p.ticker = h.ticker
     where h.quarter = ${quarter}::date
       and h.put_call = '' and h.ticker is not null
       and h.shares > 0 and h.value > 0 and p.close > 0
     group by h.cik`;

  const out = [];
  for (const r of rows) {
    const med = Number(r.med);
    const iqr = med > 0 ? (Number(r.q3) - Number(r.q1)) / med : Infinity;
    let method = 'indeterminate', scale = null, confidence = 'none';
    if (r.n < MIN_SAMPLE) {
      method = 'insufficient_sample';
    } else if (iqr > MAX_IQR) {
      method = 'indeterminate';           // ratios disagree: not a unit signal
    } else {
      const band = BANDS.find((b) => med >= b.lo && med <= b.hi);
      if (band) { method = band.method; scale = band.scale; confidence = 'high'; }
    }
    tally[method] = (tally[method] || 0) + 1;
    out.push({ cik: r.cik, quarter, scale, method, confidence, med, n: r.n, iqr: Number.isFinite(iqr) ? iqr : null });
  }

  if (!DRY) {
    for (let i = 0; i < out.length; i += 500) {
      const b = out.slice(i, i + 500);
      const vals = b.map((_, j) => {
        const o = j * 8;
        return `($${o + 1},$${o + 2}::date,$${o + 3}::float8,$${o + 4},$${o + 5},$${o + 6}::float8,$${o + 7}::int,$${o + 8}::float8)`;
      }).join(',');
      const params = b.flatMap((o) => [o.cik, o.quarter, o.scale, o.method, o.confidence, o.med, o.n, o.iqr]);
      await sql.query(
        `INSERT INTO fund_filing_scale (cik, quarter, scale_factor, method, confidence, median_ratio, sample_size, iqr_ratio)
         VALUES ${vals}
         ON CONFLICT (cik, quarter) DO UPDATE SET scale_factor = excluded.scale_factor, method = excluded.method,
           confidence = excluded.confidence, median_ratio = excluded.median_ratio, sample_size = excluded.sample_size,
           iqr_ratio = excluded.iqr_ratio, computed_at = now()`, params);
      wrote += b.length;
    }
  }
  console.log(`${quarter}: ${rows.length} filings classified${DRY ? ' (dry)' : ''}`);
}

console.log(`\n${DRY ? 'would write' : 'wrote'} ${wrote} rows`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
