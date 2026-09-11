import { and, eq, gte, sql, desc, isNull, isNotNull } from 'drizzle-orm';
import { db } from './db';
import { fundHoldings, fundFilings, institutions } from './schema';
import { INSTITUTIONS } from './institutions.mjs';
import { resolveCusips } from './security-resolver';

// ─────────────────────────────────────────────────────────────────────────────
//  INSTITUTIONS UNIVERSE (Phase 2) — auto-discover EVERY SEC 13F filer from the
//  quarterly full-index (no curated list), register them in `institutions`, and
//  ingest their 13F-HR holdings (amendment-aware) into fund_holdings/fund_filings.
//  CUSIP→ticker via the shared security-resolver. The existing ~57 curated funds
//  are flagged as FEATURED (their slugs/labels preserved) but no longer gate what
//  gets ingested. Bounded per run; drive to full coverage/depth across runs.
// ─────────────────────────────────────────────────────────────────────────────

const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const BACKFILL_QUARTERS = Math.max(1, parseInt(process.env.INSTITUTIONS_BACKFILL_QUARTERS || '4', 10) || 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad10 = (c) => String(c).replace(/\D/g, '').padStart(10, '0');
const unpad = (c) => String(Number(String(c).replace(/\D/g, '')));
const slugify = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function secJson(url) { try { const r = await fetch(url, { headers: SEC_HEADERS, cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; } }
async function secText(url) { try { const r = await fetch(url, { headers: SEC_HEADERS, cache: 'no-store' }); return r.ok ? await r.text() : null; } catch { return null; } }
async function kvGet(k) { if (!KV_URL || !KV_TOKEN) return null; try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } }); if (!r.ok) return null; return (await r.json())?.result ?? null; } catch { return null; } }

let _ensured = false;
export async function ensureUniverseTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS institutions (
    cik TEXT PRIMARY KEY, name TEXT, slug TEXT, featured_label TEXT, manager TEXT, category TEXT,
    first_seen_quarter DATE, last_quarter DATE, filing_count INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_institutions_slug ON institutions (slug)`);
  await db.execute(sql`ALTER TABLE fund_holdings ADD COLUMN IF NOT EXISTS accession TEXT`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS ticker_institutional_ownership (
    ticker TEXT PRIMARY KEY, as_of_quarter DATE, inst_shares DOUBLE PRECISION, inst_value DOUBLE PRECISION,
    filer_count INTEGER, shares_out DOUBLE PRECISION, ownership_pct DOUBLE PRECISION,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _ensured = true;
}

// Nightly recompute of 13F-reported institutional ownership per ticker. For each fund we take its
// LATEST filed quarter, sum COMMON-stock shares (puts/calls excluded) per ticker, divide by shares
// outstanding (screener_meta → ticker_float fallback). Full refresh (delete + insert) so tickers that
// dropped to zero holders don't linger. `as_of_quarter` = newest contributing quarter per ticker.
export async function runOwnershipAggregate() {
  await ensureUniverseTables();
  const t0 = Date.now();
  await db.execute(sql`DELETE FROM ticker_institutional_ownership`);
  const res = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (cik) cik, quarter
      FROM fund_filings
      ORDER BY cik, quarter DESC
    ),
    agg AS (
      SELECT h.ticker,
             SUM(h.shares)::double precision AS inst_shares,
             SUM(h.value)::double precision  AS inst_value,
             COUNT(DISTINCT h.cik)           AS filer_count,
             MAX(h.quarter)                  AS as_of
      FROM fund_holdings h
      JOIN latest l ON l.cik = h.cik AND l.quarter = h.quarter
      WHERE h.ticker IS NOT NULL
        AND coalesce(h.put_call, '') = ''
        AND coalesce(h.shares, 0) > 0
      GROUP BY h.ticker
    )
    INSERT INTO ticker_institutional_ownership
      (ticker, as_of_quarter, inst_shares, inst_value, filer_count, shares_out, ownership_pct, updated_at)
    SELECT a.ticker, a.as_of, a.inst_shares, a.inst_value, a.filer_count,
           so.shares_out,
           CASE WHEN so.shares_out > 0 THEN a.inst_shares / so.shares_out * 100 ELSE NULL END,
           now()
    FROM agg a
    LEFT JOIN LATERAL (
      SELECT coalesce(sm.shares_out, tf.outstanding_shares) AS shares_out
      FROM (SELECT 1) x
      LEFT JOIN screener_meta sm ON sm.ticker = a.ticker
      LEFT JOIN ticker_float  tf ON tf.ticker = a.ticker
    ) so ON true
  `);
  const [{ n } = { n: 0 }] = (await db.execute(sql`SELECT count(*)::int AS n FROM ticker_institutional_ownership`))?.rows || [];
  return { tickers: n || 0, ms: Date.now() - t0 };
}

