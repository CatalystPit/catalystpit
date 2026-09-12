// src/lib/congress-sync.js
//
// Phase 4 orchestrator — ingest congressional trades from the OFFICIAL sources
// (House Clerk PTR PDFs + Senate eFD), replacing the FMP feed. Watermark-driven
// via `congress_filings` so runs are idempotent + bounded; drives to full
// coverage/history across runs. Reuses buildRow (dedup/matching) unchanged.

import { and, eq, ne, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { congressTrades, congressFilings } from './schema';
import roster from './congress-roster.json';
import { buildIndex } from './congress-match.mjs';
import { buildRow, canonicalHash, isOptionTrade } from './congress-ingest.mjs';
import { historyFloor, MAX_HISTORY_DAYS } from './congress-chart.mjs';
import { fetchHouseIndex, fetchHousePtr } from './congress-house.mjs';
import { fetchSenatePtrIndex, fetchSenatePtr, establishSession } from './congress-senate.mjs';

const index = buildIndex(roster);
// How many years back to cover. Start small (nightly), raise for a full historical backfill.
// Hard-capped at 3. Congressional history for this product is deliberately bounded at three
// years, so the env var can lower the window but never widen it past the cap.
const BACKFILL_YEARS = Math.min(3, Math.max(1, parseInt(process.env.CONGRESS_BACKFILL_YEARS || '3', 10) || 3));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _ensured = false;
export async function ensureCongressTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS congress_filings (
    id SERIAL PRIMARY KEY, chamber TEXT NOT NULL, doc_id TEXT NOT NULL, year INTEGER,
    filer_name TEXT, filing_type TEXT, filing_date DATE, format TEXT,
    status TEXT NOT NULL DEFAULT 'pending', txn_count INTEGER DEFAULT 0, url TEXT, error TEXT,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), parsed_at TIMESTAMPTZ
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_congress_filing ON congress_filings (chamber, doc_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_congress_filing_status ON congress_filings (status)`);
  _ensured = true;
}

// DocIDs already processed for a chamber (any terminal status) → skip set.
async function seenDocIds(chamber) {
  // Skip already-processed docs, but RETRY ones that errored (transient fetch/parse failures).
  const rows = await db.select({ docId: congressFilings.docId }).from(congressFilings)
    .where(and(eq(congressFilings.chamber, chamber), ne(congressFilings.status, 'error')));
  return new Set(rows.map((r) => r.docId));
}

async function recordFiling(chamber, { docId, year, filerName, filingType, filingDate, format, status, txnCount, url, error }) {
  await db.insert(congressFilings).values({
    chamber, docId, year: year ? parseInt(year, 10) || null : null, filerName: filerName || null,
    filingType: filingType || null, filingDate: filingDate || null, format: format || null,
    status, txnCount: txnCount || 0, url: url || null, error: error || null,
    parsedAt: new Date(),
  }).onConflictDoUpdate({
    target: [congressFilings.chamber, congressFilings.docId],
    set: { status: sql`excluded.status`, txnCount: sql`excluded.txn_count`, format: sql`excluded.format`,
      url: sql`coalesce(excluded.url, congress_filings.url)`, error: sql`excluded.error`, parsedAt: sql`now()` },
  });
}

// Insert one document's transactions (FMP-shaped recs) → congress_trades, deduped on tx_hash.
async function insertRecs(recs, chamber) {
  if (!recs.length) return 0;
  // The 3-year cap applies to the TRANSACTION date, not the filing date. Bounding the filing
  // window alone still lets old trades in: a 2024 filing can disclose a 2019 purchase, which is
  // how 82 pre-cap rows reached the table. Anything dated before the floor is dropped here.
  const floor = historyFloor();
  const rows = recs.map((rec) => buildRow(rec, chamber, index))
    .filter((r) => r.disclosureDate)
    .filter((r) => !r.transactionDate || r.transactionDate >= floor);
  if (!rows.length) return 0;
  const inserted = await db.insert(congressTrades).values(rows)
    .onConflictDoNothing({ target: congressTrades.txHash })
    .returning({ id: congressTrades.id });
  return inserted.length;
}

// ── House: iterate backfill years (newest first), process unseen PTRs, bounded ──
async function ingestHouse({ ingestCap, t0, timeBudgetMs }) {
  const nowY = new Date().getUTCFullYear();
  const years = [];
  for (let y = nowY; y > nowY - BACKFILL_YEARS; y--) years.push(y);
  const seen = await seenDocIds('house');
  let processed = 0, newTrades = 0, scanned = 0, errors = 0;
  const errorsSample = [];
  const noteErr = (msg) => { const m = String(msg || '').slice(0, 220); if (m && errorsSample.length < 5 && !errorsSample.includes(m)) errorsSample.push(m); };
  for (const y of years) {
    if (processed >= ingestCap || Date.now() - t0 > timeBudgetMs) break;
    let entries;
    try { entries = await fetchHouseIndex(y); } catch (e) { console.log(`[congress-sync] house index ${y}: ${e.message}`); noteErr(`index ${y}: ${e.message}`); continue; }
    for (const e of entries) {
      if (processed >= ingestCap || Date.now() - t0 > timeBudgetMs) break;
      if (seen.has(e.docId)) continue;
      processed++;
      try {
        const res = await fetchHousePtr(e);
        let n = 0;
        if (res.status === 'parsed') n = await insertRecs(res.recs, 'house');
        if (res.status === 'scanned') scanned++;
        if (res.status === 'error') { errors++; noteErr(res.error); }
        await recordFiling('house', { docId: e.docId, year: e.year, filerName: `${e.first} ${e.last}`.trim(), filingType: 'P', filingDate: e.filingDate, format: res.format, status: res.status, txnCount: res.transactions.length, url: res.url, error: res.error });
        newTrades += n;
      } catch (err) {
        errors++; noteErr(`${err?.message} | ${err?.cause?.message || ''}`);
        await recordFiling('house', { docId: e.docId, year: e.year, filerName: `${e.first} ${e.last}`.trim(), filingType: 'P', filingDate: e.filingDate, format: 'efiled', status: 'error', txnCount: 0, url: null, error: err.message });
      }
      await sleep(120);
    }
  }
  return { processed, newTrades, scanned, errors, errorsSample };
}

// ── Senate: pull the PTR feed, process unseen electronic reports, bounded ──
async function ingestSenate({ ingestCap, t0, timeBudgetMs }) {
  const nowY = new Date().getUTCFullYear();
  const startDate = `01/01/${nowY - BACKFILL_YEARS + 1} 00:00:00`;
  const seen = await seenDocIds('senate');
  let feed;
  try { feed = await fetchSenatePtrIndex({ startDate, pageSize: 100, maxPages: 40 }); }
  catch (e) { console.log(`[congress-sync] senate feed: ${e.message}`); return { processed: 0, newTrades: 0, paper: 0, errors: 1 }; }
  const cookies = await establishSession();
  let processed = 0, newTrades = 0, paper = 0, errors = 0;
  for (const row of feed.rows) {
    if (processed >= ingestCap || Date.now() - t0 > timeBudgetMs) break;
    if (!row.docId || seen.has(row.docId)) continue;
    processed++;
    try {
      const res = await fetchSenatePtr(row, cookies);
      let n = 0;
      if (res.status === 'parsed') n = await insertRecs(res.recs, 'senate');
      if (res.status === 'paper') paper++;
      if (res.status === 'error') errors++;
      await recordFiling('senate', { docId: row.docId, year: (row.filingDate || '').slice(0, 4), filerName: `${row.first} ${row.last}`.trim(), filingType: 'ptr', filingDate: row.filingDate, format: res.format, status: res.status, txnCount: res.transactions.length, url: res.url, error: res.error });
      newTrades += n;
    } catch (err) {
      errors++;
      await recordFiling('senate', { docId: row.docId, year: (row.filingDate || '').slice(0, 4), filerName: `${row.first} ${row.last}`.trim(), filingType: 'ptr', filingDate: row.filingDate, format: 'html', status: 'error', txnCount: 0, url: row.href, error: err.message });
    }
    await sleep(1800);   // eFD politeness
  }
  return { processed, newTrades, paper, errors };
}

// One-time migration + ongoing safety net: recompute every existing row's tx_hash to the
// canonical (source-agnostic) key, collapse rows that now share a key (keeping the enriched
// one — priced first, else lowest id), and rewrite survivors' tx_hash. Idempotent: after the
// first pass every group is size 1 and it removes 0. This is what eliminates the FMP↔official
// duplicates. Runs bounded within maxDuration; safe to run repeatedly.
export async function dedupeCongressCanonical({ apply = true } = {}) {
  await ensureCongressTables();
  const t0 = Date.now();
  const rows = await db.select({
    id: congressTrades.id, memberSlug: congressTrades.memberSlug, transactionDate: congressTrades.transactionDate,
    ticker: congressTrades.ticker, action: congressTrades.action, amountMin: congressTrades.amountMin,
    amountMax: congressTrades.amountMax, txHash: congressTrades.txHash, priceAtTrade: congressTrades.priceAtTrade,
    assetType: congressTrades.assetType, assetDescription: congressTrades.assetDescription,
  }).from(congressTrades);

  // Group by canonical hash. isOption keeps stock/option siblings in SEPARATE groups (no re-collapse).
  const groups = new Map();
  for (const r of rows) {
    const h = canonicalHash({ ...r, isOption: isOptionTrade(r.assetType), assetDescription: r.assetDescription });
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(r);
  }

  const losers = [];                 // ids to delete (duplicate rows)
  const rekey = [];                  // survivors whose stored hash differs from canonical
  for (const [h, grp] of groups) {
    grp.sort((a, b) => (b.priceAtTrade != null) - (a.priceAtTrade != null) || a.id - b.id); // prefer enriched, then oldest
    const [keep, ...rest] = grp;
    for (const l of rest) losers.push(l.id);
    if (keep.txHash !== h) rekey.push({ id: keep.id, h });
  }

  if (apply) {
    for (let i = 0; i < losers.length; i += 500) await db.delete(congressTrades).where(inArray(congressTrades.id, losers.slice(i, i + 500)));
    // Bulk-rewrite survivor hashes in batches via a VALUES join (canonical hashes are unique across
    // survivors and differ from the old-formula hashes, so no transient unique-index collision).
    for (let i = 0; i < rekey.length; i += 500) {
      const batch = rekey.slice(i, i + 500);
      const values = sql.join(batch.map((r) => sql`(${r.id}, ${r.h})`), sql`, `);
      // v.id::int — VALUES bound params infer as text, so cast to match t.id (integer).
      await db.execute(sql`UPDATE congress_trades AS t SET tx_hash = v.h FROM (VALUES ${values}) AS v(id, h) WHERE t.id = v.id::int`);
    }
  }
  return { total: rows.length, groups: groups.size, duplicatesRemoved: losers.length, rekeyed: rekey.length, apply, ms: Date.now() - t0 };
}

export async function runCongressSync({ chambers = 'both', ingestCapHouse = 120, ingestCapSenate = 80, timeBudgetMs = 250000, dedupe = true } = {}) {
  await ensureCongressTables();
  const t0 = Date.now();
  const out = { backfillYears: BACKFILL_YEARS };
  // Canonicalize existing rows FIRST so newly-ingested official rows collide with (and are
  // skipped against) the same real trades already present from FMP — otherwise this run would
  // create the duplicates. After the first pass this is a cheap no-op.
  if (dedupe) out.dedupe = await dedupeCongressCanonical({ apply: true });
  if (chambers === 'both' || chambers === 'house') out.house = await ingestHouse({ ingestCap: ingestCapHouse, t0, timeBudgetMs });
  if (chambers === 'both' || chambers === 'senate') out.senate = await ingestSenate({ ingestCap: ingestCapSenate, t0, timeBudgetMs });
  out.ms = Date.now() - t0;
  return out;
}
