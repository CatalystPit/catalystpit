// src/lib/congress-ingest.mjs
//
// Pure ingest helpers shared by the refresh-congress cron route and the
// seed-congress script. NO database imports here (drizzle/db/schema are
// ESM-syntax .js that node-run .mjs scripts can't import) — the DB writes live
// in the callers. Only pure transforms + provider fetches + node:crypto.

import { createHash } from 'node:crypto';
import { matchMember } from './congress-match.mjs';

// "$1,001 - $15,000" -> { min, max, mid }. Handles open-ended
// ("Over $50,000,000", "$50,000,001 -") and single values. Nulls if unparseable.
export function parseAmount(raw) {
  if (!raw || typeof raw !== 'string') return { min: null, max: null, mid: null };
  const nums = (raw.match(/[\d,]+/g) || [])
    .map(n => Number(n.replace(/,/g, '')))
    .filter(n => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return { min: null, max: null, mid: null };
  const min = nums[0];
  const max = nums.length > 1 ? nums[1] : null;
  const mid = max != null ? (min + max) / 2 : min;
  return { min, max, mid };
}

// FMP "type" -> normalized action.
export function mapAction(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('purchase')) return 'BUY';
  if (t.includes('sale'))     return 'SELL';
  if (t.includes('exchange')) return 'EXCHANGE';
  return 'OTHER';
}

// Whole days between transaction and disclosure (>=0); null if either missing.
export function filingLagDays(transactionDate, disclosureDate) {
  if (!transactionDate || !disclosureDate) return null;
  const t = Date.parse(transactionDate), d = Date.parse(disclosureDate);
  if (Number.isNaN(t) || Number.isNaN(d)) return null;
  return Math.max(0, Math.round((d - t) / 86_400_000));
}

// Stable synthetic dedup key — the identity that uq_congress_tx enforces.
// Identical inputs always hash identically, so re-ingesting the same disclosure
// produces the same tx_hash and is skipped by onConflictDoNothing.
export function txHash({ firstName, lastName, transactionDate, ticker, type, amountRange, disclosureDate }) {
  const key = [
    (firstName || '').trim().toLowerCase(),
    (lastName  || '').trim().toLowerCase(),
    transactionDate || '',
    (ticker || '').trim().toUpperCase(),
    (type   || '').trim().toLowerCase(),
    (amountRange || '').trim(),
    disclosureDate || '',
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}

const cleanTicker = (s) => {
  const t = (s || '').trim().toUpperCase();
  return t && /^[A-Z][A-Z0-9.\-]*$/.test(t) ? t : null;   // null for blank / non-equity
};

const nameSlug = (first, last) =>
  `${(first || '').trim()}-${(last || '').trim()}`
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;

// One FMP feed record + its chamber + a prebuilt roster index -> DB-ready row.
export function buildRow(rec, chamber, index) {
  const { min, max, mid } = parseAmount(rec.amount);
  const ticker = cleanTicker(rec.symbol);
  const transactionDate = rec.transactionDate || null;
  const disclosureDate  = rec.disclosureDate  || null;
  const { entry } = matchMember(index, {
    firstName: rec.firstName, lastName: rec.lastName, chamber, district: rec.district,
  });
  return {
    txHash: txHash({
      firstName: rec.firstName, lastName: rec.lastName, transactionDate,
      ticker, type: rec.type, amountRange: rec.amount, disclosureDate,
    }),
    chamber,
    firstName: rec.firstName || null,
    lastName:  rec.lastName  || null,
    representative: rec.office || `${rec.firstName || ''} ${rec.lastName || ''}`.trim() || null,
    // matched -> bioguide (drives headshot + detail route); else name-slug
    memberSlug: entry?.bioguide || nameSlug(rec.firstName, rec.lastName),
    party: entry?.party || null,
    state: entry?.state
      || (rec.district && /^[A-Za-z]{2}/.test(rec.district) ? rec.district.slice(0, 2).toUpperCase() : null),
    district: rec.district || null,
    ticker,
    assetDescription: rec.assetDescription || null,
    assetType: rec.assetType || null,
    owner: rec.owner || null,
    type: rec.type || null,
    action: mapAction(rec.type),
    amountRange: rec.amount || null,
    amountMin: min, amountMax: max, amountMid: mid,
    transactionDate,
    disclosureDate,
    filingLagDays: filingLagDays(transactionDate, disclosureDate),
    capGainsOver200: rec.capitalGainsOver200 == null ? null : /^true$/i.test(String(rec.capitalGainsOver200)),
    comment: rec.comment || null,
    link: rec.link || null,
  };
}

// FMP both-chambers pull. Returns rows with a disclosureDate (NOT NULL column).
export async function fetchCongressRows(fmpKey, index) {
  const pull = async (ch) => {
    const r = await fetch(`https://financialmodelingprep.com/stable/${ch}-latest?page=0&apikey=${fmpKey}`);
    if (!r.ok) throw new Error(`FMP ${ch}: HTTP ${r.status}`);
    const data = await r.json();
    return Array.isArray(data) ? data.map(rec => buildRow(rec, ch, index)) : [];
  };
  const [sen, hou] = await Promise.all([pull('senate'), pull('house')]);
  return [...sen, ...hou].filter(r => r.disclosureDate);
}

// Tiingo daily EOD over [from,to]. { ok, status, data }.
export async function fetchTiingoDaily(ticker, from, to, token) {
  const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices`
    + `?startDate=${from}&endDate=${to}&token=${token}`;
  const r = await fetch(url);
  if (!r.ok) return { ok: false, status: r.status, data: null };
  return { ok: true, status: 200, data: await r.json() };
}

// Pick the RAW close on or just before a target date (nearest prior trading
// day). Raw — not adjClose — to share the unadjusted basis of Finnhub /quote.
// Returns { price, priceDate } | null.
export function pickPriceOnOrBefore(series, targetDate) {
  if (!Array.isArray(series) || !series.length || !targetDate) return null;
  const target = targetDate.slice(0, 10);
  const sorted = series
    .map(d => ({ date: (d.date || '').slice(0, 10), close: d.close }))
    .filter(d => d.date && Number.isFinite(d.close))
    .sort((a, b) => a.date.localeCompare(b.date));
  let pick = null;
  for (const d of sorted) { if (d.date <= target) pick = d; else break; }
  if (!pick) pick = sorted[0] || null;            // target before earliest point
  return pick ? { price: pick.close, priceDate: pick.date } : null;
}

// Finnhub real-time quote -> { price, asOf } | null (null when symbol unknown / c<=0).
export async function fetchFinnhubQuote(ticker, token) {
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${token}`);
  if (!r.ok) return null;
  const d = await r.json();
  if (!d || !Number.isFinite(d.c) || d.c <= 0) return null;
  return { price: +d.c.toFixed(2), asOf: d.t ? new Date(d.t * 1000).toISOString().slice(0, 10) : null };
}

// Simple concurrency+gap throttler (mirrors /api/refresh throttledBatch).
export async function throttle(items, perBatch, gapMs, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += perBatch) {
    const batch = items.slice(i, i + perBatch);
    out.push(...await Promise.all(batch.map(worker)));
    if (i + perBatch < items.length) await new Promise(r => setTimeout(r, gapMs));
  }
  return out;
}