// Map unpadded CIK → curated featured info (slug/label/manager/category) so featured funds keep their
// pages. Seeded CIKs come from the config; the rest reuse the CIK the curated cron cached in KV.
export async function buildFeaturedMap() {
  const map = new Map();
  for (const f of INSTITUTIONS) {
    let cik = f.cik ? unpad(f.cik) : await kvGet(`catalystpit:inst:cik:${f.slug}`);
    if (cik) map.set(unpad(cik), { slug: f.slug, label: f.label, manager: f.manager, category: f.category });
  }
  return map;
}

// The n most recent SEC full-index quarters (for filer discovery). server-side Date is fine here.
function recentQuarters(n) {
  const d = new Date();
  let y = d.getUTCFullYear(), q = Math.floor(d.getUTCMonth() / 3) + 1;
  const out = [];
  for (let i = 0; i < n; i++) { out.push({ y, q }); q--; if (q < 1) { q = 4; y--; } }
  return out;
}
// Earliest report-quarter-end we ingest (BACKFILL_QUARTERS back from the current quarter).
function backfillCutoff() {
  const d = new Date();
  let y = d.getUTCFullYear(), q = Math.floor(d.getUTCMonth() / 3) + 1;
  for (let i = 0; i < BACKFILL_QUARTERS; i++) { q--; if (q < 1) { q = 4; y--; } }
  const endMonth = q * 3;
  const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  return `${y}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

// Parse a pipe-delimited SEC master.idx → distinct 13F-HR filers { cik(unpadded) → name }.
function parseMasterIdx(text, into) {
  const lines = text.split('\n');
  let started = false;
  for (const line of lines) {
    if (!started) { if (/^-{5,}/.test(line) || /^CIK\|/.test(line)) { started = true; } continue; }
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const [cik, name, form] = parts;
    if (!String(form).startsWith('13F-HR')) continue;   // 13F-HR + 13F-HR/A
    const c = unpad(cik);
    if (c && c !== '0' && !into.has(c)) into.set(c, name.trim());
  }
}

// Discover all 13F filers from the recent quarterly indexes → upsert into `institutions`.
export async function discoverFilers({ indexes = 2, featured } = {}) {
  await ensureUniverseTables();
  const feat = featured || await buildFeaturedMap();
  const filers = new Map();
  for (const { y, q } of recentQuarters(indexes)) {
    const txt = await secText(`https://www.sec.gov/Archives/edgar/full-index/${y}/QTR${q}/master.idx`);
    if (txt) parseMasterIdx(txt, filers);
    await sleep(150);
  }
  let registered = 0;
  const rows = [...filers.entries()].map(([cik, name]) => {
    const f = feat.get(cik);
    return { cik, name, slug: f?.slug || slugify(name) || `cik-${cik}`, featuredLabel: f?.label || null, manager: f?.manager || null, category: f?.category || null, updatedAt: new Date() };
  });
  for (let i = 0; i < rows.length; i += 300) {
    const batch = rows.slice(i, i + 300);
    await db.insert(institutions).values(batch).onConflictDoUpdate({
      target: institutions.cik,
      set: { name: sql`excluded.name`, slug: sql`coalesce(institutions.slug, excluded.slug)`, featuredLabel: sql`coalesce(excluded.featured_label, institutions.featured_label)`, manager: sql`coalesce(excluded.manager, institutions.manager)`, category: sql`coalesce(excluded.category, institutions.category)`, updatedAt: sql`now()` },
    });
    registered += batch.length;
  }
  return { discovered: filers.size, registered };
}

