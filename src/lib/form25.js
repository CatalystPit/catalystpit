// FORM 25 — DELISTING NOTICES, ON THE EXISTING SEC PATH.
//
// ── ⚠️ WHY THIS EXISTS ──────────────────────────────────────────────────────
//
// Pit Scan found SRZN moving 97% with no evidence anywhere in Catalyst Pit. EDGAR had the answer
// we were not reading: a Form 25-NSE on 2026-08-07. PMAX had the same shape — and being a foreign
// private issuer it files 20-F/6-K, never an 8-K, so it could not have produced a filing catalyst
// under any circumstances. Form 25 is the one SEC form that reaches every issuer regardless of
// domestic or foreign status.
//
// ── ⚠️ WHAT THE FORM ESTABLISHES, AND WHAT IT DOES NOT ──────────────────────
//
// The form TYPE says who acted, which is why neither summary is speculative:
//
//   25-NSE   filed BY THE EXCHANGE   → "Exchange filed notice of removal from listing"
//   25       filed BY THE ISSUER     → "Notice to withdraw security from listing"
//
// It does NOT say the company is failing. A Form 25 also covers moving between exchanges and
// retiring one class of security while others keep trading. The evidence record states what was
// filed and by whom, and stops there — see ITEM_TO_TYPE in evidence/resolve.js.
//
// ── ⚠️ NO SECOND STORE AND NO SECOND ENGINE ─────────────────────────────────
//
// Rows land in eightk_filings under the pseudo item codes '25-NSE' / '25', so accession dedupe,
// filed_at ordering, the ticker association and the whole catalyst evidence path are the ones that
// already work and are already tested. The alternative was a parallel table plus a parallel
// resolver, which is two sources of truth for "what did this company file".

import { db } from './db';
import { eightkFilings } from './schema';
import { submissionDetail, ensureEightkTable, SEC_HEADERS } from './eightk';
import { dailyIndexFilings, recentDays } from './sec-daily-index.mjs';

const PAGES = 2;          // getcurrent pages; Form 25 volume is a fraction of 8-K volume
const MAX_NEW = 40;

/**
 * '25-NSE' when the exchange filed it, '25' when the issuer did, null when the feed handed us
 * something else entirely.
 *
 * ⚠️ browse-edgar's `type=` IS A PREFIX MATCH, NOT AN EXACT ONE. `type=25` returns Form 25 and
 * 25-NSE — and also 253G1, 253G2, 253G3, which are Regulation A offering circulars and have nothing
 * to do with delisting. This returned '25' for ANY title that was not 25-NSE, so an offering
 * circular was stored as "Withdrawal from listing" with material: true. Found in production: PVOZ
 * and SRGZ, both 253G2, both presented as a company leaving its exchange.
 *
 * The form is now read as a whole token off the front of the title and anything that is not exactly
 * 25 or 25-NSE (with an optional /A) is refused, so a new 25-prefixed form cannot quietly arrive as
 * a delisting either.
 */
export function form25Code(title) {
  const form = String(title || '').trim().match(/^([0-9A-Za-z-]+(?:\/A)?)\s*-\s/)?.[1] || '';
  if (/^25-NSE(\/A)?$/i.test(form)) return '25-NSE';
  if (/^25(\/A)?$/i.test(form)) return '25';
  return null;
}

/** Days of the complete daily index to reconcile against — see lib/sec-daily-index.mjs. */
export const RECONCILE_DAYS = 5;

