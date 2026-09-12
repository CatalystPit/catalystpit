import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const rows = await sql.query(`select reason, detail, ticker, accession, raw_url from insider_quarantine order by created_at desc limit 10`);
for (const r of rows) console.log(`${r.reason.padEnd(24)} ${String(r.ticker||'?').padEnd(7)} ${r.detail}\n    ${r.raw_url}`);
const agg = await sql.query(`select reason, count(*)::int n from insider_quarantine group by 1 order by n desc`);
console.log('\nby reason:', JSON.stringify(agg));
