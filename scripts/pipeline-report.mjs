// PIPELINE FRESHNESS REPORT — read-only. Answers "are the daily research clocks actually running".
//   node --env-file=.env.local scripts/pipeline-report.mjs
//
// Freshness and INGEST are deliberately different columns. A job can exit cleanly having written
// nothing, so "the table has recent rows" and "the job wrote rows recently" are separate facts —
// the same distinction /api/health draws between freshness and completeness.

import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

const q = (text) => sql.query(text);
const one = async (text) => (await q(text))[0] || {};
const ageH = (d) => (d == null ? null : (Date.now() - new Date(d).getTime()) / 36e5);
const fmtAge = (h) => (h == null ? 'never' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);

// [label, table, event-date column, ingest timestamp column]
const SETS = [
  ['Insiders / Form 4',   'insider_trades',  'filing_date',      'inserted_at'],
  ['Congress',            'congress_trades', 'disclosure_date',  'inserted_at'],
  ['13F holdings',        'fund_holdings',   'filed_date',       'inserted_at'],
  ['13F filings',         'fund_filings',    'filed_date',       'inserted_at'],
  ['8-K',                 'eightk_filings',  'filed_at',         'inserted_at'],
  ['Daily candles',       'ticker_daily_candles', 'date',        null],
  ['Screener',            'screener_stocks', 'updated_at',       null],
];

console.log('## Dataset freshness\n');
console.log('| dataset | newest event | age | ingested 24h | ingested 7d | total rows |');
console.log('|---|---|---|---|---|---|');
for (const [label, table, evCol, inCol] of SETS) {
  try {
    const r = await one(
      `select max(${evCol})::text newest, count(*)::bigint total`
      + (inCol ? `, count(*) filter (where ${inCol} > now() - interval '24 hours')::bigint d1,
                   count(*) filter (where ${inCol} > now() - interval '7 days')::bigint d7` : '')
      + ` from ${table}`);
    const h = ageH(r.newest);
    console.log(`| ${label} | ${r.newest ?? '—'} | ${fmtAge(h)} | ${inCol ? r.d1 : 'n/a'} | ${inCol ? r.d7 : 'n/a'} | ${r.total} |`);
  } catch (e) {
    console.log(`| ${label} | QUERY FAILED | — | — | — | ${String(e.message).slice(0, 60)} |`);
  }
}

// ── feed_state: the per-feed clock the ingest paths already write ───────────
console.log('\n## feed_state (what the ingest paths already record)\n');
try {
  const rows = await q(`select feed_key,
      last_polled_at::text polled, last_success_at::text success, last_status,
      consecutive_failures cf, events_seen, left(coalesce(note,''), 48) note
    from feed_state order by last_success_at desc nulls last`);
  console.log('| feed | last success | age | last poll | status | fails | seen | note |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.feed_key} | ${r.success ?? 'never'} | ${fmtAge(ageH(r.success))} | ${fmtAge(ageH(r.polled))} ago | ${r.last_status ?? '—'} | ${r.cf ?? 0} | ${r.events_seen ?? 0} | ${r.note || ''} |`);
  }
  if (!rows.length) console.log('| (empty) | | | | | | | |');
} catch (e) {
  console.log(`feed_state unavailable: ${e.message}`);
}

// ── Congress point-in-time integrity ────────────────────────────────────────
console.log('\n## Congress date integrity\n');
try {
  const r = await one(`select
      count(*) filter (where disclosure_date > current_date)::int future_disc,
      count(*) filter (where transaction_date > disclosure_date)::int impossible,
      count(*) filter (where disclosure_date is null)::int no_disc,
      count(*) filter (where transaction_date > current_date)::int future_tx,
      count(*)::bigint total from congress_trades`);
  console.log(`- rows: ${r.total}`);
  console.log(`- disclosure_date in the future: **${r.future_disc}**`);
  console.log(`- transaction_date after its own disclosure (impossible): **${r.impossible}**`);
  console.log(`- transaction_date in the future: **${r.future_tx}**`);
  console.log(`- missing disclosure_date: ${r.no_disc}`);
} catch (e) { console.log(`failed: ${e.message}`); }

// ── 13F: quarterly by nature, so say which quarter and whether it is filing season ──
console.log('\n## 13F filing window\n');
try {
  const r = await one(`select max(quarter)::text q, max(filed_date)::text f,
      count(*) filter (where inserted_at > now() - interval '7 days')::int d7 from fund_filings`);
  console.log(`- newest quarter: ${r.q} · newest filed: ${r.f} · filings ingested 7d: ${r.d7}`);
} catch (e) { console.log(`failed: ${e.message}`); }

console.log('\n_generated ' + new Date().toISOString() + '_');
