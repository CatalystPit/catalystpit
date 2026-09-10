// src/lib/congress-house.mjs
//
// OFFICIAL House Clerk PTR ingest (Phase 4). Pure fetch + parse — NO db imports
// (DB writes live in the cron route, matching congress-ingest.mjs). Produces
// records in the SAME shape the FMP path used, so buildRow() maps/dedups/matches
// them unchanged.
//
// Source mechanics (verified live, Sep 2026):
//  - Annual index ZIP: https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YEAR}FD.zip
//      → {YEAR}FD.txt (tab-delimited: Prefix Last First Suffix FilingType StateDst Year FilingDate DocID)
//      FilingType 'P' = Periodic Transaction Report.
//  - PTR document (always PDF): .../public_disc/ptr-pdfs/{YEAR}/{DocID}.pdf
//      DocID starting '2' = e-filed (selectable text, parseable); '8'/'9' = scanned (needs OCR → flag).
//  - No robots.txt, no terms gate, no session. Static GETs; be a polite citizen.

import { unzipSync, strFromU8 } from 'fflate';
// PDF text is extracted with `unpdf` (ships a serverless pdfjs build — no DOMMatrix/DOM deps,
// unlike pdf-parse which crashes in Vercel's Node runtime). Loaded LAZILY inside extractPdfText
// so this module imports cleanly everywhere and the dedupe / Senate paths never load it.

const HOUSE = 'https://disclosures-clerk.house.gov/public_disc';
const UA = 'CatalystPit (contact@catalystpit.com)';

