// scripts/backfill-insiders.mjs
//
// Walks SEC EDGAR full-index Form 4 filings for the last 90 days, parses
// each one, and bulk-inserts rows into the insider_trades Postgres table.
// Idempotent via ON CONFLICT DO NOTHING on uq_insider_txn.
//
// Local execution only. Never deploy to Vercel.
//
// Run:
//   node --env-file=.env.local scripts/backfill-insiders.mjs
//
// Requires Node 20.6+ for --env-file. .env.local must contain DATABASE_URL.
//
// DRIFT WARNING: This script duplicates the pgTable schema (from
// src/lib/schema.js) and the Form 4 parser (from src/app/api/refresh/route.js)
// because the .mjs script can't import .js ESM files without a package.json
// "type": "module" change. If schema or parser logic changes upstream, mirror
// the change here. Acceptable for one-time/quarterly backfill; revisit if this
// becomes a recurring tool.

import { drizzle } from 'drizzle-orm/neon-http';
import { neon }    from '@neondatabase/serverless';
import { max, min } from 'drizzle-orm';
import {
  pgTable, serial, text, doublePrecision, date, timestamp,
} from 'drizzle-orm/pg-core';

// ─── Config ───────────────────────────────────────────────────────────────
const LOOKBACK_DAYS = 90;
const BATCH_SIZE    = 500;
const MAX_RPS       = 10;
const SEC_HEADERS   = { 'User-Agent': 'CatalystPit Backfill bcoghill88@gmail.com' };

// ─── Schema mirror (must match src/lib/schema.js) ─────────────────────────
const insiderTrades = pgTable('insider_trades', {
  id:               serial('id').primaryKey(),
  ticker:           text('ticker').notNull(),
  company:          text('company'),
  executive:        text('executive'),
  title:            text('title'),
  transactionCode:  text('transaction_code'),
  action:           text('action').notNull(),
  shares:           doublePrecision('shares').notNull().default(0),
  pricePerShare:    doublePrecision('price_per_share').notNull().default(0),
  totalValue:       doublePrecision('total_value').notNull().default(0),
  sharesOwnedAfter: doublePrecision('shares_owned_after'),
  securityTitle:    text('security_title'),
  transactionDate:  date('transaction_date', { mode: 'string' }),
  filingDate:       date('filing_date',      { mode: 'string' }).notNull(),
  accession:        text('accession').notNull(),
  filingUrl:        text('filing_url'),
  insertedAt:       timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── DB client ────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('[backfill] DATABASE_URL not set. Run with: node --env-file=.env.local scripts/backfill-insiders.mjs');
  process.exit(1);
}
const db = drizzle(neon(process.env.DATABASE_URL));

// ─── Rate limiter (10 RPS to SEC, global across all secFetch calls) ──────
class RateLimiter {
  constructor(maxPerSec) {
    this.interval = 1000 / maxPerSec;
    this.next = 0;
  }
  async wait() {
    const now = Date.now();
    const delay = Math.max(0, this.next - now);
    this.next = Math.max(now, this.next) + this.interval;
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
  }
}
const limiter = new RateLimiter(MAX_RPS);

async function secFetch(url) {
  await limiter.wait();
  const res = await fetch(url, { headers: SEC_HEADERS });
  if (!res.ok) throw new Error(`SEC ${res.status}: ${url}`);
  return res;
}

// ─── Form 4 parser ────────────────────────────────────────────────────────
// DUPLICATED from src/app/api/refresh/route.js — keep in sync if Form 4
// schema changes. Tech debt: extract to shared module if a third caller appears.
const extractFormValue = (xml, tag) =>
  xml.match(new RegExp(`<${tag}>\\s*<value>([\\s\\S]*?)</value>`))?.[1]?.trim();

const extractFormText = (xml, tag) =>
  xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();

const decodeEntities = (s) => {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
};

function parseForm4(xml, filing) {
  if (extractFormText(xml, 'documentType') !== '4') return [];

  const ticker  = extractFormText(xml, 'issuerTradingSymbol')?.toUpperCase();
  const company = decodeEntities(extractFormText(xml, 'issuerName'));
  if (!ticker) return [];

  const executive    = decodeEntities(extractFormText(xml, 'rptOwnerName') || '');
  const isDirector   = ['true','1'].includes(extractFormText(xml, 'isDirector'));
  const isOfficer    = ['true','1'].includes(extractFormText(xml, 'isOfficer'));
  const isTenPercent = ['true','1'].includes(extractFormText(xml, 'isTenPercentOwner'));
  const officerTitle = decodeEntities(extractFormText(xml, 'officerTitle') || '');
  let title;
  if (isOfficer && officerTitle) title = officerTitle;
  else if (isOfficer)            title = 'Officer';
  else if (isDirector)           title = 'Director';
  else if (isTenPercent)         title = '10% Owner';
  else                           title = 'Other';

  const ndtMatch = xml.match(/<nonDerivativeTable>([\s\S]*?)<\/nonDerivativeTable>/);
  if (!ndtMatch) return [];
  const txns = [...ndtMatch[1].matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)]
    .map(m => m[1]);

  return txns.map(txn => {
    const transactionCode = extractFormText(txn, 'transactionCode') || '';
    const transactionDate = extractFormValue(txn, 'transactionDate') || '';
    const shares          = parseFloat(extractFormValue(txn, 'transactionShares'))        || 0;
    const pricePerShare   = parseFloat(extractFormValue(txn, 'transactionPricePerShare')) || 0;
    const securityTitle   = decodeEntities(extractFormValue(txn, 'securityTitle') || '');
    const rawSOA          = extractFormValue(txn, 'sharesOwnedFollowingTransaction');
    const sharesOwnedAfter = rawSOA ? parseFloat(rawSOA) : null;

    let action;
    if      (transactionCode === 'P') action = 'BUY';
    else if (transactionCode === 'S') action = 'SELL';
    else                              action = 'OTHER';

    return {
      ticker, company, executive, title,
      transactionCode: transactionCode || null,
      action,
      shares, pricePerShare,
      totalValue: shares * pricePerShare,
      sharesOwnedAfter,
      securityTitle,
      transactionDate: transactionDate || null,
      filingDate: filing.filingDate,
      accession:  filing.accession,
      filingUrl:  filing.indexUrl,
    };
  });
}

