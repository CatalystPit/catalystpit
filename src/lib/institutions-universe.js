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
  _ensured = true;
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

// Resolve top unresolved CUSIPs → tickers (shared resolver) and write onto fund_holdings.
export async function resolveHoldingTickers({ cap = 500 } = {}) {
  const rows = await db.select({ cusip: fundHoldings.cusip, v: sql`max(${fundHoldings.value})`.mapWith(Number) })
    .from(fundHoldings).where(isNull(fundHoldings.ticker)).groupBy(fundHoldings.cusip).orderBy(desc(sql`max(${fundHoldings.value})`)).limit(cap);
  const cusips = rows.map((r) => r.cusip);
  if (!cusips.length) return { resolved: 0 };
  const map = await resolveCusips(cusips, { maxLookups: cap });
  let resolved = 0;
  for (const [cusip, ticker] of map) { await db.update(fundHoldings).set({ ticker }).where(and(eq(fundHoldings.cusip, cusip), isNull(fundHoldings.ticker))); resolved++; }
  return { resolved, checked: cusips.length };
}

// Orchestrate one run: discover → ingest a bounded batch of not-yet-ingested filers → resolve tickers.
export async function runInstitutionsUniverse({ indexes = 2, ingestCap = 60, tickerCap = 500, timeBudgetMs = 250000 } = {}) {
  await ensureUniverseTables();
  const t0 = Date.now();
  const featured = await buildFeaturedMap();
  const disc = await discoverFilers({ indexes, featured });
  const cutoff = backfillCutoff();

  // Filers already ingested for the current window (have a fund_filings row at/after cutoff).
  const ingested = new Set((await db.selectDistinct({ cik: fundFilings.cik }).from(fundFilings).where(gte(fundFilings.quarter, cutoff))).map((r) => r.cik));
  const all = await db.select({ cik: institutions.cik, featured: institutions.featuredLabel }).from(institutions);
  const todo = all.filter((i) => !ingested.has(i.cik)).sort((a, b) => (a.featured ? 0 : 1) - (b.featured ? 0 : 1)).slice(0, ingestCap);

  let ingestedNow = 0, storedNow = 0;
  for (const f of todo) {
    if (Date.now() - t0 > timeBudgetMs) break;
    const res = await ingestFiler(f.cik, cutoff);
    if (res.stored) { ingestedNow++; storedNow += res.stored; }
  }
  const tick = await resolveHoldingTickers({ cap: tickerCap });
  return { cutoff, ...disc, filersRemaining: todo.length, ingestedNow, storedNow, tickersResolved: tick.resolved, ms: Date.now() - t0 };
}
