import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const UA = { 'User-Agent': 'CatalystPit Research bcoghill88@gmail.com' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('stored accession format sample:',
  JSON.stringify((await sql.query(`select accession, filing_date::text fd from insider_trades order by filing_date desc limit 3`))));

for (const day of ['2026-09-09','2026-09-08','2026-08-20']) {
  const [y,m,d] = day.split('-');
  const q = 'QTR' + (Math.floor((Number(m)-1)/3)+1);
  await sleep(200);
  const r = await fetch(`https://www.sec.gov/Archives/edgar/daily-index/${y}/${q}/form.${y}${m}${d}.idx`, { headers: UA });
  if (!r.ok) { console.log(day, 'index', r.status); continue; }
  const lines = (await r.text()).split('\n').filter(l => /^\s*4(\/A)?\s/.test(l));
  // accession is the trailing filename: .../0001234567-26-000123.txt
  const idxAcc = new Set(lines.map(l => l.match(/(\d{10}-\d{2}-\d{6})/)?.[1]).filter(Boolean));
  const rows = await sql.query(`select distinct accession from insider_trades where filing_date = $1`, [day]);
  const dbAcc = new Set(rows.map(r => r.accession));
  let hit = 0; for (const a of idxAcc) if (dbAcc.has(a)) hit++;
  console.log(`${day}  EDGAR index ${String(idxAcc.size).padStart(5)}   stored ${String(dbAcc.size).padStart(5)}   of-index captured ${hit} (${(hit/idxAcc.size*100).toFixed(1)}%)`);
}