// ─── EDGAR full-index walker ──────────────────────────────────────────────
function quartersBetween(start, end) {
  const qs = [];
  let cur = new Date(start.getFullYear(), Math.floor(start.getMonth() / 3) * 3, 1);
  while (cur <= end) {
    qs.push({ year: cur.getFullYear(), q: Math.floor(cur.getMonth() / 3) + 1 });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 3, 1);
  }
  return qs;
}

async function fetchQuarterForm4Entries(year, q, startIso) {
  const url = `https://www.sec.gov/Archives/edgar/full-index/${year}/QTR${q}/form.idx`;
  console.log(`[backfill] fetching ${url}`);
  const res = await secFetch(url);
  const text = await res.text();

  const entries = [];
  // Match: <formType> <company> <CIK> <YYYY-MM-DD> <edgar/...> — regex is robust
  // to column-width drift in form.idx (which has bitten this script before).
  const rowRe = /^(\S+)\s+(.+?)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(edgar\/\S+)/;
  for (const line of text.split('\n')) {
    const m = line.match(rowRe);
    if (!m) continue;
    if (m[1] !== '4') continue;  // exclude 4/A amendments for v1
    const dateFiled = m[4];
    if (dateFiled < startIso) continue;
    entries.push({ dateFiled, filename: m[5] });
  }
  return entries;
}

function parseFilenameForFiling(filename) {
  // filename: edgar/data/{CIK}/{accession-with-dashes}.txt
  const m = filename.match(/^edgar\/data\/(\d+)\/([\d-]+)\.txt$/);
  if (!m) return null;
  const [, cik, accession] = m;
  const accNoDashes = accession.replace(/-/g, '');
  return { cik, accession, dir: `edgar/data/${cik}/${accNoDashes}/` };
}

async function fetchFilingXml(filename) {
  const parsed = parseFilenameForFiling(filename);
  if (!parsed) return null;
  const idxRes = await secFetch(`https://www.sec.gov/Archives/${parsed.dir}index.json`);
  const idx = await idxRes.json();
  const xmlFile = idx.directory?.item?.find(i => i.name.endsWith('.xml'));
  if (!xmlFile) return null;
  const xmlRes = await secFetch(`https://www.sec.gov/Archives/${parsed.dir}${xmlFile.name}`);
  return xmlRes.text();
}

