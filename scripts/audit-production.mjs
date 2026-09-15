// V1 PRODUCTION-READINESS AUDIT. Read-only. Evidence for correctness and reliability, not features.
//   node --env-file=.env.local scripts/audit-production.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const n = (x) => Number(x).toLocaleString('en-US');
const findings = [];
const flag = (sev, area, issue, evidence) => findings.push({ sev, area, issue, evidence });
const hrs = (t) => t ? ((Date.now() - new Date(t)) / 3.6e6) : null;
const age = (t) => { const h = hrs(t); return h == null ? 'never' : h < 1 ? Math.round(h * 60) + 'm' : h < 48 ? h.toFixed(1) + 'h' : (h / 24).toFixed(1) + 'd'; };

console.log('='.repeat(78));
console.log('  CATALYST PIT V1 — PRODUCTION AUDIT   ' + new Date().toISOString().slice(0, 19));
console.log('='.repeat(78));

// ── 1. FRESHNESS: every table a scheduled job writes ───────────────────────
// [table, timestamp column, cron schedule, max tolerable age in hours]
const FRESH = [
  ['screener_stocks', 'updated_at', 'screener 08:30 daily', 26],
  ['screener_meta', 'updated_at', 'screener-meta 07:30 daily', 30],
  ['screener_fundamentals', 'updated_at', 'screener-fundamentals 07:50 daily', 30],
  ['primary_events', 'received_at', 'primary-sources every minute', 1],
  ['canonical_events', 'created_at', 'primary-sources every minute', 6],
  ['insider_trades', 'filing_date', 'refresh?form4=1 every minute', 96],
  ['eightk_filings', 'filed_at', 'eightk every 5 min', 96],
  ['congress_trades', 'disclosure_date', 'congress-sync hourly', 336],
  ['fund_holdings', 'filed_date', 'institutions-universe hourly', 720],
  ['fund_filings', 'filed_date', 'institutions-universe hourly', 720],
  ['ticker_institutional_ownership', 'updated_at', 'institutions-ownership 06:30 daily', 30],
  ['institution_heatmap_meta', 'computed_at', 'manual/heatmap build', 240],
  ['ticker_daily_candles', 'date', 'candle warmers', 120],
  ['short_interest', 'settlement_date', 'sync-short-interest weekly', 504],
  ['x_post_candidates', 'created_at', 'x-autopost every minute', 6],
  ['fb_post_candidates', 'created_at', 'facebook every minute', 24],
  ['ticker_float', 'updated_at', 'float refresh', 720],
];
console.log('\n### 1. SCHEDULED-JOB FRESHNESS');
console.log('  table                          rows        newest      age     tolerance');
for (const [t, col, cron, tol] of FRESH) {
  try {
    const [r] = await sql.query(`select count(*)::int c, max(${col})::text m from ${t}`);
    const a = hrs(r.m);
    const bad = a == null || a > tol;
    console.log('  ' + (bad ? '! ' : '  ') + t.padEnd(30) + n(r.c).padStart(9) + '  '
      + String(r.m ?? '-').slice(0, 16).padEnd(17) + age(r.m).padStart(7) + '   <' + tol + 'h');
    if (bad) flag(a == null ? 'HIGH' : a > tol * 3 ? 'HIGH' : 'MEDIUM', t,
      `stale vs its cron (${cron})`, `newest ${String(r.m).slice(0, 19)}, age ${age(r.m)}, tolerance ${tol}h`);
  } catch (e) { console.log('  ? ' + t.padEnd(30) + ' ERROR ' + String(e.message).slice(0, 40)); }
}

// ── 2. DUPLICATES / IDENTITY ───────────────────────────────────────────────
console.log('\n### 2. DUPLICATE + IDENTITY INTEGRITY');
const DUP = [
  ['primary_events canonical content_hash', `select count(*)::int c from (select content_hash from primary_events where cluster_id is null group by content_hash having count(*)>1) z`],
  ['screener_stocks ticker', `select count(*)::int c from (select ticker from screener_stocks group by ticker having count(*)>1) z`],
  ['x_post_candidates event_seq', `select count(*)::int c from (select event_seq from x_post_candidates where event_seq is not null group by event_seq having count(*)>1) z`],
  ['fb_post_candidates content_hash', `select count(*)::int c from (select content_hash from fb_post_candidates group by content_hash having count(*)>1) z`],
  ['cusip_map cusip->multiple tickers', `select count(*)::int c from (select cusip from cusip_map where ticker is not null group by cusip having count(distinct ticker)>1) z`],
  ['ticker_institutional_ownership ticker', `select count(*)::int c from (select ticker from ticker_institutional_ownership group by ticker having count(*)>1) z`],
  ['screener company = industry (SIC contamination)', `select count(*)::int c from screener_stocks where company is not null and company = industry`],
  ['fund_holdings non-ticker-shaped tickers', `select count(*)::int c from fund_holdings where ticker is not null and ticker !~ '^[A-Z][A-Z0-9.-]{0,8}$'`],
];
for (const [label, q] of DUP) {
  const [r] = await sql.query(q);
  console.log('  ' + (r.c ? '! ' : '  ') + label.padEnd(50) + n(r.c));
  if (r.c) flag(label.includes('contamination') || label.includes('multiple') ? 'HIGH' : 'MEDIUM',
    label.split(' ')[0], label, n(r.c) + ' rows');
}

// ── 3. IMPOSSIBLE VALUES ───────────────────────────────────────────────────
console.log('\n### 3. IMPOSSIBLE / OUT-OF-RANGE VALUES');
const IMP = [
  ['screener price <= 0', `select count(*)::int c from screener_stocks where price is not null and price <= 0`],
  ['screener rsi14 outside 0-100', `select count(*)::int c from screener_stocks where rsi14 is not null and (rsi14 < 0 or rsi14 > 100)`],
  ['screener short_float > 100%', `select count(*)::int c from screener_stocks where short_float is not null and short_float > 100`],
  ['screener market_cap < 0', `select count(*)::int c from screener_stocks where market_cap is not null and market_cap < 0`],
  ['screener perf_1y beyond -100/+10000%', `select count(*)::int c from screener_stocks where perf_1y is not null and (perf_1y < -100 or perf_1y > 10000)`],
  ['institutional ownership_pct > 100', `select count(*)::int c from ticker_institutional_ownership where ownership_pct is not null and ownership_pct > 100`],
  ['fund_holdings negative shares', `select count(*)::int c from fund_holdings where shares is not null and shares < 0`],
  ['candles high < low', `select count(*)::int c from ticker_daily_candles where high < low`],
  ['candles close <= 0', `select count(*)::int c from ticker_daily_candles where close is not null and close <= 0`],
  ['events published in the future', `select count(*)::int c from primary_events where published_at > now() + interval '1 hour'`],
];
for (const [label, q] of IMP) {
  const [r] = await sql.query(q);
  console.log('  ' + (r.c ? '! ' : '  ') + label.padEnd(50) + n(r.c));
  if (r.c) flag(r.c > 1000 ? 'HIGH' : 'MEDIUM', 'data-quality', label, n(r.c) + ' rows');
}

console.log('\n### SUMMARY');
for (const s of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
  const f = findings.filter((x) => x.sev === s);
  if (f.length) { console.log('  ' + s + ' (' + f.length + ')'); for (const x of f) console.log('    - [' + x.area + '] ' + x.issue + '  |  ' + x.evidence); }
}
if (!findings.length) console.log('  no findings in sections 1-3');
