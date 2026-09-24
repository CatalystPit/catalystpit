// FORM 144 — NOTICE OF PROPOSED SALE, ON THE EXISTING SEC PATH.
//
// ── ⚠️ WHAT THIS FORM SAYS, AND WHAT IT DOES NOT ────────────────────────────
//
//   Form 144 filed   =  an affiliate has given notice that they INTEND to sell
//   Form 144 filed  !=  shares were sold
//
// That distinction is the entire product here and every label in this file repeats it. A Form 144
// is a notice under Rule 144 covering a PROPOSED sale of restricted or control securities. The
// sale may be executed in full, in part, or not at all, and the eventual sale — if it happens —
// is reported separately on Form 4, which we already ingest. Writing "insider sold $52M" from a
// Form 144 would be a statement about a transaction that has not occurred.
//
// ── ⚠️ WHY IT WAS THE GAP ───────────────────────────────────────────────────
//
// Pit Scan showed SPCX moving with no canonical evidence. The public record had three things we
// could have read and did not; this was the first. Gwynne Shotwell's Form 144 covering 342,170
// shares was on EDGAR, and Catalyst Pit ingested no Form 144 at all — not for SPCX, not for anyone.
// The wire knew about it, but only through a commentary source we deliberately do not treat as
// evidence, so the primary record was the only honest route and it was not connected.
//
// ── ⚠️ THE FORM IS STRUCTURED, WHICH IS WHY THIS IS NOT A GUESS ─────────────
//
// Since 2023 Form 144 is filed as XML, so every field below is READ, not inferred:
//
//   nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold   WHO
//   relationshipToIssuer                                  their standing (Officer / Director / 10%)
//   noOfUnitsSold                                         shares proposed
//   aggregateMarketValue                                  value proposed
//   noOfUnitsOutstanding                                  the denominator, for % of shares out
//   approxSaleDate                                        ⚠️ WHEN — a FUTURE date, in the filing
//
// approxSaleDate is a genuine scheduled-event date of exactly the kind the evidence model's
// eventTime field exists for, and unlike a date parsed out of prose it is a typed field in a form.
//
// ── ⚠️ A SEPARATE TABLE, THE SAME ENGINE ────────────────────────────────────
//
// Form 25 rides eightk_filings because it IS a filing-with-an-item-code, and nothing about it
// needed a column. Form 144 is the opposite: it is six numbers and a date, and flattening those
// into the `items` text column would discard the only part worth reading. It gets its own table
// for the same reason insider_trades and congress_trades have theirs — and then feeds THE SAME
// evidence engine through resolve.js, which is what "no second evidence engine" means.

import { sql } from 'drizzle-orm';
import { db } from './db';
import { dailyIndexFilings, recentDays, cikTickerMap } from './sec-daily-index.mjs';
import { parseForm144 } from './form144-parse.mjs';

// The pure field extraction lives in form144-parse.mjs and is re-exported here so callers have one
// import for "Form 144". See that file for why it is separate.
export { parseForm144, parseSaleDate } from './form144-parse.mjs';

export const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };

const PAGES = 3;         // getcurrent pages; the feed pairs each filing as (Reporting) + (Subject)
const MAX_NEW = 40;      // detail fetches per run — one small XML each, unlike the 8-K path

/**
 * ⚠️ HOW MANY DAYS OF THE COMPLETE INDEX TO RECONCILE AGAINST ON EVERY RUN.
 *
 * getcurrent alone covered roughly the last three hours of Form 144 filings, which is why SPCX's
 * was outside it. The daily index is complete but lags by up to a day, so the two together leave
 * no window in which a filing can be permanently lost — see lib/sec-daily-index.mjs.
 */
export const RECONCILE_DAYS = 3;

