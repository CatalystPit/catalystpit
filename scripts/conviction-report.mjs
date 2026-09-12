// scripts/conviction-report.mjs
//
// Post-backfill validation for the Conviction model. Run AFTER the historical walk
// completes and after build-insider-context + score-conviction have been re-run on the
// expanded history:
//
//   node --env-file=.env.local            scripts/build-insider-context.mjs
//   node --conditions react-server --env-file=.env.local scripts/score-conviction.mjs
//   node --conditions react-server --env-file=.env.local scripts/conviction-report.mjs
//
// Reports the distribution, examples in every band, and the specific behaviours the
// model is supposed to capture — CEO/CFO purchases, cluster buys, first buys after long
// gaps, repeat buyers, unusually large purchases and ownership increases — so that
// recalibration is driven by evidence rather than by taste.

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20, connect_timeout: 30 });

const line = (s) => console.log(s);
const hdr = (s) => { console.log('\n' + '─'.repeat(78)); console.log(s); console.log('─'.repeat(78)); };

// A scenario is a WHERE clause plus what we expect to see. Printing the median and the
// band mix per scenario is what exposes a mis-weighted factor: if "first buy after a long
// gap" does not out-score "routine repeat buyer", the rarity term is not doing its job.
const SCENARIOS = [
  ['CEO purchases',              `title ILIKE '%chief executive%' OR title ILIKE '%CEO%'`],
  ['CFO purchases',              `title ILIKE '%chief financial%' OR title ILIKE '%CFO%'`],
  ['Cluster buys (3+ insiders)', `cluster_insiders_10d >= 3`],
  ['Cluster buys (5+ insiders)', `cluster_insiders_10d >= 5`],
  ['First buy in stored history', `is_first_om_buy = true`],
  ['First buy after 12m+ gap',   `months_since_prev_buy >= 12`],
  ['First buy after 24m+ gap',   `months_since_prev_buy >= 24`],
  ['Repeat buyers (4+ in 12m)',  `om_buys_12m >= 4`],
  ['Ownership increase >= 50%',  `ownership_increase_pct >= 50`],
  ['Ownership increase >= 200%', `ownership_increase_pct >= 200`],
  ['Purchases >= $1M',           `total_value >= 1000000`],
  ['Purchases >= $10M',          `total_value >= 10000000`],
  ['Purchases < $50k (damped)',  `total_value < 50000`],
  ['10b5-1 plan purchases',      `rule_10b5_1 = true`],
  ['Explicitly discretionary',   `rule_10b5_1 = false`],
  ['Indirect ownership',         `ownership_type = 'I'`],
];

