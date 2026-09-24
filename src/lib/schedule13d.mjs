// SCHEDULE 13D / 13D-A INGEST — on the SEC path that already exists.
//
// ── ⚠️ WHY 13D AND NOT 13G ──────────────────────────────────────────────────
//
// Both report crossing 5%. The difference is that 13G is the PASSIVE schedule — index funds and
// custodians file thousands of them and they establish nothing beyond arithmetic. A Schedule 13D
// is filed by a holder who does not qualify as passive, which is the only reason one of the two
// is worth a trader's attention. 13G is deliberately out of scope.
//
// ── ⚠️ AND STILL: 13D FILED != ACTIVIST ─────────────────────────────────────
//
// "Not passive" is a legal category. Founders, sponsors, lenders who took equity in a
// restructuring and holders who simply started talking to management all file 13Ds. Nothing in
// this file infers intent; see schedule13d-parse.mjs, where a purpose is quoted from Item 4 only
// when a sentence states that something HAPPENED.
//
// ── ⚠️ TWO FEEDS, ONE ACCESSION KEY ─────────────────────────────────────────
//
//   getcurrent(type="SCHEDULE 13D")   seconds old, partial — catches both 13D and 13D/A by prefix
//   daily index                       complete, up to a day behind
//
// Measured: `type=SC 13D` and `type=13D` both return ZERO entries; EDGAR wants the long form. The
// daily index labels them "SCHEDULE 13D" and "SCHEDULE 13D/A" — not "SC 13D" either. Volume is
// small: 87 unique accessions over 8 days, 17 initial and 70 amendments.
//
// ── ⚠️ THE FEED LISTS EACH FILING TWICE ─────────────────────────────────────
//
// Once under the reporting person and once under the subject issuer, sharing one accession — the
// same shape as Form 144. The map is keyed on accession so the pair collapses, and the XML decides
// which CIK is the issuer, so we never guess from the feed's ordering.

import { sql } from 'drizzle-orm';
import { db } from './db';
import { dailyIndexFilings, recentDays, cikTickerMap, SEC_HEADERS } from './sec-daily-index.mjs';
import { parseSchedule13D, primaryPerson, groupKey, classifyItem4 } from './schedule13d-parse.mjs';

export { parseSchedule13D, classifyItem4, primaryPerson, groupKey } from './schedule13d-parse.mjs';

const PAGES = 2;          // getcurrent pages; 13D volume is a fraction of 8-K volume
const MAX_NEW = 40;

/** Days of the complete daily index to reconcile against — see sec-daily-index.mjs. */
export const RECONCILE_DAYS = 4;

/** The daily index's own labels. `SC 13D` is not one of them. */
export const INDEX_FORMS = ['SCHEDULE 13D', 'SCHEDULE 13D/A'];

let _ensured = false;
export async function ensureSchedule13dTable() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS schedule13d_filings (
    id SERIAL PRIMARY KEY,
    accession TEXT NOT NULL,
    ticker TEXT NOT NULL,
    issuer_cik TEXT NOT NULL,
    issuer_name TEXT,
    cusip TEXT,
    security_class TEXT,
    form_type TEXT NOT NULL,
    is_amendment BOOLEAN NOT NULL DEFAULT FALSE,
    filer_name TEXT,
    filer_cik TEXT,
    filer_type TEXT,
    pct_of_class NUMERIC,
    shares NUMERIC,
    persons JSONB,
    item4_codes TEXT[],
    date_of_event DATE,
    group_key TEXT,
    filing_url TEXT,
    primary_doc_url TEXT,
    filed_at TIMESTAMPTZ NOT NULL,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // ⚠️ ONE ACCESSION, ONE ROW. The SEC's own unique identifier is the dedupe key, exactly as on
  // eightk_filings and form144_filings, so reprocessing a day costs nothing and changes nothing.
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_sched13d_accession ON schedule13d_filings (accession)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sched13d_ticker_filed ON schedule13d_filings (ticker, filed_at)`);
  // The amendment comparison reads this: latest prior filing by the same filer on the same name.
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sched13d_group ON schedule13d_filings (group_key, filed_at)`);
  _ensured = true;
}

