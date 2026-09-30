// What form is each stored 8-K row ACTUALLY? The table has no form column, so ask SEC.
//
//   node --env-file=.env.local scripts/audit-8k-forms.mjs [--n 150]
//
// ⚠️ THE TABLE CANNOT ANSWER THIS ITSELF. eightk_filings stores accession, cik, items and dates but
// never the form, and the ingest strips the "8-K/A - " prefix off the Atom title without keeping it.
// So "is this an amendment" is not a question the database can be asked — which is itself the
// finding. SEC's submissions.json carries form[] alongside accessionNumber[], so a sample resolves
// the real rate and proves whether amendments are reaching the table at all.
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const N = Number((/--n\s+(\d+)/.exec(process.argv.join(' ')) || [])[1] || 150);
const HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const pad10 = (c) => String(c).padStart(10, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic sample: ordered by accession, every Nth row, so a re-run measures the same filings.
const all = await sql`select accession, cik, ticker, items, report_date::text rd, filed_at
                        from eightk_filings order by accession`;
const step = Math.max(1, Math.floor(all.length / N));
const sample = all.filter((_, i) => i % step === 0).slice(0, N);
console.log(`stored ${all.length} filings; sampling ${sample.length} (every ${step}th by accession)\n`);

const cache = new Map();
async function formsFor(cik) {
  if (cache.has(cik)) return cache.get(cik);
  let map = new Map();
  try {
    const r = await fetch(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`, { headers: HEADERS });
    if (r.ok) {
      const j = await r.json();
      const rec = j.filings?.recent || {};
      const accs = rec.accessionNumber || [];
      for (let i = 0; i < accs.length; i++) {
        map.set(accs[i], { form: rec.form?.[i] ?? null, items: rec.items?.[i] ?? null,
          reportDate: rec.reportDate?.[i] ?? null, acceptance: rec.acceptanceDateTime?.[i] ?? null,
          filingDate: rec.filingDate?.[i] ?? null, primaryDocument: rec.primaryDocument?.[i] ?? null });
      }
    }
  } catch { /* leave empty */ }
  cache.set(cik, map);
  await sleep(120);                              // SEC asks for <10 req/s; this is well under
  return map;
}

const byForm = new Map();
let notFound = 0, itemsMatch = 0, itemsDiffer = 0, rdMatch = 0, rdDiffer = 0;
const amendments = [], itemMismatches = [], rdMismatches = [];
for (const row of sample) {
  const m = await formsFor(row.cik);
  const d = m.get(row.accession);
  if (!d) { notFound++; continue; }
  byForm.set(d.form, (byForm.get(d.form) || 0) + 1);
  if (/\/A$/.test(String(d.form))) amendments.push({ ...row, sec: d });
  // ⚠️ OUR STORED ITEMS vs SEC'S OWN, on the same accession. The ingest reads them from this exact
  // field, so a difference means the row was written when submissions.json did not yet list it.
  const secItems = (d.items || '').trim() || null;
  if ((row.items || null) === secItems) itemsMatch++;
  else { itemsDiffer++; if (itemMismatches.length < 8) itemMismatches.push(`${row.ticker} ${row.accession} ours=${JSON.stringify(row.items)} sec=${JSON.stringify(secItems)}`); }
  if ((row.rd || null) === (d.reportDate || null)) rdMatch++;
  else { rdDiffer++; if (rdMismatches.length < 6) rdMismatches.push(`${row.ticker} ${row.accession} ours=${row.rd} sec=${d.reportDate}`); }
}

console.log('FORMS actually stored:');
for (const [f, n] of [...byForm].sort((a, b) => b[1] - a[1])) console.log(`  ${String(f).padEnd(12)} ${n}`);
console.log(`  (accession not in SEC "recent" window: ${notFound})`);
console.log(`\nAMENDMENTS (8-K/A) in the sample: ${amendments.length}`);
for (const a of amendments.slice(0, 10)) {
  console.log(`  ${a.ticker.padEnd(8)} ${a.accession}  form=${a.sec.form}  items ours=${JSON.stringify(a.items)} sec=${JSON.stringify(a.sec.items)}  rd=${a.sec.reportDate}`);
}
console.log(`\nITEMS agree with SEC: ${itemsMatch}   differ: ${itemsDiffer}`);
for (const x of itemMismatches) console.log('   ' + x);
console.log(`REPORT DATE agree: ${rdMatch}   differ: ${rdDiffer}`);
for (const x of rdMismatches) console.log('   ' + x);

// ⚠️ AND WHICH CLOCK IS filed_at? SEC gives acceptanceDateTime (when it became public) and
// filingDate (a calendar day). Comparing both against what we stored says which one we are using.
console.log('\nfiled_at vs SEC acceptance / filingDate (first 8 resolvable):');
let shown = 0;
for (const row of sample) {
  if (shown >= 8) break;
  const d = (await formsFor(row.cik)).get(row.accession);
  if (!d?.acceptance) continue;
  const ours = new Date(row.filed_at).toISOString();
  const acc = new Date(d.acceptance + (d.acceptance.endsWith('Z') ? '' : '-04:00')).toISOString();
  const diffMin = Math.round((Date.parse(ours) - Date.parse(acc)) / 60000);
  console.log(`  ${row.ticker.padEnd(8)} ours=${ours}  secAcceptance=${d.acceptance}  filingDate=${d.filingDate}  Δ=${diffMin}min`);
  shown++;
}