let _ensured = false;
export async function ensureForm144Table() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS form144_filings (
    id SERIAL PRIMARY KEY,
    accession TEXT NOT NULL,
    ticker TEXT NOT NULL,
    company TEXT,
    issuer_cik TEXT NOT NULL,
    seller TEXT,
    relationship TEXT,
    security_class TEXT,
    shares NUMERIC,
    aggregate_value NUMERIC,
    shares_outstanding NUMERIC,
    approx_sale_date DATE,
    exchange TEXT,
    filing_url TEXT,
    primary_doc_url TEXT,
    filed_at TIMESTAMPTZ NOT NULL,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_form144_accession ON form144_filings (accession)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_form144_ticker_filed ON form144_filings (ticker, filed_at)`);
  _ensured = true;
}

// The CIK -> ticker map moved to sec-daily-index.mjs when Schedule 13D needed the same lookup.
// Re-exported here so a caller importing "the Form 144 module" still finds it.
export { cikTickerMap, __setCikMap } from './sec-daily-index.mjs';

// ── ingest ───────────────────────────────────────────────────────────────────

export async function ingestForm144({ days = RECONCILE_DAYS } = {}) {
  await ensureForm144Table();

  // 1) Scan the market-wide current Form 144 stream.
  //
  // ⚠️ EACH FILING APPEARS TWICE — once under the filer (Reporting) and once under the issuer
  // (Subject) — with the SAME accession. Keying the map on accession collapses them, and the entry
  // we want is whichever one carries a usable link; the XML settles the issuer either way.
  const filings = new Map();
  for (let p = 0; p < PAGES; p++) {
    let atomXml;
    try {
      const res = await fetch(
        `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=144&dateb=&owner=include&count=100&start=${p * 100}&output=atom`,
        { headers: SEC_HEADERS },
      );
      if (!res.ok) break;
      atomXml = await res.text();
    } catch { break; }

    const entries = [...atomXml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
    if (!entries.length) break;
    let added = 0;
    for (const entry of entries) {
      const link = entry.match(/<link[^>]+href="([^"]+)"/)?.[1] || '';
      const lm = link.match(/\/data\/(\d+)\/(\d+)\/([\d-]+)-index\.html?/);
      if (!lm) continue;
      const [, cik, accNoDashes, accession] = lm;
      if (filings.has(accession)) continue;
      const filedAt = entry.match(/<updated>(.*?)<\/updated>/)?.[1] || null;
      filings.set(accession, {
        cik, accNoDashes, accession, filedAt,
        filingUrl: link.startsWith('http') ? link : `https://www.sec.gov${link}`,
      });
      added++;
    }
    if (!added && p > 0) break;
  }

  // 1b) ⚠️ AND THE COMPLETE RECORD FOR THE LAST FEW DAYS. getcurrent is fast and partial; the
  // daily index is complete and up to a day behind. Same accession key, so a filing present in
  // both collapses to one entry and the cost of the overlap is nothing.
  for (const day of recentDays(days)) {
    let rows144 = [];
    try { rows144 = await dailyIndexFilings(day, ['144']); } catch { continue; }
    for (const f of rows144) {
      if (filings.has(f.accession)) continue;
      filings.set(f.accession, {
        cik: f.cikPath,
        accNoDashes: f.accession.replace(/-/g, ''),
        accession: f.accession,
        // The index gives the dissemination DATE, not a timestamp. A filing we only learn about
        // here is dated to that day rather than to now, which would be wrong by up to 72 hours.
        filedAt: `${f.date}T12:00:00Z`,
        filingUrl: `https://www.sec.gov/Archives/edgar/data/${f.cikPath}/${f.accession.replace(/-/g, '')}/${f.accession}-index.htm`,
      });
    }
  }

  const accs = [...filings.keys()];
  if (!accs.length) return { scanned: 0, inserted: 0 };

  // 2) Drop what we already hold — the accession is the SEC's own unique key.
  const existing = new Set();
  try {
    const have = await db.execute(sql`
      select accession from form144_filings where accession = any(${`{${accs.join(',')}}`}::text[])`);
    for (const r of (have?.rows ?? have ?? [])) existing.add(r.accession);
  } catch { /* a read failure degrades to attempting the insert, which dedupes anyway */ }

  const candidates = [...filings.values()].filter((f) => !existing.has(f.accession)).slice(0, MAX_NEW);
  if (!candidates.length) return { scanned: filings.size, inserted: 0 };

  const map = await cikTickerMap();
  const rows = [];
  for (const f of candidates) {
    let parsed = null;
    try {
      // The raw XML, not the XSL-rendered HTML that primaryDocument points at.
      const r = await fetch(
        `https://www.sec.gov/Archives/edgar/data/${String(Number(f.cik))}/${f.accNoDashes}/primary_doc.xml`,
        { headers: SEC_HEADERS },
      );
      if (!r.ok) continue;
      parsed = parseForm144(await r.text());
    } catch { continue; }
    if (!parsed?.issuerCik) continue;
    const hit = map.get(parsed.issuerCik);
    if (!hit?.ticker) continue;                  // no ticker → not a tradeable name; skip

    rows.push({
      accession: f.accession,
      ticker: hit.ticker,
      company: parsed.issuerName || hit.name || null,
      issuerCik: parsed.issuerCik,
      seller: parsed.seller,
      relationship: parsed.relationship,
      securityClass: parsed.securityClass,
      shares: parsed.shares,
      aggregateValue: parsed.aggregateValue,
      sharesOutstanding: parsed.sharesOutstanding,
      approxSaleDate: parsed.approxSaleDate,
      exchange: parsed.exchange,
      filingUrl: f.filingUrl,
      primaryDocUrl: `https://www.sec.gov/Archives/edgar/data/${String(Number(f.cik))}/${f.accNoDashes}/primary_doc.xml`,
      filedAt: f.filedAt ? new Date(f.filedAt) : new Date(),
    });
  }

  let inserted = 0;
  for (const r of rows) {
    try {
      const res = await db.execute(sql`
        insert into form144_filings
          (accession, ticker, company, issuer_cik, seller, relationship, security_class,
           shares, aggregate_value, shares_outstanding, approx_sale_date, exchange,
           filing_url, primary_doc_url, filed_at)
        values (${r.accession}, ${r.ticker}, ${r.company}, ${r.issuerCik}, ${r.seller},
                ${r.relationship}, ${r.securityClass}, ${r.shares}, ${r.aggregateValue},
                ${r.sharesOutstanding}, ${r.approxSaleDate}, ${r.exchange},
                ${r.filingUrl}, ${r.primaryDocUrl}, ${r.filedAt})
        on conflict (accession) do nothing
        returning id`);
      if ((res?.rows ?? res ?? []).length) inserted++;
    } catch { /* one bad row must not lose the rest of the batch */ }
  }

  if (inserted) {
    try {
      const { markConsensusDirty } = await import('./consensus/materialization.mjs');
      await markConsensusDirty(rows.map((r) => r.ticker));
    } catch { /* freshness hint only; the filings above have already committed */ }
  }
  return { scanned: filings.size, inserted };
}
