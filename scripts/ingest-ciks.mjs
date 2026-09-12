// One-off: ingest specific 13F-HR filers directly (BlackRock's current CIK + Vanguard's sub-entities
// that OpenFIGI/discovery hadn't ingested yet). Run: node --env-file=.env.local scripts/ingest-ciks.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const H = { 'User-Agent': 'CatalystPit contact@catalystpit.com' };
const pad10 = (c) => String(c).replace(/\D/g, '').padStart(10, '0');
const unpad = (c) => String(Number(String(c).replace(/\D/g, '')));
const clean = (s) => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim();
const slugify = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const jget = async (u) => { const r = await fetch(u, { headers: H }); return r.ok ? r.json() : null; };
const tget = async (u) => { const r = await fetch(u, { headers: H }); return r.ok ? r.text() : null; };

function parseInfoTable(xml, wholeDollars) {
  const tag = (b, n) => { const m = b.match(new RegExp(`<(?:\\w+:)?${n}>([\\s\\S]*?)</(?:\\w+:)?${n}>`, 'i')); return m ? clean(m[1]) : ''; };
  const rows = [];
  for (const b of (xml.match(/<(?:\w+:)?infoTable>[\s\S]*?<\/(?:\w+:)?infoTable>/gi) || [])) {
    const cusip = tag(b, 'cusip').toUpperCase(); if (!cusip) continue;
    const rawV = parseFloat(tag(b, 'value').replace(/,/g, '')) || 0;
    const sh = parseFloat(tag(b, 'sshPrnamt').replace(/,/g, '')) || 0;
    rows.push({ issuer: tag(b, 'nameOfIssuer'), cls: tag(b, 'titleOfClass') || '', cusip, value: wholeDollars ? rawV : rawV * 1000, shares: sh, pc: tag(b, 'putCall') || '' });
  }
  return rows;
}

async function storeQuarter(cik, name, f) {
  const accND = f.acc.replace(/-/g, '');
  const idx = await jget(`https://www.sec.gov/Archives/edgar/data/${cik}/${accND}/index.json`);
  const xmls = (idx?.directory?.item || []).filter((it) => /\.xml$/i.test(it.name) && !/primary_doc/i.test(it.name));
  let rows = [];
  for (const it of xmls) { const xml = await tget(`https://www.sec.gov/Archives/edgar/data/${cik}/${accND}/${it.name}`); if (xml && /<(?:\w+:)?infoTable>/i.test(xml)) { rows = parseInfoTable(xml, String(f.filed) >= '2023-01-01'); break; } }
  if (!rows.length) return 0;
  await sql`DELETE FROM fund_holdings WHERE cik=${cik} AND quarter=${f.q}`;
  for (let i = 0; i < rows.length; i += 1000) {
    const b = rows.slice(i, i + 1000);
    await sql`INSERT INTO fund_holdings (cik,quarter,cusip,issuer,class,shares,value,put_call,filed_date,accession)
      SELECT ${cik}, ${f.q}::date, u.cusip, u.issuer, u.cls, u.shares, u.value, u.pc, ${f.filed}::date, ${f.acc}
      FROM unnest(${b.map(r => r.cusip)}::text[], ${b.map(r => r.issuer)}::text[], ${b.map(r => r.cls)}::text[], ${b.map(r => r.shares)}::float8[], ${b.map(r => r.value)}::float8[], ${b.map(r => r.pc)}::text[]) AS u(cusip,issuer,cls,shares,value,pc)
      ON CONFLICT DO NOTHING`;
  }
  const total = rows.reduce((s, r) => s + (r.value || 0), 0);
  await sql`INSERT INTO fund_filings (cik,quarter,filed_date,accession,total_value,holdings_count) VALUES (${cik},${f.q},${f.filed},${f.acc},${total},${rows.length})
    ON CONFLICT (cik,quarter) DO UPDATE SET filed_date=excluded.filed_date, accession=excluded.accession, total_value=excluded.total_value, holdings_count=excluded.holdings_count`;
  return rows.length;
}

async function ingest(cikRaw) {
  const cik = unpad(cikRaw);
  const sub = await jget(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`);
  if (!sub) return { cik, err: 'no-submissions' };
  const R = sub.filings.recent; const byQ = new Map();
  for (let i = 0; i < R.form.length; i++) { if (String(R.form[i]).startsWith('13F-HR')) { const q = R.reportDate[i]; const ex = byQ.get(q); if (!ex || R.filingDate[i] > ex.filed) byQ.set(q, { q, acc: R.accessionNumber[i], filed: R.filingDate[i] }); } }
  const quarters = [...byQ.values()].sort((a, b) => b.q.localeCompare(a.q)).slice(0, 4);   // latest 4 → enables QoQ
  if (!quarters.length) return { cik, name: sub.name, err: 'no-13F-HR' };
  await sql`INSERT INTO institutions (cik,name,slug,updated_at) VALUES (${cik},${sub.name},${slugify(sub.name) || 'cik-' + cik},now()) ON CONFLICT (cik) DO UPDATE SET name=excluded.name, updated_at=now()`;
  let stored = 0;
  for (const f of quarters) { stored += await storeQuarter(cik, sub.name, f); await new Promise(r => setTimeout(r, 200)); }
  await sql`UPDATE institutions SET filing_count=(SELECT count(*) FROM fund_filings WHERE cik=${cik}), last_quarter=${quarters[0].q}, first_seen_quarter=(SELECT min(quarter) FROM fund_filings WHERE cik=${cik}), updated_at=now() WHERE cik=${cik}`;
  return { cik, name: sub.name, quarters: quarters.length, holdings: stored };
}

const CIKS = ['1166559'];
for (const c of CIKS) { console.log(await ingest(c)); await new Promise(r => setTimeout(r, 400)); }
