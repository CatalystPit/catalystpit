// HARVEST THE ONE FIELD A FORM 4/A GIVES US ABOUT THE FILING IT AMENDS.
//
//   node scripts/harvest-form4a-lineage.mjs [--limit N]
//
// ⚠️ A FORM 4/A DOES NOT NAME THE ACCESSION IT AMENDS. Inspected across every 4/A in our corpus,
// the ownership XML contains NO accession-shaped string anywhere — not in the header, not in
// <remarks>, not in a footnote. The prose sometimes says "the original Form 4, filed on August 24,
// 2026", which is narrative for a human, not a key.
//
// What every one of them DOES carry is the SEC's own structured field:
//
//     <dateOfOriginalSubmission>2026-08-24</dateOfOriginalSubmission>
//
// together with <issuerCik>, <periodOfReport> and one <rptOwnerCik> per reporting owner.
//
// ⚠️ ONE REQUEST PER FILING, AT A PREDICTABLE URL. Two earlier versions asked EDGAR for each
// filing's index.json to discover the document name — two requests each, and under SEC's rate limit
// the index call was the one that failed, writing 724 useless "no-xml" records. The full submission
// text file needs no discovery:
//
//     /Archives/edgar/data/{cik}/{accessionNoDashes}/{accession}.txt
//
// It contains the complete ownership XML inline, so the index disappears and with it the failure.
//
// Reads SEC, writes a local cache, changes no production data. Re-running only fetches what is
// missing, so an interrupted harvest resumes.
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';

const UA = { 'User-Agent': 'CatalystPit contact@catalystpit.com' };
const OUT = path.join(process.cwd(), 'node_modules', '.cache', 'form4a');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIT = Number((/--limit\s+(\d+)/.exec(process.argv.join(' ')) || [])[1] || 100000);
const CONC = 4;                 // SEC asks for under 10 req/s; four in flight stays well inside it

const env = fs.readFileSync('.env.local', 'utf8');
const sql = neon(/DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/.exec(env)[1].trim());

const one = (xml, tag) => { const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml); return m ? m[1].trim() : null; };
const all = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'gi'))].map((m) => m[1].trim());

const pull = async (url) => {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500) await sleep(1200 * (i + 1));
    } catch { /* retry */ }
    await sleep(400 * (i + 1));
  }
  return null;
};

const rows = await sql`SELECT DISTINCT ON (accession) accession, ticker, issuer_cik
  FROM insider_trades WHERE is_amendment ORDER BY accession`;
const missing = rows.filter((r) => !fs.existsSync(path.join(OUT, `${r.accession}.json`)));
const todo = missing.slice(0, LIMIT);
console.log(`distinct 4/A accessions: ${rows.length}; cached: ${rows.length - missing.length}; to fetch: ${todo.length}`);

let done = 0, failed = 0, noField = 0;
for (let i = 0; i < todo.length; i += CONC) {
  await Promise.all(todo.slice(i, i + CONC).map(async (r) => {
    const cik = String(r.issuer_cik || '').replace(/^0+/, '');
    const bare = r.accession.replace(/-/g, '');
    const txt = await pull(`https://www.sec.gov/Archives/edgar/data/${cik}/${bare}/${r.accession}.txt`);
    if (!txt || !/<documentType>/i.test(txt)) {
      // ⚠️ A FAILURE IS NOT CACHED. Writing an error record here is what made the last run
      // unrepeatable: the file existed, so a retry skipped it forever.
      failed++;
      return;
    }
    const rec = {
      accession: r.accession,
      ticker: r.ticker,
      documentType: one(txt, 'documentType'),
      periodOfReport: one(txt, 'periodOfReport'),
      dateOfOriginalSubmission: one(txt, 'dateOfOriginalSubmission'),
      issuerCik: one(txt, 'issuerCik'),
      ownerCiks: [...new Set(all(txt, 'rptOwnerCik'))],
      remarks: (/<remarks>([\s\S]*?)<\/remarks>/i.exec(txt)?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      // Proof, per filing, that no accession reference existed to prefer over the date. The full
      // submission text carries SEC's own header, so a reference would be visible here if one existed.
      accessionRefs: [...new Set([...(/<ownershipDocument>[\s\S]*<\/ownershipDocument>/.exec(txt)?.[0] || '')
        .matchAll(/\b\d{10}-\d{2}-\d{6}\b/g)].map((m) => m[0]))],
    };
    if (!rec.dateOfOriginalSubmission) noField++;
    fs.writeFileSync(path.join(OUT, `${r.accession}.json`), JSON.stringify(rec));
    done++;
  }));
  await sleep(110);
  if ((i / CONC) % 50 === 0) console.log(`  ${done + failed}/${todo.length} (failed ${failed})`);
}
console.log(`\nharvested ${done}, failed ${failed}, missing dateOfOriginalSubmission ${noField}`);
console.log(`cache: ${OUT}  total records: ${fs.readdirSync(OUT).length}`);
