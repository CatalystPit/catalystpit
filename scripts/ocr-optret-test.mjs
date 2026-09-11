// Dry-run: prove accurate option-return estimation via real Polygon option prices.
// Parses strike/expiry/type from congressional option comments, builds the OCC symbol,
// fetches the option's price near the trade date and now, and prints the true return.
// No DB writes. Run: node --env-file=.env.local scripts/ocr-optret-test.mjs [name]
import { neon } from '@neondatabase/serverless';
const K = process.env.POLYGON_API_KEY;
const sql = neon(process.env.DATABASE_URL);
const who = process.argv[2] || 'pelosi';

const slug = (await sql`SELECT member_slug FROM congress_trades WHERE representative ILIKE ${'%' + who + '%'} LIMIT 1`)[0].member_slug;
const rows = await sql`SELECT ticker, transaction_date, amount_mid, comment FROM congress_trades
  WHERE member_slug=${slug} AND (asset_type ILIKE '%option%' OR asset_type='OP') AND comment IS NOT NULL ORDER BY transaction_date`;

const occ = (t, exp, strike, cp) => 'O:' + t + exp + cp + String(Math.round(strike * 1000)).padStart(8, '0');
const bars = async (sym, from, to) => {
  const a = await fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${from}/${to}?limit=120&apiKey=${K}`);
  const j = await a.json(); return j.results || [];
};
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

for (const r of rows) {
  const src = r.comment || '';
  if (!/\b(call|put)\b/i.test(src)) { continue; }
  const cp = /\bput/i.test(src) ? 'P' : 'C';
  const sm = /strike\s*(?:price)?\s*(?:of\s*)?\$?\s*([\d,]+(?:\.\d+)?)/i.exec(src);
  const em = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(src);
  if (!sm || !em) { console.log(`  ${r.ticker} — could not parse strike/expiry from: "${src.slice(0, 50)}"`); continue; }
  const yy = em[3].length === 2 ? em[3] : em[3].slice(2);
  const exp = yy + em[1].padStart(2, '0') + em[2].padStart(2, '0');
  const strike = parseFloat(sm[1].replace(/,/g, ''));
  const sym = occ(r.ticker, exp, strike, cp);
  const td = iso(r.transaction_date);
  const entry = await bars(sym, td, addDays(td, 10));
  const now = await bars(sym, addDays(td, 10), '2026-09-11');
  const p0 = entry[0]?.c, p1 = now[now.length - 1]?.c;
  const ret = (p0 && p1) ? `${(((p1 - p0) / p0) * 100).toFixed(0)}%` : 'n/a';
  console.log(`  ${(r.ticker || '').padEnd(5)} ${sym.padEnd(21)} entry $${p0 ?? '?'} → now $${p1 ?? '?'}   OPTION return ${ret}   (stock-move basis would understate)`);
}
