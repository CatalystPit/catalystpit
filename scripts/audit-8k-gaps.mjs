// Quantify the three things the form sample surfaced:
//   1. rows stored with NULL items (the getcurrent feed publishes before submissions.json lists it)
//   2. rows whose SEC form is not 8-K / 8-K/A at all
//   3. whether an 8-K/A and its original are both stored, which would be duplicate evidence
//
//   node --env-file=.env.local scripts/audit-8k-gaps.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const pad10 = (c) => String(c).padStart(10, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cache = new Map();
async function recentFor(cik) {
  if (cache.has(cik)) return cache.get(cik);
  let out = { map: new Map(), rows: [] };
  try {
    const r = await fetch(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`, { headers: HEADERS });
    if (r.ok) {
      const j = await r.json();
      const rec = j.filings?.recent || {};
      const accs = rec.accessionNumber || [];
      for (let i = 0; i < accs.length; i++) {
        const o = { accession: accs[i], form: rec.form?.[i] ?? null, items: rec.items?.[i] ?? null,
          reportDate: rec.reportDate?.[i] ?? null, primaryDocument: rec.primaryDocument?.[i] ?? null };
        out.map.set(accs[i], o); out.rows.push(o);
      }
    }
  } catch { /* empty */ }
  cache.set(cik, out); await sleep(120); return out;
}

// ── 1. NULL items: are they recoverable from SEC now? ────────────────────────
const nulls = await sql`select accession, cik, ticker, filed_at from eightk_filings where items is null order by filed_at desc`;
console.log(`ROWS WITH NULL items: ${nulls.length}`);
let recoverable = 0, stillNull = 0, notInRecent = 0;
const fixes = [];
for (const r of nulls) {
  const { map } = await recentFor(r.cik);
  const d = map.get(r.accession);
  if (!d) { notInRecent++; continue; }
  const items = (d.items || '').trim();
  if (items) { recoverable++; fixes.push({ ...r, items, form: d.form, reportDate: d.reportDate, primaryDocument: d.primaryDocument }); }
  else stillNull++;
}
console.log(`  recoverable from SEC now : ${recoverable}`);
console.log(`  SEC also has no items    : ${stillNull}   (Form 25 pseudo-rows and genuinely item-less)`);
console.log(`  accession not in recent  : ${notInRecent}`);
const byFormNull = {};
for (const f of fixes) byFormNull[f.form] = (byFormNull[f.form] || 0) + 1;
console.log(`  recoverable by form      : ${JSON.stringify(byFormNull)}`);
for (const f of fixes.slice(0, 6)) console.log(`     ${f.ticker.padEnd(8)} ${f.accession} form=${f.form} items=${f.items}`);

// ── 2. amendments already stored, and whether the original is stored too ─────
// ⚠️ ONLY FILINGS WE HOLD. This does not go looking for amendments market-wide; it asks, of the rows
// already in our table, which are amendments and whether their original is also in the table. Two
// rows for one disclosure is the duplicate-evidence case the audit is for.
const sampleForForm = await sql`select accession, cik, ticker, items, report_date::text rd
                                  from eightk_filings order by filed_at desc limit 700`;
let amend = 0, amendWithOriginalStored = 0, nonEightK = 0;
const amendRows = [], nonEightKRows = [];
for (const r of sampleForForm) {
  const { map, rows } = await recentFor(r.cik);
  const d = map.get(r.accession);
  if (!d) continue;
  if (!/^8-K/.test(String(d.form))) { nonEightK++; if (nonEightKRows.length < 10) nonEightKRows.push(`${r.ticker} ${r.accession} form=${d.form}`); continue; }
  if (!/\/A$/.test(String(d.form))) continue;
  amend++;
  // The original is the 8-K for the SAME reportDate at the same CIK, filed earlier.
  const original = rows.find((o) => o.form === '8-K' && o.reportDate === d.reportDate && o.accession !== d.accession);
  const stored = original ? sampleForForm.some((x) => x.accession === original.accession) : false;
  if (stored) amendWithOriginalStored++;
  if (amendRows.length < 12) amendRows.push(`${r.ticker.padEnd(8)} ${r.accession} rd=${d.reportDate} items=${d.items} original=${original ? original.accession : 'none in SEC recent'} storedToo=${stored}`);
}
console.log(`\nOF THE ${sampleForForm.length} MOST RECENT STORED FILINGS:`);
console.log(`  8-K/A amendments        : ${amend}`);
console.log(`  ...whose original we ALSO store (duplicate evidence): ${amendWithOriginalStored}`);
console.log(`  rows whose SEC form is NOT 8-K at all: ${nonEightK}`);
for (const x of nonEightKRows) console.log(`     ${x}`);
console.log('  amendment detail:');
for (const x of amendRows) console.log(`     ${x}`);
