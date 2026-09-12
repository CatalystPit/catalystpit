import { neon } from '@neondatabase/serverless';
if (!process.env.DATABASE_URL) { console.error('no DATABASE_URL'); process.exit(1); }
const sql = neon(process.env.DATABASE_URL);
const q = async (label, text) => { try { console.log(label, JSON.stringify(await sql.query(text))); } catch (e) { console.log(label, 'ERR', e.message); } };
await q('range/count ', `select count(*)::int n, min(filing_date)::text mn, max(filing_date)::text mx, count(distinct accession)::int acc, count(distinct ticker)::int tk from insider_trades`);
await q('by year     ', `select extract(year from filing_date)::int y, count(*)::int n from insider_trades group by 1 order by 1`);
await q('codes       ', `select transaction_code c, count(*)::int n from insider_trades group by 1 order by n desc limit 12`);
await q('10b5-1 cov  ', `select rule_10b5_1::text v, count(*)::int n from insider_trades group by 1`);
await q('conviction  ', `select count(conviction)::int scored, count(*)::int total from insider_trades`);
await q('db size     ', `select pg_size_pretty(pg_database_size(current_database())) size`);
await q('insider tbl ', `select pg_size_pretty(pg_total_relation_size('insider_trades')) size`);