export const ptrPdfUrl = (year, docId) => `${HOUSE}/ptr-pdfs/${year}/${docId}.pdf`;
export const isEfiledDocId = (docId) => /^2/.test(String(docId || ''));
const toISO = (mdy) => { const m = String(mdy || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
const OWNER = { SP: 'Spouse', JT: 'Joint', DC: 'Dependent Child' };
const TXTYPE = { P: 'Purchase', S: 'Sale', E: 'Exchange' };

// ── annual index ────────────────────────────────────────────────────────────
export async function fetchHouseIndex(year) {
  const r = await fetch(`${HOUSE}/financial-pdfs/${year}FD.zip`, { headers: { 'User-Agent': UA }, cache: 'no-store' });
  if (!r.ok) throw new Error(`house index ${year}: HTTP ${r.status}`);
  const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
  const txtName = Object.keys(files).find((n) => /\.txt$/i.test(n));
  if (!txtName) throw new Error(`house index ${year}: no .txt in zip`);
  return parseHouseIndex(strFromU8(files[txtName]));
}

// Tab-delimited index → rows. Only PTRs (FilingType 'P').
export function parseHouseIndex(txt) {
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const header = lines.shift() || '';
  const cols = header.split('\t').map((c) => c.trim());
  const idx = (name) => cols.indexOf(name);
  const iPrefix = idx('Prefix'), iLast = idx('Last'), iFirst = idx('First'), iSuffix = idx('Suffix'),
    iType = idx('FilingType'), iSD = idx('StateDst'), iYear = idx('Year'), iFiled = idx('FilingDate'), iDoc = idx('DocID');
  const out = [];
  for (const line of lines) {
    const p = line.split('\t');
    const filingType = (p[iType] || '').trim();
    if (filingType !== 'P') continue;                       // PTRs only
    const docId = (p[iDoc] || '').trim();
    if (!docId) continue;
    out.push({
      docId, year: (p[iYear] || '').trim() || String(year(p, iFiled)),
      prefix: (p[iPrefix] || '').trim(), last: (p[iLast] || '').trim(), first: (p[iFirst] || '').trim(),
      suffix: (p[iSuffix] || '').trim(), stateDst: (p[iSD] || '').trim(),
      filingType, filingDate: toISO(p[iFiled]),
    });
  }
  return out;
}
function year(p, iFiled) { const m = String(p[iFiled] || '').match(/\/(\d{4})$/); return m ? m[1] : ''; }

// ── PTR PDF text → transactions ───────────────────────────────────────────────
export async function extractPdfText(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return text || '';
}

const AMOUNT = String.raw`(?:None \(or less than \$1,001\)|Over \$[\d,]+|\$[\d,]+(?:\s*-\s*\$[\d,]+)?(?:\s*\+)?)`;
const CORE = new RegExp(String.raw`\[([A-Z]{1,4})\]\s+(S \(partial\)|P|S|E)\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(${AMOUNT})`, 'g');

// Parse the transaction table out of the extracted PTR text. Robust to pdf-parse's
// column-linearization: whitespace-collapse, slice to the transaction region, then
// anchor on each row's `[TYPE] TxType Date Date Amount` core and read owner/ticker
// from the text preceding it.
export function parsePtrTransactions(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return { scanned: true, transactions: [] };
  // Transaction region: after the "…Gains > $200?" header, before the asset-code footnote / filing id.
  let region = text;
  const h = region.search(/\$200\s*\?/);
  if (h >= 0) region = region.slice(h + 1);
  const foot = region.search(/\*\s*For the complete list|Filing ID\s*#|Initial Public Offering/i);
  if (foot >= 0) region = region.slice(0, foot);

  const txns = [];
  let prevEnd = 0, m;
  CORE.lastIndex = 0;
  while ((m = CORE.exec(region))) {
    const seg = region.slice(prevEnd, m.index);
    prevEnd = CORE.lastIndex;
    const [, assetCode, txTypeRaw, txDate, notifyDate, amount] = m;
    // ticker = last parenthetical token in the preceding segment (skip CUSIPs/junk via buildRow's cleanTicker)
    const parens = [...seg.matchAll(/\(([A-Za-z0-9.\-]{1,10})\)/g)];
    const ticker = parens.length ? parens[parens.length - 1][1] : null;
    // owner = last standalone SP/JT/DC token in the segment (else filer/Self)
    const owns = [...seg.matchAll(/\b(SP|JT|DC)\b/g)];
    const ownerCode = owns.length ? owns[owns.length - 1][1] : '';
    // asset name = text after that owner code, minus the trailing ticker parens (best-effort, display only)
    let asset = seg;
    if (ownerCode) asset = asset.slice(asset.lastIndexOf(ownerCode) + ownerCode.length);
    asset = asset.replace(/\([^)]*\)\s*$/, '').replace(/^[\s:>|]+/, '').trim();
    const base = (txTypeRaw || '').trim().charAt(0).toUpperCase();
    txns.push({
      owner: OWNER[ownerCode] || 'Self',
      ticker,
      assetDescription: asset ? `${asset}${ticker ? ` (${ticker})` : ''}` : (ticker || null),
      assetType: assetCode,
      type: /partial/i.test(txTypeRaw) ? `${TXTYPE[base]} (partial)` : (TXTYPE[base] || txTypeRaw),
      transactionDate: toISO(txDate),
      notificationDate: toISO(notifyDate),
      amount: amount.replace(/\s+/g, ' ').trim(),
    });
  }
  return { scanned: false, transactions: txns };
}

// Fetch + parse one PTR. Returns { status, format, transactions, recs }.
// recs are FMP-shaped for buildRow(rec, 'house', index).
export async function fetchHousePtr(entry) {
  const url = ptrPdfUrl(entry.year, entry.docId);
  if (!isEfiledDocId(entry.docId)) return { status: 'scanned', format: 'scanned', url, transactions: [], recs: [] };
  const r = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
  if (!r.ok) return { status: 'error', format: 'efiled', url, error: `HTTP ${r.status}`, transactions: [], recs: [] };
  const buf = Buffer.from(await r.arrayBuffer());
  let text = '';
  try { text = await extractPdfText(buf); }
  catch (e) { return { status: 'error', format: 'efiled', url, error: `pdf:${e.message}`, transactions: [], recs: [] }; }
  const { scanned, transactions } = parsePtrTransactions(text);
  if (scanned) return { status: 'scanned', format: 'scanned', url, transactions: [], recs: [] };
  const recs = transactions.map((t) => houseRec(entry, t, url));
  return { status: transactions.length ? 'parsed' : 'empty', format: 'efiled', url, transactions, recs };
}

// One parsed transaction + its index entry → an FMP-shaped record for buildRow.
export function houseRec(entry, t, url) {
  return {
    firstName: entry.first, lastName: entry.last,
    office: `${entry.prefix ? entry.prefix + ' ' : ''}${entry.first} ${entry.last}${entry.suffix ? ' ' + entry.suffix : ''}`.trim(),
    district: entry.stateDst || null,
    symbol: t.ticker || null,
    assetDescription: t.assetDescription || null,
    assetType: t.assetType || null,
    owner: t.owner || null,
    type: t.type || null,
    amount: t.amount || null,
    transactionDate: t.transactionDate || null,
    disclosureDate: entry.filingDate || null,   // PTR filing date from the index
    capitalGainsOver200: null,
    comment: null,
    link: url,
  };
}