(async () => {
  const [h] = await sql`SELECT covered_from::text cf, covered_to::text ct, complete FROM insider_history_meta WHERE id = 1`;
  const [st] = await sql`SELECT cursor_date::text cur, target_from::text tgt, filings_seen, filings_parsed, rows_written, rows_quarantined FROM insider_ingest_state WHERE job = 'form4-backfill'`;
  const [tot] = await sql`SELECT count(*)::int n, min(filing_date)::text mn, max(filing_date)::text mx,
                                 count(DISTINCT accession)::int acc, count(DISTINCT ticker)::int tk,
                                 count(*) FILTER (WHERE transaction_code = 'P')::int buys,
                                 count(*) FILTER (WHERE rule_10b5_1 IS NOT NULL)::int tenb5,
                                 count(*) FILTER (WHERE is_amendment)::int amend,
                                 count(*) FILTER (WHERE superseded_by IS NOT NULL)::int superseded
                          FROM insider_trades`;
  const [q] = await sql`SELECT count(*)::int n FROM insider_quarantine`;

  hdr('COVERAGE');
  line(`history covered      ${h?.cf || '?'} .. ${h?.ct || '?'}   complete=${h?.complete}`);
  line(`backfill cursor      ${st?.cur || '-'}   target ${st?.tgt || '-'}`);
  line(`filings seen/parsed  ${st?.filings_seen || 0} / ${st?.filings_parsed || 0}`);
  line(`insider_trades       ${tot.n} rows   ${tot.acc} accessions   ${tot.tk} tickers   ${tot.mn}..${tot.mx}`);
  line(`open-market buys     ${tot.buys}`);
  line(`10b5-1 determined    ${tot.tenb5} (${(tot.tenb5 / Math.max(tot.n, 1) * 100).toFixed(1)}%)`);
  line(`amendments / superseded  ${tot.amend} / ${tot.superseded}`);
  line(`quarantined          ${q.n}`);

  const qr = await sql`SELECT reason, count(*)::int n FROM insider_quarantine GROUP BY 1 ORDER BY n DESC`;
  if (qr.length) { line('quarantine by reason:'); for (const r of qr) line(`   ${r.reason.padEnd(26)} ${r.n}`); }

  hdr('SCORE DISTRIBUTION');
  const [d] = await sql`
    SELECT count(*)::int scored,
           count(*) FILTER (WHERE conviction_band='LOW')::int low,
           count(*) FILTER (WHERE conviction_band='MODERATE')::int moderate,
           count(*) FILTER (WHERE conviction_band='HIGH')::int high,
           count(*) FILTER (WHERE conviction_band='VERY HIGH')::int very_high,
           count(*) FILTER (WHERE conviction_band='EXTREME')::int extreme,
           min(conviction)::int mn, max(conviction)::int mx,
           round(avg(conviction)::numeric,1)::text avg,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY conviction)::int p25,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY conviction)::int p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY conviction)::int p75,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY conviction)::int p95
    FROM insider_trades WHERE conviction IS NOT NULL`;
  if (!d.scored) { line('nothing scored'); await sql.end(); return; }
  line(`scored ${d.scored}   min ${d.mn}  p25 ${d.p25}  median ${d.p50}  avg ${d.avg}  p75 ${d.p75}  p95 ${d.p95}  max ${d.mx}`);
  const bar = (n) => '█'.repeat(Math.round(n / d.scored * 40));
  for (const [k, label] of [['low', 'LOW       0-39'], ['moderate', 'MODERATE 40-59'], ['high', 'HIGH     60-74'], ['very_high', 'VERY HIGH 75-89'], ['extreme', 'EXTREME  90-100']]) {
    line(`  ${label}  ${String(d[k]).padStart(7)}  ${(d[k] / d.scored * 100).toFixed(1).padStart(5)}%  ${bar(d[k])}`);
  }

  hdr('EXAMPLES BY BAND');
  for (const band of ['LOW', 'MODERATE', 'HIGH', 'VERY HIGH', 'EXTREME']) {
    const rows = await sql`
      SELECT ticker, executive, title, conviction, total_value, transaction_date::text td, conviction_tags
      FROM insider_trades WHERE conviction_band = ${band}
      ORDER BY conviction DESC, total_value DESC LIMIT 3`;
    line(`\n${band}`);
    if (!rows.length) { line('   (none)'); continue; }
    for (const r of rows) {
      let tags = []; try { tags = JSON.parse(r.conviction_tags || '[]'); } catch { /* ignore */ }
      line(`   ${String(r.conviction).padStart(3)}  ${String(r.ticker).padEnd(7)} $${(Number(r.total_value) / 1e6).toFixed(2).padStart(9)}M  ${r.td}  ${String(r.executive || '').slice(0, 22).padEnd(23)} ${tags.join(' · ')}`);
    }
  }

  hdr('BEHAVIOUR CHECKS — does the model reward what it is supposed to?');
  line(`${'scenario'.padEnd(30)} ${'n'.padStart(7)} ${'median'.padStart(7)} ${'avg'.padStart(6)} ${'p95'.padStart(5)}   band mix (L/M/H/VH/E)`);
  for (const [label, where] of SCENARIOS) {
    const [r] = await sql.unsafe(`
      SELECT count(*)::int n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY conviction)::int p50,
             round(avg(conviction)::numeric,1)::text avg,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY conviction)::int p95,
             count(*) FILTER (WHERE conviction_band='LOW')::int l,
             count(*) FILTER (WHERE conviction_band='MODERATE')::int m,
             count(*) FILTER (WHERE conviction_band='HIGH')::int h,
             count(*) FILTER (WHERE conviction_band='VERY HIGH')::int v,
             count(*) FILTER (WHERE conviction_band='EXTREME')::int e
      FROM insider_trades WHERE conviction IS NOT NULL AND (${where})`);
    if (!r.n) { line(`${label.padEnd(30)} ${'0'.padStart(7)}   (no rows)`); continue; }
    line(`${label.padEnd(30)} ${String(r.n).padStart(7)} ${String(r.p50).padStart(7)} ${String(r.avg).padStart(6)} ${String(r.p95).padStart(5)}   ${r.l}/${r.m}/${r.h}/${r.v}/${r.e}`);
  }

  hdr('SANITY — eligibility');
  const [el] = await sql`
    SELECT count(*) FILTER (WHERE conviction IS NOT NULL AND transaction_code <> 'P')::int wrong_code,
           count(*) FILTER (WHERE conviction IS NOT NULL AND is_derivative)::int wrong_deriv,
           count(*) FILTER (WHERE conviction IS NOT NULL AND superseded_by IS NOT NULL)::int wrong_superseded,
           count(*) FILTER (WHERE conviction IS NOT NULL AND total_value <= 0)::int wrong_value,
           count(*) FILTER (WHERE conviction > 74 AND total_value < 50000)::int broke_deminimis
    FROM insider_trades`;
  line(`non-P rows scored ............ ${el.wrong_code}   (must be 0)`);
  line(`derivative rows scored ....... ${el.wrong_deriv}   (must be 0)`);
  line(`superseded rows scored ....... ${el.wrong_superseded}   (must be 0)`);
  line(`zero/negative value scored ... ${el.wrong_value}   (must be 0)`);
  line(`sub-$50k above HIGH .......... ${el.broke_deminimis}   (must be 0 — de-minimis ceiling)`);

  await sql.end();
})();
