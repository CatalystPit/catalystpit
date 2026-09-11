import { sql, eq, and, desc, inArray } from 'drizzle-orm';
import { db } from './db';
import { cusipMap, securityReviewQueue } from './schema';

// ─────────────────────────────────────────────────────────────────────────────
//  Shared security-resolution layer (Phase 1 of the institutions+congress
//  expansion). One durable resolver used by both systems:
//   - CUSIP → ticker, persisted in `cusip_map` (Postgres, not just KV), so a
//     mapping resolves once and is reused everywhere forever.
//   - Anything unresolvable/ambiguous goes to `security_review_queue` for human
//     reconciliation; a resolution writes back so future filings auto-resolve.
//  Never blind-guesses. Non-disruptive: existing flows keep working until later
//  phases switch them onto this resolver.
// ─────────────────────────────────────────────────────────────────────────────

const US_EXCH = new Set(['US', 'UN', 'UW', 'UQ', 'UA', 'UR', 'UP', 'UV', 'UF', 'UD']);
const OPENFIGI_KEY = process.env.OPENFIGI_API_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _ensured = false;
export async function ensureSecurityTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS cusip_map (
    cusip TEXT PRIMARY KEY, ticker TEXT, status TEXT NOT NULL DEFAULT 'unresolved',
    confidence TEXT, source TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS security_review_queue (
    id SERIAL PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, context TEXT,
    occurrences INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'open',
    resolved_ticker TEXT, first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_review_kind_key ON security_review_queue (kind, key)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_review_status ON security_review_queue (status)`);
  _ensured = true;
}

async function kvGet(k) {
  if (!KV_URL || !KV_TOKEN) return null;
  try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store' }); if (!r.ok) return null; const d = await r.json(); return d.result || null; } catch { return null; }
}

async function upsertMap(cusip, ticker, status, confidence, source) {
  await db.insert(cusipMap).values({ cusip, ticker: ticker || null, status, confidence: confidence || null, source: source || null, updatedAt: new Date() })
    .onConflictDoUpdate({ target: cusipMap.cusip, set: { ticker: sql`excluded.ticker`, status: sql`excluded.status`, confidence: sql`excluded.confidence`, source: sql`excluded.source`, updatedAt: sql`now()` } });
}

// Record an unresolved item for human review (idempotent — bumps occurrence count).
export async function recordUnresolved(kind, key, context) {
  try {
    await db.insert(securityReviewQueue).values({ kind, key: String(key).toUpperCase(), context: context || null })
      .onConflictDoUpdate({ target: [securityReviewQueue.kind, securityReviewQueue.key], set: { occurrences: sql`security_review_queue.occurrences + 1`, lastSeen: sql`now()` } });
  } catch { /* non-fatal */ }
}

// A clean, logo-able equity symbol: starts with a letter, ≤9 chars, no spaces/slashes.
// Rejects bond descriptors OpenFIGI returns for note CUSIPs (e.g. "STX 3.5 06/01/28").
export const isTickerShaped = (t) => /^[A-Z][A-Z0-9.\-]{0,8}$/.test(t || '');

// Normalize provider quirks to a clean symbol: '/' class-share separator → '.' (BRK/B → BRK.B),
// strip '*' annotations (EA* → EA). Returns the clean ticker, or null if it still isn't
// ticker-shaped (bonds/preferreds with spaces, foreign codes starting with a digit, etc.).
export const normalizeTicker = (t) => {
  const s = String(t || '').toUpperCase().trim().replace(/\//g, '.').replace(/\*/g, '');
  return isTickerShaped(s) ? s : null;
};

// From OpenFIGI mapping data, pick the best symbol: a US-listed EQUITY with a clean ticker.
// Bonds (marketSector 'Corp'/'Govt') and non-ticker-shaped rows are filtered out, so a note
// CUSIP yields null (→ shows the issuer, no fake ticker) while a stock/ADR CUSIP resolves.
function pickTicker(data) {
  const cands = (data || [])
    .map((d) => ({
      t: normalizeTicker(d.ticker),
      us: US_EXCH.has(d.exchCode),
      equity: d.marketSector === 'Equity' || /stock|depositary|adr|reit|\bshare|fund|etp|unit/i.test(`${d.securityType2 || ''} ${d.securityType || ''}`),
    }))
    .filter((c) => c.t);
  // US-listed only. A foreign-only listing (e.g. a Sandstorm/Brainstorm foreign line) has no US logo
  // and often isn't the right symbol → return null and let the SEC name-resolver find the US ticker.
  const pick = cands.find((c) => c.us && c.equity) || cands.find((c) => c.us);
  return pick ? pick.t : null;
}

// Batch OpenFIGI CUSIP→ticker (US-listed equity preferred). Returns Map(cusip → ticker) for matches only.
async function openfigi(cusips) {
  const out = new Map();
  const batchSize = OPENFIGI_KEY ? 100 : 10;
  for (let i = 0; i < cusips.length; i += batchSize) {
    const batch = cusips.slice(i, i + batchSize);
    try {
      const r = await fetch('https://api.openfigi.com/v3/mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(OPENFIGI_KEY ? { 'X-OPENFIGI-APIKEY': OPENFIGI_KEY } : {}) },
        body: JSON.stringify(batch.map((c) => ({ idType: 'ID_CUSIP', idValue: c }))),
      });
      if (r.ok) {
        const arr = await r.json();
        arr.forEach((res, j) => {
          const t = pickTicker(res.data);
          if (t) out.set(batch[j], t);
        });
      }
    } catch { /* skip batch */ }
    await sleep(OPENFIGI_KEY ? 300 : 2600);
  }
  return out;
}

// Resolve a set of CUSIPs → Map(cusip → ticker) for the ones we can map. Order of resolution:
//   cusip_map (DB) → old KV cache (promote in) → OpenFIGI (persist hits, queue misses).
// Known-unresolved CUSIPs are skipped (not re-queried) to stay bounded. `maxLookups` caps OpenFIGI.
export async function resolveCusips(cusips, { maxLookups = 500 } = {}) {
  await ensureSecurityTables();
  const uniq = [...new Set((cusips || []).filter(Boolean).map((c) => String(c).toUpperCase()))];
  const out = new Map();
  if (!uniq.length) return out;

  // 1) DB cusip_map
  const rows = await db.select().from(cusipMap).where(inArray(cusipMap.cusip, uniq));
  const known = new Map(rows.map((r) => [r.cusip, r]));
  let need = [];
  for (const c of uniq) {
    const r = known.get(c);
    if (r) { if (r.ticker) out.set(c, r.ticker); }   // unresolved-known → skip (don't re-query)
    else need.push(c);
  }
  if (!need.length) return out;

  // 2) Promote old KV cache — PARALLEL (fast) + VALIDATED (only clean ticker-shaped values, so the
  //    legacy cache's bond descriptors like "STX 3.5 06/01/28" are rejected, not promoted).
  const stillNeed = [];
  const writes = [];   // batched cusip_map upserts (per-row writes were the throughput bottleneck)
  for (let i = 0; i < need.length; i += 50) {
    const slice = need.slice(i, i + 50);
    const hits = await Promise.all(slice.map((c) => kvGet(`catalystpit:cusip:${c}`)));
    slice.forEach((c, j) => {
      const kv = normalizeTicker(hits[j]);
      if (kv) { out.set(c, kv); writes.push({ cusip: c, ticker: kv, status: 'resolved', confidence: 'high', source: 'kv', updatedAt: new Date() }); }
      else stillNeed.push(c);
    });
  }

  // 3) OpenFIGI (bounded)
  const toQuery = stillNeed.slice(0, maxLookups);
  const figi = toQuery.length ? await openfigi(toQuery) : new Map();
  for (const c of toQuery) {
    const t = figi.get(c) || null;
    if (t) { out.set(c, t); writes.push({ cusip: c, ticker: t, status: 'resolved', confidence: 'high', source: 'openfigi', updatedAt: new Date() }); }
    else writes.push({ cusip: c, ticker: null, status: 'unresolved', confidence: null, source: 'openfigi', updatedAt: new Date() });
  }

  // Bulk-upsert all decisions (resolved + unresolved) — one write per 500, not per CUSIP.
  for (let i = 0; i < writes.length; i += 500) {
    await db.insert(cusipMap).values(writes.slice(i, i + 500)).onConflictDoUpdate({
      target: cusipMap.cusip,
      set: { ticker: sql`excluded.ticker`, status: sql`excluded.status`, confidence: sql`excluded.confidence`, source: sql`excluded.source`, updatedAt: sql`now()` },
    });
  }
  return out;
}

// Single-CUSIP convenience.
export async function resolveCusip(cusip) {
  const m = await resolveCusips([cusip], { maxLookups: 1 });
  return m.get(String(cusip).toUpperCase()) || null;
}

// ── review-queue admin helpers ──
export async function reviewStats() {
  await ensureSecurityTables();
  const [m] = await db.select({
    resolved: sql`count(*) filter (where status = 'resolved' or status = 'manual')`.mapWith(Number),
    unresolved: sql`count(*) filter (where status = 'unresolved')`.mapWith(Number),
  }).from(cusipMap);
  const [q] = await db.select({ open: sql`count(*) filter (where status = 'open')`.mapWith(Number) }).from(securityReviewQueue);
  return { cusipResolved: m?.resolved || 0, cusipUnresolved: m?.unresolved || 0, reviewOpen: q?.open || 0 };
}
export async function reviewList({ limit = 100 } = {}) {
  await ensureSecurityTables();
  return db.select().from(securityReviewQueue).where(eq(securityReviewQueue.status, 'open')).orderBy(desc(securityReviewQueue.occurrences)).limit(limit);
}
// Human resolves an item → write to cusip_map (manual, high confidence) + close the queue row.
export async function resolveReviewItem(kind, key, ticker) {
  await ensureSecurityTables();
  const k = String(key).toUpperCase(); const t = String(ticker).toUpperCase();
  if (kind === 'cusip') await upsertMap(k, t, 'manual', 'high', 'manual');
  await db.update(securityReviewQueue).set({ status: 'resolved', resolvedTicker: t, resolvedAt: new Date() })
    .where(and(eq(securityReviewQueue.kind, kind), eq(securityReviewQueue.key, k)));
  return reviewStats();
}