export async function ingestForm25({ days = RECONCILE_DAYS } = {}) {
  await ensureEightkTable();

  const filings = new Map();
  for (let p = 0; p < PAGES; p++) {
    let atomXml;
    try {
      const res = await fetch(
        `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=25&dateb=&owner=include&count=100&start=${p * 100}&output=atom`,
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
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
      // ⚠️ THE FORM TYPE COMES FROM THE FEED'S OWN TITLE, not from the document body. "25-NSE - ACME
      // (0001234567) (Filer)" — the prefix is the form, and it is what decides who filed.
      const code = form25Code(title);
      // ⚠️ A FORM WE DO NOT RECOGNISE IS SKIPPED, NOT GUESSED. See form25Code: the feed returns
      // 253G* alongside Form 25, and defaulting those to '25' published a delisting that never
      // happened. Refusing here is the difference between missing a filing and inventing an event.
      if (!code) continue;
      const company = title.replace(/^25(-NSE)?(\/A)?\s*-\s*/i, '').replace(/\s*\(\d+\)\s*\(Filer\)\s*$/i, '').trim();
      const filedAt = entry.match(/<updated>(.*?)<\/updated>/)?.[1] || null;
      filings.set(accession, {
        cik, accNoDashes, accession, company, filedAt, code,
        filingUrl: link.startsWith('http') ? link : `https://www.sec.gov${link}`,
      });
      added++;
    }
    if (!added && p > 0) break;
  }

  // ⚠️ AND THE COMPLETE RECORD FOR THE LAST FEW DAYS. SRZN's Form 25-NSE was ruled unrecoverable
  // because getcurrent had rolled past it. It had not been unrecoverable; we were reading the wrong
  // endpoint. The daily index lists every Form 25 SEC disseminated that day.
  for (const day of recentDays(days)) {
    let rows25 = [];
    try { rows25 = await dailyIndexFilings(day, ['25', '25-NSE']); } catch { continue; }
    for (const f of rows25) {
      if (filings.has(f.accession)) continue;
      filings.set(f.accession, {
        cik: f.cikPath,
        accNoDashes: f.accession.replace(/-/g, ''),
        accession: f.accession,
        company: f.company,
        // Dissemination date, not now — see the same note in form144.mjs.
        filedAt: `${f.date}T12:00:00Z`,
        code: f.form === '25-NSE' ? '25-NSE' : '25',
        filingUrl: `https://www.sec.gov/Archives/edgar/data/${f.cikPath}/${f.accession.replace(/-/g, '')}/${f.accession}-index.htm`,
      });
    }
  }

  // Only accessions we have never stored — the same dedupe key the 8-K path uses.
  const accs = [...filings.keys()];
  if (!accs.length) return { scanned: 0, inserted: 0 };
  const existing = new Set();
  try {
    const { inArray } = await import('drizzle-orm');
    const have = await db.select({ a: eightkFilings.accession }).from(eightkFilings)
      .where(inArray(eightkFilings.accession, accs));
    for (const r of have) existing.add(r.a);
  } catch { /* a read failure degrades to attempting the insert, which dedupes anyway */ }

  const candidates = [...filings.values()].filter((f) => !existing.has(f.accession)).slice(0, MAX_NEW);
  const cache = new Map();
  const rows = [];
  for (const f of candidates) {
    // The SAME per-company resolver the 8-K ingest uses, so the ticker association meets the
    // existing standard rather than a new one. No ticker means no tradeable name; skip it.
    const d = await submissionDetail(f.cik, f.accession, cache);
    if (!d || !d.ticker) continue;
    const cikUnpadded = String(Number(f.cik));
    rows.push({
      ticker: d.ticker,
      company: d.name || f.company || null,
      cik: f.cik,
      items: f.code,                       // '25-NSE' or '25' — see the header note
      material: true,
      primaryDocUrl: d.primaryDocument
        ? `https://www.sec.gov/Archives/edgar/data/${cikUnpadded}/${f.accNoDashes}/${d.primaryDocument}` : null,
      filingUrl: f.filingUrl,
      reportDate: d.reportDate || null,    // eventTime
      accession: f.accession,
      filedAt: f.filedAt ? new Date(f.filedAt) : new Date(),   // publicTime
    });
  }

  let inserted = 0;
  if (rows.length) {
    const res = await db.insert(eightkFilings).values(rows)
      .onConflictDoNothing({ target: eightkFilings.accession })
      .returning({ id: eightkFilings.id, ticker: eightkFilings.ticker });
    inserted = res.length;
    try {
      const { markConsensusDirty } = await import('./consensus/materialization.mjs');
      await markConsensusDirty(res.map((r) => r.ticker));
    } catch { /* freshness hint only; the filings above have already committed */ }
  }
  return { scanned: filings.size, inserted };
}