// ── holdings parsing (ported from the curated cron) ──
function parseInfoTable(xml, wholeDollars) {
  const tag = (block, name) => { const m = block.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i')); return m ? m[1].trim() : ''; };
  const rows = [];
  const blocks = xml.match(/<(?:\w+:)?infoTable>[\s\S]*?<\/(?:\w+:)?infoTable>/gi) || [];
  for (const b of blocks) {
    const cusip = tag(b, 'cusip').toUpperCase();
    if (!cusip) continue;
    const rawValue = parseFloat(tag(b, 'value').replace(/,/g, '')) || 0;
    const shares = parseFloat(tag(b, 'sshPrnamt').replace(/,/g, '')) || 0;
    rows.push({ issuer: tag(b, 'nameOfIssuer'), cls: tag(b, 'titleOfClass') || '', cusip, value: wholeDollars ? rawValue : rawValue * 1000, shares, putCall: tag(b, 'putCall') || '' });
  }
  return rows;
}
async function fetchHoldings(cik, accession, filedDate) {
  const accNoDash = accession.replace(/-/g, '');
  const idx = await secJson(`https://www.sec.gov/Archives/edgar/data/${unpad(cik)}/${accNoDash}/index.json`);
  const items = idx?.directory?.item || [];
  const xmls = items.filter((it) => /\.xml$/i.test(it.name) && !/primary_doc\.xml$/i.test(it.name));
  const wholeDollars = String(filedDate) >= '2023-01-01';
  for (const it of xmls) {
    await sleep(100);
    const xml = await secText(`https://www.sec.gov/Archives/edgar/data/${unpad(cik)}/${accNoDash}/${it.name}`);
    if (xml && /<(?:\w+:)?infoTable>/i.test(xml)) return parseInfoTable(xml, wholeDollars);
  }
  return [];
}

// Authoritative (latest-filed) 13F per report-quarter within the backfill window — amendments win.
function filings13F(sub, cutoff) {
  const R = sub.filings?.recent || {};
  const byQ = new Map();
  for (let i = 0; i < (R.form || []).length; i++) {
    if (!String(R.form[i]).startsWith('13F-HR')) continue;
    const q = R.reportDate?.[i]; if (!q || q < cutoff) continue;
    const filedDate = R.filingDate[i], accession = R.accessionNumber[i];
    const ex = byQ.get(q);
    if (!ex || String(filedDate) > String(ex.filedDate)) byQ.set(q, { accession, filedDate, quarter: q });
  }
  return [...byQ.values()];
}

// Store a filing; supersede any prior accession for the same (cik, quarter) — amendments fully restate.
async function storeFilingSuperseded(cik, quarter, filedDate, accession, rows) {
  const [existing] = await db.select().from(fundFilings).where(and(eq(fundFilings.cik, cik), eq(fundFilings.quarter, quarter))).limit(1);
  if (existing) {
    if (existing.accession === accession) return { skipped: true };
    if (String(existing.filedDate || '') > String(filedDate)) return { older: true };   // keep the newer existing
    await db.delete(fundHoldings).where(and(eq(fundHoldings.cik, cik), eq(fundHoldings.quarter, quarter)));
  }
  const values = rows.map((r) => ({ cik, quarter, cusip: r.cusip, ticker: null, issuer: r.issuer, cls: r.cls, shares: r.shares, value: r.value, putCall: r.putCall, filedDate, accession }));
  for (let i = 0; i < values.length; i += 500) await db.insert(fundHoldings).values(values.slice(i, i + 500)).onConflictDoNothing();
  const totalValue = rows.reduce((s, r) => s + (r.value || 0), 0);
  await db.insert(fundFilings).values({ cik, quarter, filedDate, accession, totalValue, holdingsCount: rows.length })
    .onConflictDoUpdate({ target: [fundFilings.cik, fundFilings.quarter], set: { filedDate: sql`excluded.filed_date`, accession: sql`excluded.accession`, totalValue: sql`excluded.total_value`, holdingsCount: sql`excluded.holdings_count` } });
  return { stored: rows.length };
}

// Ingest one filer's 13F holdings for the backfill window.
export async function ingestFiler(cik, cutoff) {
  const sub = await secJson(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`);
  if (!sub) return { cik, error: 'no-submissions' };
  const filings = filings13F(sub, cutoff);
  let stored = 0, quarters = 0;
  for (const f of filings) {
    const rows = await fetchHoldings(cik, f.accession, f.filedDate);
    if (rows.length) { const res = await storeFilingSuperseded(cik, f.quarter, f.filedDate, f.accession, rows); if (res.stored) { stored += res.stored; quarters++; } }
    await sleep(80);
  }
  // update registry summary
  try {
    const [agg] = await db.select({ n: sql`count(*)`.mapWith(Number), last: sql`max(${fundFilings.quarter})`, first: sql`min(${fundFilings.quarter})` }).from(fundFilings).where(eq(fundFilings.cik, cik));
    await db.update(institutions).set({ name: sub.name || undefined, filingCount: agg?.n || 0, lastQuarter: agg?.last || null, firstSeenQuarter: agg?.first || null, updatedAt: new Date() }).where(eq(institutions.cik, cik));
  } catch { /* non-fatal */ }
  return { cik, quarters, stored };
}

// Resolve tickers for holdings, draining the backlog of NEVER-ATTEMPTED CUSIPs (not yet in
// cusip_map), highest-value first. Excluding CUSIPs already in cusip_map stops the resolver from
// re-thrashing permanently-unmappable bonds/foreign that clog the top-by-value slots. Chunked +
// time-bounded so a big cap stays within maxDuration.
export async function resolveHoldingTickers({ cap = 500, timeBudgetMs = 200000, t0 = Date.now() } = {}) {
  const res = await db.execute(sql`
    SELECT h.cusip AS cusip
    FROM fund_holdings h
    LEFT JOIN cusip_map m ON m.cusip = h.cusip
    WHERE h.ticker IS NULL AND m.cusip IS NULL
    GROUP BY h.cusip
    ORDER BY max(h.value) DESC NULLS LAST
    LIMIT ${cap}
  `);
  const cusips = (res?.rows || []).map((r) => r.cusip).filter(Boolean);
  if (!cusips.length) return { resolved: 0, checked: 0 };
  let resolved = 0, checked = 0;
  for (let i = 0; i < cusips.length; i += 500) {
    if (Date.now() - t0 > timeBudgetMs) break;
    const chunk = cusips.slice(i, i + 500);
    const map = await resolveCusips(chunk, { maxLookups: 500 });
    checked += chunk.length;
    for (const [cusip, ticker] of map) {
      await db.update(fundHoldings).set({ ticker }).where(and(eq(fundHoldings.cusip, cusip), isNull(fundHoldings.ticker)));
      resolved++;
    }
  }
  return { resolved, checked };
}

// One-time cleanup for earlier mis-resolutions. NORMALIZE first (recover real symbols) so we don't
// destroy legit class shares: '/'→'.' (BRK/B → BRK.B), strip '*' (EA* → EA). THEN null only what's
// still not ticker-shaped (real bonds/preferreds with spaces → show issuer, no fake ticker). For
// cusip_map, normalize the same way and delete only the still-invalid non-null rows so they re-resolve.
export async function cleanupBadTickers() {
  await db.execute(sql`UPDATE fund_holdings SET ticker = replace(replace(upper(ticker), '/', '.'), '*', '') WHERE ticker ~ '[/*]'`);
  const h = await db.execute(sql`UPDATE fund_holdings SET ticker = NULL WHERE ticker IS NOT NULL AND ticker !~ '^[A-Z][A-Z0-9.-]{0,8}$'`);
  await db.execute(sql`UPDATE cusip_map SET ticker = replace(replace(upper(ticker), '/', '.'), '*', '') WHERE ticker ~ '[/*]'`);
  const c = await db.execute(sql`DELETE FROM cusip_map WHERE ticker IS NOT NULL AND ticker !~ '^[A-Z][A-Z0-9.-]{0,8}$'`);
  return { holdingsNulled: h?.rowCount ?? null, cusipMapPurged: c?.rowCount ?? null };
}

// Orchestrate one run: discover → ingest a bounded batch of not-yet-ingested filers → resolve tickers.
// tickerOnly: skip discovery/ingestion and just drain the ticker-resolution backlog (fast logo fill).
// cleanup: one-time purge of junk tickers before resolving.
export async function runInstitutionsUniverse({ indexes = 2, ingestCap = 60, tickerCap = 500, timeBudgetMs = 250000, tickerOnly = false, cleanup = false } = {}) {
  await ensureUniverseTables();
  const t0 = Date.now();
  const out = {};
  if (cleanup) { try { out.cleanup = await cleanupBadTickers(); } catch (e) { out.cleanup = { error: e?.message }; } }
  if (tickerOnly) {
    let tick = { resolved: 0, checked: 0 };
    try { tick = await resolveHoldingTickers({ cap: tickerCap, timeBudgetMs, t0 }); }
    catch (e) { console.log(`[institutions-universe] ticker resolve failed: ${e?.message}`); }
    return { ...out, tickerOnly: true, tickersResolved: tick.resolved, tickersChecked: tick.checked, ms: Date.now() - t0 };
  }
  const featured = await buildFeaturedMap();
  const disc = await discoverFilers({ indexes, featured });
  const cutoff = backfillCutoff();

  // Filers already ingested for the current window (have a fund_filings row at/after cutoff).
  const ingested = new Set((await db.selectDistinct({ cik: fundFilings.cik }).from(fundFilings).where(gte(fundFilings.quarter, cutoff))).map((r) => r.cik));
  const all = await db.select({ cik: institutions.cik, featured: institutions.featuredLabel }).from(institutions);
  const todo = all.filter((i) => !ingested.has(i.cik)).sort((a, b) => (a.featured ? 0 : 1) - (b.featured ? 0 : 1)).slice(0, ingestCap);

  let ingestedNow = 0, storedNow = 0, failedNow = 0;
  const errorsSample = [];
  for (const f of todo) {
    if (Date.now() - t0 > timeBudgetMs) break;
    // Per-filer isolation: a single filer's failure (e.g. a concurrent-run duplicate-key
    // race that ON CONFLICT DO NOTHING can't swallow across uncommitted transactions, or
    // a transient DB error) must NOT abort the whole run. Skip it; it's retried next run
    // (ingestion is idempotent). Surface e.cause so the real Postgres reason is visible.
    try {
      const res = await ingestFiler(f.cik, cutoff);
      if (res.stored) { ingestedNow++; storedNow += res.stored; }
    } catch (e) {
      failedNow++;
      const error = `${e?.message || e}`.slice(0, 180);
      const cause = `${e?.cause?.message || ''}`.slice(0, 180);
      console.log(`[institutions-universe] filer ${f.cik} failed: ${error} | cause: ${cause}`);
      if (errorsSample.length < 5) errorsSample.push({ cik: f.cik, error, cause });
    }
  }
  let tick = { resolved: 0 };
  try { tick = await resolveHoldingTickers({ cap: tickerCap, timeBudgetMs, t0 }); }
  catch (e) { console.log(`[institutions-universe] ticker resolve failed: ${e?.message}`); }
  return { ...out, cutoff, ...disc, filersRemaining: todo.length, ingestedNow, storedNow, failedNow, errorsSample, tickersResolved: tick.resolved, ms: Date.now() - t0 };
}
