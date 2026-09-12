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

// Standard congressional disclosure amount brackets (lower bounds). An OCR-transcribed amount
// must land on one of these (or the sub-$1,001 tier) to be trusted — a guard against misread
// dollar figures. "Over $50,000,000" parses to a 50,000,001 lower bound.
const BRACKET_LOWERS = new Set([1001, 15001, 50001, 100001, 250001, 500001, 1000001, 5000001, 25000001, 50000001]);
export function validateBracket(raw) {
  if (!raw || typeof raw !== 'string') return false;
  if (/None\b|less than \$?1,?001|^\$?1,?000 or less/i.test(raw)) return true;   // sub-$1,001 tier
  const { min } = parseAmount(raw);
  return min != null && BRACKET_LOWERS.has(min);
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

// Legacy dedup key (FMP-era). Kept only for the one-time migration's reference.
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

// SOURCE-AGNOSTIC canonical dedup key — the identity uq_congress_tx enforces.
// Built from DERIVED/normalized fields (matched member, normalized action, numeric
// amount bounds) NOT raw source strings, so the SAME real trade reported by FMP,
// the House Clerk, or the Senate eFD hashes IDENTICALLY and collapses to one row.
// Deliberately excludes disclosureDate (original vs amendment differ) and raw
// asset/type text (formatting differs per source).
// A stock buy and an option buy of the SAME ticker/day/amount are distinct trades — the filer
// discloses them as separate lines ([ST] vs [OP]). Normalize the option-ness across sources
// (House code 'OP', FMP 'Stock Option') so the discriminator is stable regardless of who reported.
export function isOptionTrade(assetType) {
  const s = (assetType || '').trim().toLowerCase();
  return s === 'op' || s.includes('option');
}
export function canonicalHash({ memberSlug, transactionDate, ticker, action, amountMin, amountMax, isOption, assetDescription }) {
  const key = [
    (memberSlug || '').trim().toLowerCase(),
    transactionDate || '',
    (ticker || '').trim().toUpperCase(),
    (action || '').trim().toUpperCase(),
    amountMin == null ? '' : String(amountMin),
    amountMax == null ? '' : String(amountMax),
    // The security itself. Without this every line sharing a member, date, action and amount
    // bracket collapsed into ONE row, and because roughly half of Senate PTR lines carry no
    // ticker at all (bonds, funds, notes) distinct securities became indistinguishable: one
    // 703-transaction filing stored 373 rows. Normalised so trivial case/whitespace drift
    // between filings does not split a genuine cross-source duplicate back apart.
    // ONLY when there is no ticker. With a ticker the symbol already identifies the security,
    // and folding the description in there re-split genuine cross-source duplicates: the same
    // trade arrives as 'Cadence Design Systems Inc' from one feed and 'Cadence Design Systems,
    // Inc. - Common Stock (CDNS)' from another, which must still collapse to one row.
    ticker ? '' : (assetDescription || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 160),
  ].join('|') + (isOption ? '|OPT' : '');   // option suffix keeps a stock and option sibling separate
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
  // matched -> bioguide (drives headshot + detail route); else name-slug
  const memberSlug = entry?.bioguide || nameSlug(rec.firstName, rec.lastName);
  const action = mapAction(rec.type);
  const isOption = isOptionTrade(rec.assetType);
  return {
    // Canonical, source-agnostic identity: same real trade from FMP / House / Senate collapses to one row.
    // isOption keeps a share buy and an option buy of the same ticker/day/amount as SEPARATE trades.
    txHash: canonicalHash({ memberSlug, transactionDate, ticker, action, amountMin: min, amountMax: max, isOption, assetDescription: rec.assetDescription }),
    chamber,
    firstName: rec.firstName || null,
    lastName:  rec.lastName  || null,
    representative: rec.office || `${rec.firstName || ''} ${rec.lastName || ''}`.trim() || null,
    memberSlug,
    party: entry?.party || null,
    state: entry?.state
      || (rec.district && /^[A-Za-z]{2}/.test(rec.district) ? rec.district.slice(0, 2).toUpperCase() : null),
    district: rec.district || null,
    ticker,
    assetDescription: rec.assetDescription || null,
    assetType: rec.assetType || null,
    owner: rec.owner || null,
    type: rec.type || null,
    action,
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
