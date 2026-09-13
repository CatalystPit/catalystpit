// Rebuilds institution_heatmap: one row per ticker with its quarter-over-quarter institutional
// position change. Every integrity guard we built is applied here, in one place, so the page cannot
// accidentally render unguarded numbers.
//
//   RANKABLE       common stock and ADRs only. Bonds are 1.9% of positions but 17.4% of summed
//                  shares, and ETFs are not a view on a company.
//   SCALE          value multiplied by the filing's detected scale factor. 591 filings still report
//                  thousands. Filings whose scale we could not determine are EXCLUDED, not assumed.
//   PLAUSIBILITY   a position whose implied price (value/shares) is outside 0.2x to 5x of the
//                  quarter-end close is dropped. 0.83% of rows, carrying 18.2% of summed shares.
//   PAIRED FUNDS   only funds that filed in BOTH quarters. Otherwise the comparison measures our
//                  own ingestion progress, which is still running.
//   AMENDMENTS     handled upstream in the ingest: a quarter is composed of its base filing plus
//                  additive 13F-HR/A amendments.
//
//   node --env-file=.env.local scripts/build-institution-heatmap.mjs [--quarter=2026-06-30]
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const arg = (k) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.split('=')[1] : null; };

const qs = await sql`select distinct quarter::text as q from fund_holdings order by q desc limit 8`;
const real = [];
for (const { q } of qs) {
  const [c] = await sql`select count(distinct cik)::int n from fund_holdings where quarter = ${q}::date`;
  if (c.n >= 100) real.push(q);                 // ignore the single-fund legacy quarters
}
const quarter = arg('quarter') || real[0];
const prev = real[real.indexOf(quarter) + 1];
if (!quarter || !prev) { console.error('need two real quarters'); process.exit(1); }
console.log(`building ${quarter} against ${prev}`);

const rows = await sql`
  with pc as (select distinct on (ticker) ticker, close from ticker_daily_candles
              where date <= ${quarter}::date and date > ${quarter}::date - 12 order by ticker, date desc),
  pp as (select distinct on (ticker) ticker, close from ticker_daily_candles
         where date <= ${prev}::date and date > ${prev}::date - 12 order by ticker, date desc),
  paired as (select distinct cik from fund_holdings where quarter = ${quarter}::date
             intersect select distinct cik from fund_holdings where quarter = ${prev}::date),
  cur as (
    select h.ticker, max(h.issuer) issuer, sum(h.shares) sh,
           sum(h.value * s.scale_factor) val, count(distinct h.cik)::int funds
      from fund_holdings h
      join security_position_class c on c.cusip = h.cusip and c.cls = h.class and c.put_call = h.put_call
      join pc p on p.ticker = h.ticker
      join paired f on f.cik = h.cik
      join fund_filing_scale s on s.cik = h.cik and s.quarter = h.quarter and s.confidence = 'high'
     where h.quarter = ${quarter}::date and c.rankable and h.shares > 0 and h.value > 0
       and (h.value * s.scale_factor) / h.shares between p.close * 0.2 and p.close * 5
     group by h.ticker),
  prv as (
    select h.ticker, sum(h.shares) sh
      from fund_holdings h
      join security_position_class c on c.cusip = h.cusip and c.cls = h.class and c.put_call = h.put_call
      join pp p on p.ticker = h.ticker
      join paired f on f.cik = h.cik
      join fund_filing_scale s on s.cik = h.cik and s.quarter = h.quarter and s.confidence = 'high'
     where h.quarter = ${prev}::date and c.rankable and h.shares > 0 and h.value > 0
       and (h.value * s.scale_factor) / h.shares between p.close * 0.2 and p.close * 5
     group by h.ticker)
  select c.ticker, c.issuer, m.sector,
         c.sh::float cur_sh,
         -- SPLIT ADJUSTMENT. 13F share counts are as filed, so a 10-for-1 split between quarters
         -- looks like a tenfold purchase nobody made. Prior-quarter shares are restated onto the
         -- current basis before differencing. fund_holdings is untouched: the factor is applied
         -- here, at read time, from ticker_split_factor.
         (coalesce(p.sh, 0) * coalesce(sf.factor, 1))::float prev_sh,
         c.val::float val, c.funds,
         coalesce(sf.status, 'unscanned') split_status, sf.factor split_factor
    from cur c
    left join prv p on p.ticker = c.ticker
    left join screener_meta m on m.ticker = c.ticker
    left join ticker_split_factor sf on sf.ticker = c.ticker and sf.quarter = ${quarter}::date
   where c.val > 0
     -- A ticker we hold in BOTH quarters but whose split status we could not establish is excluded
     -- from the map rather than shown with a delta that might be a corporate action. A ticker that
     -- is new this quarter has no prior shares to restate, so it is unaffected.
     and (p.sh is null or coalesce(sf.status, 'unscanned') in ('none', 'split'))`;

