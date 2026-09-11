// OCR-ingest the SCANNED House PTR filings (status='scanned' in congress_filings) that the text
// parser couldn't read. For each: OCR via Claude → validate brackets → reconcile any transcribed
// share/contract count against the disclosed dollar bracket (drop it if it can't add up — "no
// guessing") → buildRow → insert (dedup-safe) → mark the filing parsed.
// Run: node --env-file=.env.local scripts/ocr-scanned-house.mjs [limit]
import { neon } from '@neondatabase/serverless';
import { ocrPtrTransactions } from '../src/lib/congress-ocr.mjs';
import { fetchHouseIndex, houseRec, ptrPdfUrl } from '../src/lib/congress-house.mjs';
import { buildRow } from '../src/lib/congress-ingest.mjs';
import { buildIndex } from '../src/lib/congress-match.mjs';
import roster from '../src/lib/congress-roster.json' with { type: 'json' };

const sql = neon(process.env.DATABASE_URL);
const index = buildIndex(roster);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const limit = parseInt(process.argv[2] || '100', 10);

const filings = await sql`SELECT doc_id, year, filer_name, url FROM congress_filings
  WHERE chamber='house' AND status='scanned' ORDER BY year DESC LIMIT ${limit}`;
console.log(`Scanned House filings to OCR: ${filings.length}`);

// House index entries (structured filer name/district) keyed by docId, per year present.
const years = [...new Set(filings.map((f) => f.year).filter(Boolean))];
const entryByDoc = new Map();
for (const y of years) {
  try { for (const e of await fetchHouseIndex(y)) entryByDoc.set(e.docId, e); }
  catch (e) { console.log(`  index ${y}: ${e.message}`); }
}

// Reconcile a transcribed count against the bracket: implied price = amount midpoint / count must
// be a plausible equity/option price. If it isn't, drop the count so the estimate takes over.
const impliedOk = (count, amountMid) => { if (!count || !amountMid) return true; const p = amountMid / count; return p >= 0.5 && p <= 100000; };
const stripCount = (desc) => (desc || '').replace(/\b[\d,]+\s*(shares?|call options?|put options?|contracts?)\b/gi, 'shares/contracts').trim() || null;

const COLS = ['tx_hash','chamber','first_name','last_name','representative','member_slug','party','state','district','ticker','asset_description','asset_type','owner','type','action','amount_range','amount_min','amount_max','amount_mid','transaction_date','disclosure_date','filing_lag_days','cap_gains_over200','comment','link'];
const val = (r) => [r.txHash,r.chamber,r.firstName,r.lastName,r.representative,r.memberSlug,r.party,r.state,r.district,r.ticker,r.assetDescription,r.assetType,r.owner,r.type,r.action,r.amountRange,r.amountMin,r.amountMax,r.amountMid,r.transactionDate,r.disclosureDate,r.filingLagDays,r.capGainsOver200,r.comment,r.link];

let done = 0, inserted = 0, rejected = 0, empties = 0;
for (const f of filings) {
  const entry = entryByDoc.get(f.doc_id);
  if (!entry) { console.log(`  no index entry for ${f.doc_id} — skip`); continue; }
  const url = f.url || ptrPdfUrl(f.year, f.doc_id);
  try {
    const buf = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': 'CatalystPit (contact@catalystpit.com)' } })).arrayBuffer());
    const { transactions, error } = await ocrPtrTransactions(buf, process.env.ANTHROPIC_API_KEY);
    if (error) { console.log(`  ${f.doc_id}: OCR error ${error}`); continue; }

    let filingIns = 0;
    for (const t of transactions) {
      const mid = ((n) => { const a = String(n || '').match(/[\d,]+/g); if (!a) return null; const x = a.map((z) => +z.replace(/,/g, '')); return x.length > 1 ? (x[0] + x[1]) / 2 : x[0]; })(t.amount);
      // "no guessing" guard: reject a transcribed count that can't reconcile with the bracket.
      if ((t._shares && !impliedOk(t._shares, mid)) || (t._contracts && !impliedOk(t._contracts, mid))) { t.description = stripCount(t.description); rejected++; }
      const rec = houseRec(entry, t, url);
      const row = buildRow(rec, 'house', index);
      const res = await sql.query(
        `INSERT INTO congress_trades (${COLS.join(',')}) VALUES (${COLS.map((_, i) => '$' + (i + 1)).join(',')}) ON CONFLICT (tx_hash) DO NOTHING RETURNING id`,
        val(row));
      if (res.length) { inserted++; filingIns++; }
    }
    if (!transactions.length) empties++;
    await sql`UPDATE congress_filings SET status='parsed', format='scanned', txn_count=${transactions.length}, parsed_at=now() WHERE chamber='house' AND doc_id=${f.doc_id}`;
    done++;
    console.log(`  ${f.doc_id} ${String(f.filer_name||'').slice(0,22).padEnd(22)} · ${transactions.length} txns, +${filingIns} new`);
  } catch (e) { console.log(`  ${f.doc_id}: ${e.message}`); }
  await sleep(400);
}
console.log(`DONE: ${done} filings OCR'd · ${inserted} new trades · ${rejected} counts rejected (bracket mismatch) · ${empties} blank/illegible`);
