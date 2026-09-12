import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const cols = await sql.query(`select column_name from information_schema.columns where table_name='insider_trades' order by ordinal_position`);
const have = new Set(cols.map(c => c.column_name));
const want = ['issuer_cik','owner_cik','period_of_report','form_type','is_amendment','amends_accession','superseded_by','acquired_disposed','ownership_type','ownership_nature','is_derivative','is_officer','is_director','is_ten_pct_owner','is_other_relation','ctx_computed_at','is_first_om_buy','prev_om_buy_date','months_since_prev_buy','om_buys_3m','om_buys_6m','om_buys_12m','om_buys_24m','om_buys_36m','om_buys_total','ownership_increase_pct','is_repeat_buyer','cluster_insiders_10d','conviction','conviction_band','conviction_tags','conviction_at'];
const missing = want.filter(c => !have.has(c));
console.log('insider_trades columns:', cols.length, missing.length ? ('MISSING: ' + missing.join(',')) : 'all 0007 columns present');
for (const t of ['insider_people','insider_quarantine','insider_ingest_state','insider_history_meta']) {
  const r = await sql.query(`select count(*)::int n from ${t}`);
  console.log(`  ${t.padEnd(22)} exists, rows=${r[0].n}`);
}
const idx = await sql.query(`select indexname from pg_indexes where tablename='insider_trades' order by 1`);
console.log('  indexes:', idx.map(i=>i.indexname).join(', '));
