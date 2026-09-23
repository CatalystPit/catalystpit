// SEC EDGAR AS THE CLASSIFICATION FALLBACK — for the issuers Polygon has no SIC for.
//
// ⚠️ THE DEFECT THIS EXISTS TO CLOSE. `sector` had exactly one producer in the whole product:
// sicToMarketSector(polygon.sic_code). Polygon does not supply a SIC for FOREIGN PRIVATE ISSUERS,
// so sicToMarketSector correctly returned null, groupBySector correctly rendered "Other", and every
// layer behaved as designed on an input that was simply absent. Measured on the live Top 500: 113
// of 500 unclassified, 22.6% of the board, and the names in it were TSM, HSBC, BABA, SAP, BP, NVS,
// SAN, SONY, UBS, ING, BHP — some of the largest operating companies on earth.
//
// ⚠️ AND THE DATA IS NOT MISSING, IT WAS NEVER ASKED FOR. Foreign issuers file a 20-F, and EDGAR
// assigns them a SIC code exactly like a domestic filer. The gap is Polygon's coverage, not the
// companies'. This asks SEC.
//
// ⚠️ WHY THIS IS NOT A TICKER→SECTOR MAP. Nothing here names a company or asserts a sector. It
// resolves ticker → CIK → SEC's own `sic` field, and hands that to the SAME sicToMarketSector()
// every domestic security already goes through. A foreign issuer is classified by the identical
// rule as a domestic one, from the same regulator, with the same taxonomy. Adding a lookup table of
// "TSM = Technology" would have hidden the architecture problem instead of fixing it.
//
// ⚠️ AND IT FAILS CLOSED. No CIK, no SIC, or a SIC outside the mapping leaves the sector null, and
// null still renders as Other. An unclassifiable security stays unclassified.

import { sicToMarketSector } from '../market-taxonomy.mjs';

export const SEC_CLASSIFICATION_VERSION = 'sec_sic_v1';

// SEC asks for a descriptive agent with contact details and rate-limits to 10 req/s. One request
// every 120ms is comfortably inside that and is what the existing backfill already used.
const UA = { 'User-Agent': 'CatalystPit Research bcoghill88@gmail.com' };
const PACE_MS = 120;
const pad10 = (cik) => String(cik).padStart(10, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _tickerToCik = null;

/**
 * SEC's own ticker→CIK index. One request for the whole market, cached for the process.
 *
 * Returns null on failure rather than an empty map, so a caller can tell "SEC is unreachable" from
 * "this ticker is not registered" — the difference between skipping a run and writing nulls over
 * good data.
 */
export async function secTickerIndex({ fetchImpl = fetch } = {}) {
  if (_tickerToCik) return _tickerToCik;
  try {
    const r = await fetchImpl('https://www.sec.gov/files/company_tickers.json', { headers: UA, cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    const map = new Map();
    for (const v of Object.values(j || {})) {
      if (v?.ticker && v?.cik_str) map.set(String(v.ticker).toUpperCase(), String(v.cik_str));
    }
    if (!map.size) return null;
    _tickerToCik = map;
    return map;
  } catch { return null; }
}

/** Test seam only — lets a suite exercise the resolver without reaching SEC. */
export function __setTickerIndex(map) { _tickerToCik = map; }

/**
 * One issuer's SIC, straight from SEC's submissions record.
 *
 * @returns { sic, description } | null
 */
export async function secSicFor(ticker, { fetchImpl = fetch, index = null } = {}) {
  const idx = index || await secTickerIndex({ fetchImpl });
  if (!idx) return null;
  const cik = idx.get(String(ticker || '').toUpperCase());
  if (!cik) return null;
  try {
    const r = await fetchImpl(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`, { headers: UA, cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    const sic = parseInt(String(j?.sic ?? ''), 10);
    if (!Number.isFinite(sic) || sic <= 0) return null;
    return { sic, description: j?.sicDescription || null };
  } catch { return null; }
}

/**
 * Resolve classification for a batch of tickers that have no SIC.
 *
 * @returns Map<ticker, { sicCode, sector, industry }> — only tickers SEC could actually classify.
 *          A ticker SEC has no code for is ABSENT from the map rather than present with nulls, so a
 *          caller cannot accidentally write a null over an existing value.
 */
export async function resolveClassifications(tickers, { fetchImpl = fetch, pace = PACE_MS, onProgress } = {}) {
  const out = new Map();
  const list = [...new Set((tickers || []).map((t) => String(t || '').toUpperCase()).filter(Boolean))];
  if (!list.length) return out;
  const index = await secTickerIndex({ fetchImpl });
  if (!index) return out;      // SEC unreachable — write nothing rather than wrong things

  let done = 0;
  for (const t of list) {
    const got = await secSicFor(t, { fetchImpl, index });
    if (got) {
      const sector = sicToMarketSector(got.sic);
      // ⚠️ THE SECTOR MAY STILL BE NULL. A SIC outside the taxonomy's ranges is a real code we
      // cannot map, and null is the honest answer — the sic_code is still worth storing so the
      // mapping can be widened later without re-fetching.
      out.set(t, { sicCode: got.sic, sector, industry: got.description });
    }
    done += 1;
    if (onProgress && done % 100 === 0) onProgress(done, list.length, out.size);
    if (pace) await sleep(pace);
  }
  return out;
}