function buildFilingMeta(entry) {
  const parsed = parseFilenameForFiling(entry.filename);
  return {
    filingDate: entry.dateFiled,
    accession: parsed?.accession ?? entry.filename,
    indexUrl: parsed
      ? `https://www.sec.gov/Archives/${parsed.dir}${parsed.accession}-index.htm`
      : `https://www.sec.gov/Archives/${entry.filename}`,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const today    = new Date();
  const todayIso = today.toISOString().slice(0, 10);

  // Resumability: only short-circuit if we already have full 90-day coverage.
  // Checking MAX alone breaks when the cron has populated recent rows but no
  // historical exists — MAX = today and the backfill skips itself entirely.
  const earliestNeeded    = new Date(today.getTime() - LOOKBACK_DAYS * 86400_000);
  const earliestNeededIso = earliestNeeded.toISOString().slice(0, 10);
  const [coverage] = await db.select({
    maxDate: max(insiderTrades.filingDate),
    minDate: min(insiderTrades.filingDate),
  }).from(insiderTrades);
  const dbMax = coverage?.maxDate;
  const dbMin = coverage?.minDate;
  const haveFullCoverage = !!(dbMin && dbMin <= earliestNeededIso);
  const startDate = haveFullCoverage ? new Date(dbMax) : earliestNeeded;
  const startIso  = startDate.toISOString().slice(0, 10);
  console.log(`[backfill] window ${startIso} → ${todayIso}  (dbMin=${dbMin ?? 'none'}, dbMax=${dbMax ?? 'none'}, fullCoverage=${haveFullCoverage})`);

  // Walk quarters covering the window
  const quarters = quartersBetween(startDate, today);
  let allEntries = [];
  for (const { year, q } of quarters) {
    try {
      const entries = await fetchQuarterForm4Entries(year, q, startIso);
      console.log(`[backfill] Q${q} ${year}: ${entries.length} Form 4 entries in window`);
      allEntries = allEntries.concat(entries);
    } catch (e) {
      console.error(`[backfill] failed Q${q} ${year}: ${e.message}`);
    }
  }
  console.log(`[backfill] total filings to process: ${allEntries.length}`);

  // Process filings, flush in batches of 500
  let batch = [];
  let processed = 0, totalInserted = 0, totalDupes = 0, totalFailed = 0, totalTxns = 0;

  async function flushBatch() {
    if (batch.length === 0) return;
    try {
      const inserted = await db.insert(insiderTrades)
        .values(batch)
        .onConflictDoNothing({
          target: [
            insiderTrades.accession,
            insiderTrades.transactionDate,
            insiderTrades.transactionCode,
            insiderTrades.securityTitle,
            insiderTrades.shares,
            insiderTrades.pricePerShare,
            insiderTrades.sharesOwnedAfter,
          ],
        })
        .returning({ id: insiderTrades.id });
      totalInserted += inserted.length;
      totalDupes    += (batch.length - inserted.length);
    } catch (e) {
      console.error(`[backfill] batch insert failed (size ${batch.length}): ${e.message}`);
      totalFailed += batch.length;
    }
    batch = [];
  }

  for (const entry of allEntries) {
    try {
      const xml = await fetchFilingXml(entry.filename);
      if (xml) {
        const rows = parseForm4(xml, buildFilingMeta(entry)).filter(r => r.filingDate);
        totalTxns += rows.length;
        batch.push(...rows);
        if (batch.length >= BATCH_SIZE) await flushBatch();
      }
    } catch (e) {
      totalFailed++;
      console.error(`[backfill] filing failed (${entry.filename}): ${e.message}`);
    }
    processed++;
    if (processed % 100 === 0) {
      console.log(`[backfill] processed ${processed}/${allEntries.length} · inserted ${totalInserted} · dupes ${totalDupes} · failed ${totalFailed}`);
    }
  }
  await flushBatch();

  console.log(`[backfill] DONE`);
  console.log(`[backfill] filings processed:   ${processed}`);
  console.log(`[backfill] transactions parsed: ${totalTxns}`);
  console.log(`[backfill] rows inserted:       ${totalInserted}`);
  console.log(`[backfill] dupes skipped:       ${totalDupes}`);
  console.log(`[backfill] filings failed:      ${totalFailed}`);
}

main().catch(e => {
  console.error(`[backfill] fatal: ${e.message}`);
  process.exit(1);
});
