// Mark "Corporate Portfolio" filers: any 13F filer whose CIK equals a publicly-traded stock's CIK
// (SEC company_tickers.json). Sets institutions.stock_ticker. Idempotent; safe to re-run.
// Run: node --env-file=.env.local scripts/classify-corporate-filers.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

await sql`ALTER TABLE institutions ADD COLUMN IF NOT EXISTS stock_ticker text`;

const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': 'CatalystPit contact@catalystpit.com' } });
const j = await r.json();
const cikToTicker = new Map();
for (const k in j) cikToTicker.set(String(j[k].cik_str), j[k].ticker);   // unpadded CIK → ticker
console.log('SEC listed companies:', cikToTicker.size);

const filers = await sql`SELECT cik, name FROM institutions`;
let set = 0, cleared = 0;
for (const f of filers) {
  const t = cikToTicker.get(String(Number(f.cik))) || null;   // normalize leading zeros
  const cur = await sql`SELECT stock_ticker FROM institutions WHERE cik=${f.cik}`;
  const prev = cur[0]?.stock_ticker || null;
  if (t && t !== prev) { await sql`UPDATE institutions SET stock_ticker=${t} WHERE cik=${f.cik}`; set++; }
  else if (!t && prev) { await sql`UPDATE institutions SET stock_ticker=NULL WHERE cik=${f.cik}`; cleared++; }
}
const corp = await sql`SELECT COUNT(*) n FROM institutions WHERE stock_ticker IS NOT NULL`;
const withHoldings = await sql`SELECT COUNT(*) n FROM institutions WHERE stock_ticker IS NOT NULL AND filing_count > 0`;
console.log(`DONE: ${set} newly set, ${cleared} cleared · ${corp[0].n} corporate filers total, ${withHoldings[0].n} with holdings`);
