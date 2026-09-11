// Mark "Corporate Portfolio" filers: any 13F filer whose CIK equals a publicly-traded stock's CIK
// (SEC company_tickers.json). Sets institutions.stock_ticker. Idempotent; safe to re-run.
// Run: node --env-file=.env.local scripts/classify-corporate-filers.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

await sql`ALTER TABLE institutions ADD COLUMN IF NOT EXISTS stock_ticker text`;

const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': 'CatalystPit contact@catalystpit.com' } });
const j = await r.json();
// A CIK can list several tickers (common + preferred + warrants). Prefer the COMMON share:
// rank no-dash (1) < class shares -A/-B (2) < preferred/warrant/unit (3); tiebreak shortest.
const rank = (t) => (/-(P|WT|WS|W|U|R)/i.test(t) ? 3 : t.includes('-') ? 2 : 1);
const cikToTicker = new Map();
for (const k in j) {
  const cik = String(j[k].cik_str), t = j[k].ticker;
  const cur = cikToTicker.get(cik);
  if (!cur || rank(t) < rank(cur) || (rank(t) === rank(cur) && t.length < cur.length)) cikToTicker.set(cik, t);
}
console.log('SEC listed companies:', cikToTicker.size);

const filers = await sql`SELECT cik FROM institutions`;
let set = 0;
for (const f of filers) {
  const t = cikToTicker.get(String(Number(f.cik))) || null;   // normalize leading zeros
  if (t) { await sql`UPDATE institutions SET stock_ticker=${t} WHERE cik=${f.cik}`; set++; }
}
const corp = await sql`SELECT COUNT(*) n FROM institutions WHERE stock_ticker IS NOT NULL`;
const withHoldings = await sql`SELECT COUNT(*) n FROM institutions WHERE stock_ticker IS NOT NULL AND filing_count > 0`;
console.log(`DONE: ${set} filers matched to a stock · ${corp[0].n} corporate filers total, ${withHoldings[0].n} with holdings`);
