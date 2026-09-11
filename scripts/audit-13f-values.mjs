// Audit a filer's 13F values against SEC ground truth: fetch the raw info table, compare the
// as-reported <value> to what we stored (× scaling). Run: node --env-file=.env.local scripts/audit-13f-values.mjs [CIK]
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const UA = { 'User-Agent': 'CatalystPit contact@catalystpit.com' };
const unpad = (c) => String(Number(c));
const cik = process.argv[2] || '1045810';   // default NVIDIA

const sub = await (await fetch(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`, { headers: UA })).json();
const R = sub.filings.recent;
let acc, fd, rq;
for (let i = 0; i < R.form.length; i++) { if (String(R.form[i]).startsWith('13F-HR')) { acc = R.accessionNumber[i]; fd = R.filingDate[i]; rq = R.reportDate[i]; break; } }
console.log(`${sub.name} · latest 13F-HR filed ${fd} for ${rq} · wholeDollars rule = ${String(fd) >= '2023-01-01'}`);

const accND = acc.replace(/-/g, '');
const idx = await (await fetch(`https://www.sec.gov/Archives/edgar/data/${unpad(cik)}/${accND}/index.json`, { headers: UA })).json();
const xmls = idx.directory.item.filter((it) => /\.xml$/i.test(it.name) && !/primary_doc/i.test(it.name));
const tag = (b, n) => { const m = b.match(new RegExp(`<(?:\\w+:)?${n}>([\\s\\S]*?)</(?:\\w+:)?${n}>`, 'i')); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim() : ''; };

for (const it of xmls) {
  const xml = await (await fetch(`https://www.sec.gov/Archives/edgar/data/${unpad(cik)}/${accND}/${it.name}`, { headers: UA })).text();
  if (!/infoTable/i.test(xml)) continue;
  const blocks = xml.match(/<(?:\w+:)?infoTable>[\s\S]*?<\/(?:\w+:)?infoTable>/gi) || [];
  let total = 0;
  const rows = blocks.map((b) => { const v = parseFloat(tag(b, 'value').replace(/,/g, '')) || 0; total += v; return { issuer: tag(b, 'nameOfIssuer'), value: v, shares: tag(b, 'sshPrnamt') }; });
  rows.sort((a, b) => b.value - a.value);
  console.log(`\nRAW SEC (as-reported <value>), ${blocks.length} positions, sum=${total.toLocaleString()}:`);
  rows.slice(0, 6).forEach((r) => console.log(`  ${r.issuer.slice(0, 26).padEnd(27)} value=${r.value.toLocaleString().padStart(16)}  shares=${r.shares}`));
  // what we stored
  const stored = await sql`SELECT issuer, value FROM fund_holdings WHERE cik=${unpad(cik)} AND quarter=${rq} ORDER BY value DESC LIMIT 6`;
  console.log('\nWHAT WE STORED (fund_holdings.value):');
  stored.forEach((s) => console.log(`  ${(s.issuer || '').slice(0, 26).padEnd(27)} $${Number(s.value).toLocaleString()}`));
  break;
}
