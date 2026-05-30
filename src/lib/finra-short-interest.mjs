// FINRA consolidated short interest — fetch + map helpers for the sync cron and (later) the query route.
//
// Source: POST https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest
// (The documented cdn.finra.org/equity/regsho/monthly/shrt{date}.txt files 403 behind
//  Cloudflare+S3 from server environments; this JSON API is the reachable equivalent and
//  carries the same bi-monthly short-interest metrics plus changePercent/previous.)
//
// Query rules learned from the API:
//  - Filter a single report with settlementDate EQUAL (it's the partition key).
//  - Server-side sort is only allowed when the partition key is pinned, so we sort in JS.
//  - Pagination via limit/offset; record-max-limit = 5000, record-total header = full count.
//  - 204 No Content = that settlement date isn't published yet (FINRA's ~2-week lag).
//  - A browser User-Agent is REQUIRED; the default fetch UA trips Cloudflare → 403.

import { db } from './db';
import { tickerFloat } from './schema';
import { eq } from 'drizzle-orm';

const SI_URL = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';
const FLOAT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // refetch float when older than 30 days
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE = 5000;                // = record-max-limit
const FETCH_TIMEOUT_MS = 30000;

const numOrNull = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));

const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Candidate settlement dates, newest→oldest. FINRA publishes twice a month — mid-month (~15th)
// and month-end. We emit those plus a few prior-day fallbacks per slot so a weekend/holiday
// shift still gets probed; the caller skips 204s and stops at the first date already stored.
export function settlementCandidates(monthsBack = 4) {
  const now = new Date();
  const todayIso = iso(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out = [];
  for (let m = 0; m <= monthsBack; m++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    const y = d.getUTCFullYear(), mon = d.getUTCMonth();
    const lastDay = new Date(Date.UTC(y, mon + 1, 0)).getUTCDate();
    for (const day of [lastDay, lastDay - 1, lastDay - 2, 15, 14, 13]) out.push(iso(y, mon, day));
  }
  return [...new Set(out)].filter((x) => x <= todayIso).sort().reverse();
}

// Fetch ALL pages of one settlement report. Returns { rows, total }; { rows: [], total: 0 } on 204.
// Throws on a non-2xx/204 response so the caller can log-and-continue to the next date.
export async function fetchSettlementReport(date) {
  const all = [];
  let offset = 0, total = null;
  for (;;) {
    const res = await fetch(SI_URL, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        limit: PAGE,
        offset,
        compareFilters: [{ compareType: 'EQUAL', fieldName: 'settlementDate', fieldValue: date }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 204) return { rows: [], total: 0 };
    if (!res.ok) throw new Error(`FINRA ${res.status} for ${date} (offset ${offset})`);
    if (total == null) total = parseInt(res.headers.get('record-total') || '0', 10);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    offset += page.length;
    if (offset >= total || page.length < PAGE) break;
  }
  return { rows: all, total: total ?? all.length };
}

// Map one raw FINRA record → a short_interest row. change_percent prefers the feed value;
// when absent it's computed (cur-prev)/prev*100, NULL on prev==0/missing to avoid divide-by-zero.
export function mapRecord(r) {
  const cur = numOrNull(r.currentShortPositionQuantity);
  const prev = numOrNull(r.previousShortPositionQuantity);
  let change = numOrNull(r.changePercent);
  if (change == null && cur != null && prev != null && prev !== 0) {
    change = +(((cur - prev) / prev) * 100).toFixed(2);
  }
  return {
    settlementDate: r.settlementDate,                       // already 'YYYY-MM-DD'
    ticker: String(r.symbolCode || '').trim().toUpperCase(),
    shortIntShares: cur,
    prevShortIntShares: prev,
    avgDailyVolume: numOrNull(r.averageDailyVolumeQuantity),
    daysToCover: numOrNull(r.daysToCoverQuantity),
    changePercent: change,
    marketCenter: r.marketClassCode || null,
    issueName: r.issueName || null,
    source: 'finra',
  };
}

export const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// FMP /stable/shares-float — SEC-sourced free float. floatShares is the correct
// denominator for "% of float" (excludes restricted/insider shares). Returns null
// on fetch failure; { floatShares:0 } for instruments FMP doesn't float (e.g. ETFs).
export async function fetchFloat(ticker, fmpKey) {
  if (!fmpKey) return null;
  try {
    const r = await fetch(
      `https://financialmodelingprep.com/stable/shares-float?symbol=${encodeURIComponent(ticker)}&apikey=${fmpKey}`,
      { signal: AbortSignal.timeout(12000) },
    );
    if (!r.ok) return null;
    const arr = await r.json();
    const row = Array.isArray(arr) ? arr[0] : arr;
    if (!row || row['Error Message'] || row.floatShares == null) return null;
    return {
      floatShares:       numOrNull(row.floatShares),
      outstandingShares: numOrNull(row.outstandingShares),
      freeFloatPct:      numOrNull(row.freeFloat),
    };
  } catch { return null; }
}

// SINGLE SOURCE OF TRUTH for free float, used by BOTH /api/short-interest (tab) and
// /api/ticker (hero). Reads ticker_float; if missing/>30d-stale, fetches FMP once and
// upserts. Returns { float_shares, outstanding_shares, free_float_pct } (snake_case, the
// shape the Short Interest tab already consumes) or null. Never throws — a float failure
// must not break either caller. Because both routes share this, the hero's % of float and
// the tab's % of float can never diverge for the same ticker.
export async function resolveFloat(ticker) {
  const FMP_API_KEY = process.env.FMP_API_KEY;
  try {
    const [row] = await db.select().from(tickerFloat).where(eq(tickerFloat.ticker, ticker)).limit(1);
    const fresh = row && row.updatedAt && (Date.now() - new Date(row.updatedAt).getTime() < FLOAT_MAX_AGE_MS);
    const fromRow = (r) => ({ float_shares: r.floatShares, outstanding_shares: r.outstandingShares, free_float_pct: r.freeFloatPct });
    if (fresh) return fromRow(row);
    const f = await fetchFloat(ticker, FMP_API_KEY);
    if (!f) return row ? fromRow(row) : null;            // FMP failed → serve stale row if any, else null
    await db.insert(tickerFloat)
      .values({ ticker, floatShares: f.floatShares, outstandingShares: f.outstandingShares, freeFloatPct: f.freeFloatPct, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: tickerFloat.ticker,
        set: { floatShares: f.floatShares, outstandingShares: f.outstandingShares, freeFloatPct: f.freeFloatPct, updatedAt: new Date() },
      });
    return { float_shares: f.floatShares, outstanding_shares: f.outstandingShares, free_float_pct: f.freeFloatPct };
  } catch { return null; }
}
