// READ ONLY. For each suspicious fund-quarter, lists every 13F filing the SEC holds for that report
// period and reads the AUTHORITATIVE amendment fields out of primary_doc.xml.
//
// 13F-HR/A is not one thing. The cover page carries <isAmendment> and <amendmentType>, and the SEC
// defines exactly two types:
//   RESTATEMENT  the amendment replaces the original holdings in full
//   NEW HOLDINGS the amendment carries ONLY holdings being added to what was already filed
//
// Our ingest reads the information table and skips primary_doc.xml entirely, so it has never seen
// either field and treats every amendment as a restatement. Where an amendment is NEW HOLDINGS, that
// silently discards the original filing's positions.
//
//   node --env-file=.env.local scripts/probe-13f-amendments.mjs
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const H = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unpad = (c) => String(c).replace(/^0+/, '');
const get = async (url, json) => {
  try { const r = await fetch(url, { headers: H }); if (!r.ok) return null; return json ? await r.json() : await r.text(); }
  catch { return null; }
};
const tag = (xml, name) => {
  const m = String(xml).match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
};

const cases = await sql`
  with c as (select cik, quarter, count(*)::int n from fund_holdings
      where quarter in ('2025-09-30','2025-12-31','2026-03-31','2026-06-30') group by 1,2),
  w as (select cik, quarter, n, lag(n) over (partition by cik order by quarter) prev,
        lead(n) over (partition by cik order by quarter) next from c)
  select w.cik, w.quarter::text q, w.prev, w.n, w.next, i.name
  from w left join institutions i on i.cik = w.cik
  where w.prev is not null and w.next is not null and w.prev >= 20 and w.next >= 20
    and w.n < w.prev*0.2 and w.n < w.next*0.2 order by w.prev desc`;

console.log(`${cases.length} suspicious fund-quarters\n`);
const verdicts = [];
for (const c of cases) {
  const sub = await get(`https://data.sec.gov/submissions/CIK${String(c.cik).padStart(10, '0')}.json`, true);
  await sleep(200);
  const R = sub?.filings?.recent || {};
  const rows = [];
  for (let i = 0; i < (R.form || []).length; i++) {
    if (!String(R.form[i]).startsWith('13F-HR')) continue;
    if (R.reportDate?.[i] !== c.q) continue;
    rows.push({ form: R.form[i], acc: R.accessionNumber[i], filed: R.filingDate[i] });
  }
  rows.sort((a, b) => (a.filed < b.filed ? -1 : 1));

  const detail = [];
  for (const f of rows) {
    const pd = await get(`https://www.sec.gov/Archives/edgar/data/${unpad(c.cik)}/${f.acc.replace(/-/g, '')}/primary_doc.xml`);
    await sleep(200);
    detail.push({
      ...f,
      isAmendment: pd ? (tag(pd, 'isAmendment') || '(absent)') : '(fetch failed)',
      amendmentType: pd ? (tag(pd, 'amendmentType') || '(absent)') : '(fetch failed)',
      tableEntry: pd ? tag(pd, 'tableEntryTotal') : '',
      tableValue: pd ? tag(pd, 'tableValueTotal') : '',
    });
  }

  const latest = detail[detail.length - 1];
  const additive = latest && /NEW\s*HOLDINGS/i.test(latest.amendmentType);
  verdicts.push({ ...c, filings: detail.length, latest, additive });

  console.log(`${String(c.name || c.cik).slice(0, 28).padEnd(29)} ${c.q}  stored ${c.n} (prev ${c.prev}, next ${c.next})`);
  for (const d of detail) {
    console.log(`   ${d.form.padEnd(9)} ${d.acc} filed ${d.filed}  isAmendment=${d.isAmendment}  type=${d.amendmentType}  entries=${d.tableEntry || '-'}`);
  }
  console.log(`   -> latest filing is ${additive ? 'NEW HOLDINGS (ADDITIVE) — our full-restatement treatment DISCARDS the original' : 'a restatement or an original; current treatment is correct'}\n`);
}

const bad = verdicts.filter((v) => v.additive);
console.log(`\nSUMMARY: ${verdicts.length} cases | additive amendments mishandled: ${bad.length}`);
for (const b of bad) console.log(`  ${String(b.name || b.cik).slice(0, 30).padEnd(31)} ${b.q}  stored ${b.n}, entries in amendment ${b.latest.tableEntry}`);