export async function ingestSchedule13D({ days = RECONCILE_DAYS } = {}) {
  await ensureSchedule13dTable();

  const filings = new Map();

  // 1) getcurrent — the fast, partial feed. Prefix matching returns 13D and 13D/A together.
  for (let p = 0; p < PAGES; p++) {
    let atomXml;
    try {
      const res = await fetch(
        `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent('SCHEDULE 13D')}&dateb=&owner=include&count=100&start=${p * 100}&output=atom`,
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
        cikPath: cik, accNoDashes, accession, filedAt,
        filingUrl: link.startsWith('http') ? link : `https://www.sec.gov${link}`,
      });
      added++;
    }
    if (!added && p > 0) break;
  }

  // 2) The complete record for the last few days.
  for (const day of recentDays(days)) {
    let rows = [];
    try { rows = await dailyIndexFilings(day, INDEX_FORMS); } catch { continue; }
    for (const f of rows) {
      if (filings.has(f.accession)) continue;
      const accN = f.accession.replace(/-/g, '');
      filings.set(f.accession, {
        cikPath: f.cikPath, accNoDashes: accN, accession: f.accession,
        // The index gives a dissemination DATE, not a timestamp; dating it to `now` would be wrong
        // by up to four days. Same reasoning as form144.mjs.
        filedAt: `${f.date}T12:00:00Z`,
        filingUrl: `https://www.sec.gov/Archives/edgar/data/${f.cikPath}/${accN}/${f.accession}-index.htm`,
      });
    }
  }

  const accs = [...filings.keys()];
  if (!accs.length) return { scanned: 0, inserted: 0 };

  const existing = new Set();
  try {
    const have = await db.execute(sql`
      select accession from schedule13d_filings where accession = any(${`{${accs.join(',')}}`}::text[])`);
    for (const r of (have?.rows ?? have ?? [])) existing.add(r.accession);
  } catch { /* a read failure degrades to attempting the insert, which dedupes anyway */ }

  const candidates = [...filings.values()].filter((f) => !existing.has(f.accession)).slice(0, MAX_NEW);
  if (!candidates.length) return { scanned: filings.size, inserted: 0 };

  const map = await cikTickerMap();
  const rows = [];
  for (const f of candidates) {
    let parsed = null;
    const docUrl = `https://www.sec.gov/Archives/edgar/data/${f.cikPath}/${f.accNoDashes}/primary_doc.xml`;
    try {
      const r = await fetch(docUrl, { headers: SEC_HEADERS });
      if (!r.ok) continue;
      parsed = parseSchedule13D(await r.text());
    } catch { continue; }
    if (!parsed?.issuerCik) continue;
    const hit = map.get(parsed.issuerCik);
    if (!hit?.ticker) continue;                       // no ticker → not a tradeable name; skip

    const lead = primaryPerson(parsed.persons);
    const filedAt = f.filedAt ? new Date(f.filedAt) : new Date();
    // ⚠️ POINT-IN-TIME, FAIL CLOSED. dateOfEvent is the reference date the filer states and is
    // normally earlier than the filing — TriplePoint's said 2025-12-11 on a 2026-09 filing. If it
    // ever postdates the filing the record would violate publicTime >= eventTime, so we drop the
    // event date rather than hand the evidence model something it must quarantine.
    const evt = parsed.dateOfEvent;
    const eventOk = evt && Date.parse(`${evt}T00:00:00Z`) <= filedAt.getTime();

    rows.push({
      accession: f.accession,
      ticker: hit.ticker,
      issuerCik: parsed.issuerCik,
      issuerName: parsed.issuerName || hit.name || null,
      cusip: parsed.cusip,
      securityClass: parsed.securityClass,
      formType: parsed.formType,
      isAmendment: parsed.isAmendment,
      filerName: lead?.name || null,
      filerCik: lead?.cik || null,
      filerType: lead?.personType || null,
      pctOfClass: lead?.pctOfClass ?? null,
      shares: lead?.shares ?? null,
      persons: JSON.stringify(parsed.persons || []),
      item4Codes: classifyItem4(parsed.item4).map((d) => d.code),
      dateOfEvent: eventOk ? evt : null,
      groupKey: groupKey(hit.ticker, parsed.persons),
      filingUrl: f.filingUrl,
      primaryDocUrl: docUrl,
      filedAt,
    });
  }

  let inserted = 0;
  for (const r of rows) {
    try {
      const res = await db.execute(sql`
        insert into schedule13d_filings
          (accession, ticker, issuer_cik, issuer_name, cusip, security_class, form_type,
           is_amendment, filer_name, filer_cik, filer_type, pct_of_class, shares, persons,
           item4_codes, date_of_event, group_key, filing_url, primary_doc_url, filed_at)
        values (${r.accession}, ${r.ticker}, ${r.issuerCik}, ${r.issuerName}, ${r.cusip},
                ${r.securityClass}, ${r.formType}, ${r.isAmendment}, ${r.filerName}, ${r.filerCik},
                ${r.filerType}, ${r.pctOfClass}, ${r.shares}, ${r.persons}::jsonb,
                ${`{${r.item4Codes.join(',')}}`}::text[], ${r.dateOfEvent}, ${r.groupKey},
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
