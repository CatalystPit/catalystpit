// PHASE 1 — PRICE ADJUSTMENT SEAM AUDIT. Read-only.
//
// Finds every point where ticker_daily_candles changes SOURCE between consecutive rows, and
// measures the one-day move across that boundary against the ticker's own normal daily move.
//
// A source change is not automatically a defect: if a ticker's Polygon and Tiingo rows happen to
// sit either side of a period with no dividends, the conventions agree and the handoff is
// invisible. The defect is a source change accompanied by a move the security itself does not
// make — so the test is the boundary return in units of that ticker's own volatility, not the
// presence of two sources.
//
// Run: node --env-file=.env.local research/price-seam-audit.mjs

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const L = (s = '') => console.log(s);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

// A boundary move this many times the ticker's median absolute daily move is not price action.
const SIGMA = 6;
// And this much in absolute percent, so a very quiet stock does not trip on noise.
const MIN_PCT = 1.0;

L('=== every source transition in ticker_daily_candles ===');
const rows = await sql.query(`
  with s as (
    select ticker, date, close, source,
           lag(source) over (partition by ticker order by date) prev_src,
           lag(close)  over (partition by ticker order by date) prev_close,
           lag(date)   over (partition by ticker order by date) prev_date
      from ticker_daily_candles
  ),
  moves as (
    select ticker, date, close, source, prev_src, prev_close, prev_date,
           abs((close - prev_close) / nullif(prev_close,0)) * 100 as move_pct
      from s where prev_src is not null
  ),
  norm as (
    select ticker, percentile_cont(0.5) within group (order by move_pct) med_move
      from moves group by ticker
  )
  select m.ticker, m.date::text d, m.prev_date::text pd, m.prev_src, m.source,
         m.prev_close, m.close,
         round(((m.close - m.prev_close)/nullif(m.prev_close,0)*100)::numeric, 2) gap_pct,
         round(n.med_move::numeric, 3) med_move
    from moves m join norm n using (ticker)
   where m.source is distinct from m.prev_src
   order by abs((m.close - m.prev_close)/nullif(m.prev_close,0)) desc`);

L(`  source transitions found: ${rows.length}`);
const byTicker = new Map();
for (const r of rows) {
  if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
  byTicker.get(r.ticker).push(r);
}
L(`  tickers containing at least one transition: ${byTicker.size}`);

// Classify each transition.
const material = [], benign = [];
for (const r of rows) {
  const gap = Math.abs(Number(r.gap_pct));
  const med = Number(r.med_move) || 0.5;
  (gap >= MIN_PCT && gap >= SIGMA * med ? material : benign).push({ ...r, gap, med, sigma: gap / med });
}
L(`\n  MATERIAL seams (>= ${MIN_PCT}% and >= ${SIGMA}x the ticker's median daily move): ${material.length}`);
L(`  benign transitions (conventions agreed at that point):                      ${benign.length}`);

const matTickers = new Set(material.map((m) => m.ticker));
L(`  distinct tickers materially affected: ${matTickers.size}`);

L('\n  worst 20 material seams:');
L(`    ${'ticker'.padEnd(8)} ${'boundary'.padEnd(24)} ${'close before'.padStart(13)} ${'close after'.padStart(12)} ${'gap'.padStart(8)} ${'x median'.padStart(9)}`);
for (const m of material.slice(0, 20)) {
  L(`    ${m.ticker.padEnd(8)} ${(`${m.pd} ${m.prev_src}->${m.source}`).padEnd(24)}`
    + ` ${String(Number(m.prev_close).toFixed(2)).padStart(13)} ${String(Number(m.close).toFixed(2)).padStart(12)}`
    + ` ${String(m.gap_pct + '%').padStart(8)} ${String(m.sigma.toFixed(1)).padStart(9)}`);
}

// The date range each affected ticker is contaminated across: everything on the older-convention
// side of its earliest material seam is on a different basis from everything after it.
L('\n=== contaminated ranges (what a consumer must not compare across) ===');
const ranges = [];
for (const t of matTickers) {
  const seams = material.filter((m) => m.ticker === t).sort((a, b) => a.d.localeCompare(b.d));
  const cov = await sql.query(
    'select min(date)::text mn, max(date)::text mx, count(*)::int n from ticker_daily_candles where ticker=$1', [t]);
  ranges.push({ ticker: t, first: seams[0].d, seams: seams.length, ...cov[0] });
}
ranges.sort((a, b) => b.n - a.n);
L(`    ${'ticker'.padEnd(8)} ${'history'.padEnd(26)} ${'bars'.padStart(6)} ${'seams'.padStart(6)} ${'first seam'.padStart(12)}`);
for (const r of ranges.slice(0, 25)) {
  L(`    ${r.ticker.padEnd(8)} ${(`${r.mn} -> ${r.mx}`).padEnd(26)} ${String(r.n).padStart(6)} ${String(r.seams).padStart(6)} ${String(r.first).padStart(12)}`);
}
if (ranges.length > 25) L(`    … and ${ranges.length - 25} more`);

L('\n=== how much of the table is on each convention ===');
for (const r of await sql.query(`select source, count(*)::bigint rows,
    round(100.0*count(*)/sum(count(*)) over (), 2) pct from ticker_daily_candles group by source order by rows desc`)) {
  L(`  ${String(r.source).padEnd(10)} ${String(r.rows).padStart(9)} rows  ${r.pct}%`);
}

L('\n=== would the existing break detector catch any of these? ===');
const brk = await sql.query(`select count(*)::int c from ticker_price_breaks`);
L(`  total breaks recorded in ticker_price_breaks: ${brk[0].c}`);
let caught = 0;
for (const m of material) {
  const hit = await sql.query(
    `select 1 from ticker_price_breaks where ticker=$1 and break_date between $2::date - 3 and $2::date + 3 limit 1`,
    [m.ticker, m.d]);
  if (hit.length) caught++;
}
L(`  material seams flagged by it: ${caught} of ${material.length} (${pct(caught, material.length)}%)`);
L(`  -> the scan targets sustained 4x level shifts; an adjustment seam of a few percent is invisible.`);