console.log(`tickers: ${rows.length.toLocaleString()}`);

await sql`delete from institution_heatmap where quarter = ${quarter}::date`;
let wrote = 0;
for (let i = 0; i < rows.length; i += 400) {
  const b = rows.slice(i, i + 400).map((r) => {
    const cur = Number(r.cur_sh), pv = Number(r.prev_sh);
    return [quarter, prev, r.ticker, r.sector, r.issuer, cur, pv, cur - pv,
      pv > 0 ? ((cur - pv) / pv) * 100 : null, Number(r.val), r.funds, pv === 0];
  });
  const vals = b.map((_, j) => { const o = j * 12;
    return `($${o+1}::date,$${o+2}::date,$${o+3},$${o+4},$${o+5},$${o+6}::float8,$${o+7}::float8,$${o+8}::float8,$${o+9}::float8,$${o+10}::float8,$${o+11}::int,$${o+12}::boolean)`; }).join(',');
  await sql.query(
    `INSERT INTO institution_heatmap (quarter, prev_quarter, ticker, sector, issuer, cur_shares,
       prev_shares, delta_shares, pct_change, cur_value, funds, is_new) VALUES ${vals}`, b.flat());
  wrote += b.length;
}

// Coverage: what the guards left out, measured against the whole rankable universe.
const [all] = await sql`
  select sum(h.value)::float val from fund_holdings h
   join security_position_class c on c.cusip = h.cusip and c.cls = h.class and c.put_call = h.put_call
  where h.quarter = ${quarter}::date and c.rankable and h.value > 0`;
const [cov] = await sql`
  select count(*)::int tickers, count(sector)::int sectored,
         sum(cur_value)::float covered, sum(cur_value) filter (where sector is null)::float unclassified
    from institution_heatmap where quarter = ${quarter}::date`;
const [fc] = await sql`
  select (select count(distinct cik) from fund_holdings where quarter = ${quarter}::date)::int cur,
         (select count(*) from (select distinct cik from fund_holdings where quarter = ${quarter}::date
            intersect select distinct cik from fund_holdings where quarter = ${prev}::date) z)::int both`;

await sql`
  insert into institution_heatmap_meta (quarter, prev_quarter, tickers, sectored_tickers, covered_value,
    excluded_value, unclassified_value, funds_both, funds_current)
  values (${quarter}::date, ${prev}::date, ${cov.tickers}, ${cov.sectored}, ${cov.covered},
    ${Number(all.val) - Number(cov.covered)}, ${cov.unclassified || 0}, ${fc.both}, ${fc.cur})
  on conflict (quarter) do update set prev_quarter = excluded.prev_quarter, tickers = excluded.tickers,
    sectored_tickers = excluded.sectored_tickers, covered_value = excluded.covered_value,
    excluded_value = excluded.excluded_value, unclassified_value = excluded.unclassified_value,
    funds_both = excluded.funds_both, funds_current = excluded.funds_current, computed_at = now()`;

console.log(`wrote ${wrote.toLocaleString()} rows`);
console.log(`  sectored ${cov.sectored}/${cov.tickers} tickers`);
console.log(`  covered $${(Number(cov.covered) / 1e12).toFixed(2)}T of $${(Number(all.val) / 1e12).toFixed(2)}T rankable`);
console.log(`  unclassified inside the map $${(Number(cov.unclassified || 0) / 1e9).toFixed(0)}B`);
console.log(`  funds ${fc.both} of ${fc.cur} filed both quarters`);
