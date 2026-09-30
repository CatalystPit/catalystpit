// Repair 8-K rows stored before SEC listed their items, and remove filings that are not Form 25.
//
//   node --env-file=.env.local scripts/repair-8k-items.mjs            (dry run)
//   node --env-file=.env.local scripts/repair-8k-items.mjs --apply
//
// ⚠️ ALERT SAFETY IS STRUCTURAL HERE, NOT A PROMISE. Evidence alerts are delivered by
// changedSince(), which keeps an evidence object only when publicTime > the subscriber's watermark.
// publicTime for an 8-K is filed_at, and filed_at is SEC's acceptanceDateTime — verified equal to
// the second on sampled filings. This repair writes items, material and report_date. It never
// writes filed_at or inserted_at, so no repaired row can move across any watermark, and a
// subscriber cannot be told about a filing from three weeks ago because a column was corrected.
//
// The snapshot below proves it rather than asserting it: the alert-visible surface (ticker,
// accession, filed_at) is captured before and compared after.
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const APPLY = process.argv.includes('--apply');
const HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const pad10 = (c) => String(c).padStart(10, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors ITEM_MAP's material flags in src/lib/eightk.js. Kept in step by verify-8k-integrity.
const MATERIAL = new Set(['1.01', '1.02', '1.03', '1.05', '2.01', '2.02', '2.03', '2.04', '2.05',
  '2.06', '3.01', '3.02', '3.03', '4.01', '4.02', '5.01', '5.02', '5.06', '25', '25-NSE']);
const isMaterial = (csv) => String(csv || '').split(/[,;\s]+/).filter(Boolean).some((c) => MATERIAL.has(c));

const snap = async () => sql`select accession, ticker, filed_at, inserted_at from eightk_filings order by accession`;
const before = await snap();
const key = (r) => `${r.accession}|${r.ticker}|${new Date(r.filed_at).toISOString()}`;
const beforeKeys = new Set(before.map(key));
console.log(`alert-visible snapshot: ${before.length} rows (accession + ticker + filed_at)\n`);

const cache = new Map();
async function secFor(cik) {
  if (cache.has(cik)) return cache.get(cik);
  const map = new Map();
  try {
    const r = await fetch(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`, { headers: HEADERS });
    if (r.ok) {
      const j = await r.json();
      const rec = j.filings?.recent || {};
      const a = rec.accessionNumber || [];
      for (let i = 0; i < a.length; i++) {
        map.set(a[i], { form: rec.form?.[i] ?? null, items: rec.items?.[i] ?? null, reportDate: rec.reportDate?.[i] ?? null });
      }
    }
  } catch { /* leave empty */ }
  cache.set(cik, map); await sleep(120); return map;
}

// ── 1. items that SEC can now supply ─────────────────────────────────────────
const nulls = await sql`select accession, cik, ticker from eightk_filings where items is null`;
let fixed = 0, unchanged = 0;
for (const row of nulls) {
  const d = (await secFor(row.cik)).get(row.accession);
  const items = (d?.items || '').trim();
  if (!items) { unchanged++; continue; }
  const material = isMaterial(items);
  if (APPLY) {
    await sql`update eightk_filings set items = ${items}, material = ${material},
              report_date = coalesce(${d.reportDate || null}::date, report_date)
              where accession = ${row.accession}`;
  }
  fixed++;
}
console.log(`items repaired      : ${fixed}${APPLY ? '' : ' (dry run)'}`);
console.log(`still no items at SEC: ${unchanged}`);

// ── 2. rows whose SEC form is not one this pipeline ingests ──────────────────
// ⚠️ DELETED, NOT RELABELLED. A 253G2 is a Regulation A offering circular; there is no item code
// and no corporate event for it in this product, so leaving it with a corrected label would still
// put a filing on the wire that the pipeline does not claim to cover. It is removed as a row that
// should never have been written, and the parser fix stops it recurring.
const pseudo = await sql`select accession, cik, ticker, items from eightk_filings where items in ('25','25-NSE')`;
const bogus = [];
for (const row of pseudo) {
  const f = (await secFor(row.cik)).get(row.accession)?.form;
  if (f && f !== '25' && f !== '25-NSE') bogus.push({ ...row, form: f });
}
console.log(`\nForm-25 rows that are NOT Form 25: ${bogus.length}`);
for (const b of bogus) console.log(`   ${b.ticker} ${b.accession} stored=${b.items} secForm=${b.form}`);
if (APPLY && bogus.length) {
  for (const b of bogus) await sql`delete from eightk_filings where accession = ${b.accession}`;
  console.log(`   deleted ${bogus.length}`);
}

// ── 3. prove no alert-visible field moved ───────────────────────────────────
const after = await snap();
const afterKeys = new Set(after.map(key));
const appeared = [...afterKeys].filter((k) => !beforeKeys.has(k));
const removed = [...beforeKeys].filter((k) => !afterKeys.has(k));
console.log(`\nALERT SAFETY`);
console.log(`  rows before/after            : ${before.length} / ${after.length}`);
console.log(`  accession+ticker+filed_at NEW: ${appeared.length}  ${appeared.length ? '⚠️ ' + appeared.slice(0, 3).join(' ') : '(none — nothing can cross a watermark)'}`);
console.log(`  removed                      : ${removed.length}${removed.length ? ' (the non-Form-25 rows above)' : ''}`);
if (appeared.length) { console.error('REFUSING TO CALL THIS SAFE: a publicTime-bearing key appeared.'); process.exit(1); }
