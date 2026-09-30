// src/lib/congress-ingest.mjs
//
// Pure ingest helpers shared by the refresh-congress cron route and the
// seed-congress script. NO database imports here (drizzle/db/schema are
// ESM-syntax .js that node-run .mjs scripts can't import) — the DB writes live
// in the callers. Only pure transforms + provider fetches + node:crypto.

import { createHash } from 'node:crypto';
import { matchMember, norm } from './congress-match.mjs';

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
    // ⚠️ isOption IS ACCEPTED AND DELIBERATELY NOT HASHED. It used to append an '|OPT' suffix so a
    // share buy and an option buy of the same ticker, day and amount stayed separate lines. The
    // trouble is that it is derived from assetType, a RAW PER-SOURCE FIELD — the one category this
    // function's own contract excludes — and the sources contradict each other about it. Pelosi's
    // Bloom Energy trades of 2026-07-24 and 2026-07-28 arrive as 'Stock Option' from one feed and
    // 'ST' from the House Clerk, so the two reports of ONE trade hashed differently, survived the
    // dedupe, and showed twice on the most-viewed politician page in the product.
    //
    // Measured across all 7,956 rows: exactly 2 groups are identical on every other input while
    // disagreeing on option-ness, and both are that cross-source duplicate. ZERO are a genuine
    // stock-and-option pair. So the discriminator was protecting a shape that has never occurred
    // while creating duplicates that had.
    //
    // The trade is stated, not hidden: if a member ever does buy the shares and an option on the
    // same ticker, same day, in the same amount bracket, and one source reports both lines, they now
    // collapse to one row. assetType is still stored on every row, so nothing is lost from the record
    // — only the row's IDENTITY stops depending on a field two sources spell differently.
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}

// Tokens that show up exactly where a symbol belongs but are not symbols. Filers put the
// EXCHANGE, a settlement qualifier, or the asset's plain-English name inside the same
// parentheses a ticker normally occupies, and every entry below reached the ticker column at
// least once: "200? FIG (NYSE)" stored NYSE, "U.S Treasury Bills (partial)" stored PARTIAL,
// "200? BTC (Bitcoin)" stored BITCOIN. Real symbols that merely look like these stay out of
// the list on purpose, CBOE, NDAQ and OTCM among them.
export const NON_SYMBOL_TOKENS = new Set([
  'NYSE', 'NASDAQ', 'NSDQ', 'AMEX', 'ARCA', 'NYSEARCA', 'BATS', 'OTCBB', 'OTC', 'TSX', 'TSXV', 'LSE', 'ASX',
  'PARTIAL', 'EXCHANGED', 'RECEIVED', 'VARIOUS', 'MULTIPLE', 'NONE', 'UNKNOWN', 'PENDING', 'NA',
  'BITCOIN', 'ETHEREUM', 'RIPPLE', 'SOLANA', 'DOGECOIN', 'CARDANO', 'LITECOIN', 'POLKADOT',
  'CHAINLINK', 'AVALANCHE', 'CRYPTO',
]);

// Shape test only. A symbol this accepts may still be a fund, a bond or a foreign listing we
// hold no price history for; that is a coverage question, not a parsing one.
export function isSymbolLike(s) {
  const t = (s || '').trim().toUpperCase();
  return !!t && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t) && !NON_SYMBOL_TOKENS.has(t);
}

const cleanTicker = (s) => {
  const t = (s || '').trim().toUpperCase();
  return isSymbolLike(t) ? t : null;   // null for blank / non-equity / not a symbol at all
};

// ⚠️ A MEMBER IDENTITY IS NEVER INVENTED FROM A NAME THAT HAS NO SURNAME.
//
// The FMP feed sometimes splits a suffixed name so that the SUFFIX lands in lastName:
// { firstName: 'Angus', lastName: 'Jr.' } and { firstName: 'William', lastName: 'IV' }. norm()
// correctly reduces those to nothing, so matchMember returns no entry — and this fallback then
// coined 'angus-jr' and 'william-iv' as though they were people. Both appeared on /politicians as
// members of Congress, and because member_slug is part of canonicalHash, all 27 of their trades were
// SECOND COPIES of trades already held under K000383 (Angus King) and H000601 (Bill Hagerty) from the
// official Senate feed — the dedupe could not see them, since by construction it cannot catch an
// identity error. Both facts were confirmed by the rows citing the same efdsearch.senate.gov PTR.
//
// So: no surname means the record does not identify anybody, and the honest result is null. buildRow
// turns that into a null txHash and the ingests drop the record.
//
// ⚠️ THAT DROP IS NOT FREE, AND IT IS COUNTED. The phantom rows were FMP-era residue (FMP was retired
// on 2026-09-10, in 00e655b4). The House path is now immune by construction — houseRec takes the name
// from the ROSTER entry, so a surname always exists — but the Senate path reads eFD's own first/last
// columns and is the ONLY source for Senate PTRs, with no second feed to fall back on. So a refusal
// here means a real disclosure we do not show. congress-sync counts these and puts the count in its
// heartbeat note, where /api/health surfaces it; showing nothing is recoverable, whereas publishing a
// member of Congress who does not exist is not.
const nameSlug = (first, last) => {
  if (!norm(last)) return null;
  return `${(first || '').trim()}-${(last || '').trim()}`
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
};

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
    // ⚠️ NO IDENTITY, NO HASH. An unidentifiable record gets a null txHash so the ingests' existing
    // filters drop it, rather than a row whose NULL hash cannot conflict and therefore duplicates
    // on every single run. See the note on nameSlug above.
    txHash: memberSlug ? canonicalHash({ memberSlug, transactionDate, ticker, action, amountMin: min, amountMax: max, isOption, assetDescription: rec.assetDescription }) : null,
    // Canonical, source-agnostic identity: same real trade from FMP / House / Senate collapses to one row.
    // isOption keeps a share buy and an option buy of the same ticker/day/amount as SEPARATE trades.
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
  // ⚠️ AND ONLY RECORDS THAT IDENTIFY A MEMBER. A null txHash means the feed's name fields carried no
  // surname, so nobody was identified — see nameSlug. Dropping it here is what keeps an invented member
  // off /politicians and keeps a second copy of an official-feed trade out of the table.
  return [...sen, ...hou].filter(r => r.disclosureDate && r.txHash);
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
