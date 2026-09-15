// src/lib/name-resolver.js
//
// SEC company_tickers.json issuer-name -> ticker resolver. FALLBACK + CORRECTOR for holdings whose
// CUSIP is a foreign CINS OpenFIGI can't map (ASML, Spotify, Seagate, Credo, Chubb, Exxon, ...) or
// where OpenFIGI/the legacy KV cache stored a WRONG/foreign ticker (EXMOC, BCLIEUR, ...).
//
// Matching: strip CDATA + corporate-form and security-descriptor words -> a CONDENSED CORE
// ("EXXON MOBIL CORP" and SEC's "ExxonMobil Holdings Corp" both -> "EXXONMOBIL"); the cores must be
// EQUAL; and the name must identify a UNIQUE company (same CIK when a name has several tickers ->
// the share-class primary). Skips bonds/options.
//
// WHY EQUALITY AND NOT PREFIX. This used to accept a match when either core was a PREFIX of the
// other. A fund's issuer is its sponsor's TRUST, and a sponsor's name is a prefix of every product it
// sponsors, so "INVESCO EXCH TRADED FD TR II" matched the registrant "Invesco Ltd." and 33 unrelated
// Invesco securities were assigned IVZ. The same shape put the ProShares trust on AGQ, Innovator's on
// INHD, the BlackRock closed-end municipal trusts on BLK, Global X and Global Payments on GTLL, and
// the SPDR S&P 500 trust on STT. Equality of cores ends the whole family: EXCH, TRADED and FD are not
// droppable words, so INVESCOEXCHTRADEDFDTRII can never equal INVESCO.
//
// Legitimate matching is not lost with it, because the tolerance lives in the CORE rather than in the
// comparison: corporate form and security descriptors are dropped before comparing, so
// "ALPHABET INC CAP STK CL A" still equals "Alphabet Inc." and "HEICO CORP NEW" still equals
// "HEICO CORP". What no longer happens is one ENTITY reducing into a different, shorter one.

import { ncore, isDebtDeriv } from './issuer-core.mjs';

const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const TTL_MS = 12 * 60 * 60 * 1000;

// Pick one ticker for a matched name. Requires a single company (CIK). If that company has several
// tickers, only resolve when they're SHARE-CLASS variants (shortest is a prefix of all — GOOG/GOOGL,
// ASML/ASMLF). Divergent tickers under one registrant name (an ETF family: VOO/VTI/VUG) → null, so
// we don't guess the wrong ETF; OpenFIGI's CUSIP mapping handles those.
const pickPrimary = (arr) => {
  if (new Set(arr.map((x) => x.cik)).size !== 1) return null;
  const ts = [...new Set(arr.map((x) => x.t))].sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (ts.length === 1) return ts[0];
  return ts.every((t) => t.startsWith(ts[0])) ? ts[0] : null;
};

// Shape SEC's company_tickers.json into the lookup the matcher uses. Exported so the regression
// suite can build an index out of REAL registrant names and assert on it without calling SEC.
export function buildIndex(data) {
  const byN = new Map(), tickers = new Set();
  for (const k in data) {
    const t = String(data[k].ticker || '').toUpperCase(), cik = data[k].cik_str, n = ncore(data[k].title || '');
    if (!t) continue;
    tickers.add(t);
    if (n && n.length >= 3) { if (!byN.has(n)) byN.set(n, []); byN.get(n).push({ t, cik }); }
  }
  return { byN, tickers };
}

let _idx = null, _at = 0;
async function loadIndex() {
  if (_idx && (Date.now() - _at) < TTL_MS) return _idx;
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS });
    if (!r.ok) return _idx;
    _idx = buildIndex(await r.json()); _at = Date.now();
    return _idx;
  } catch { return _idx; }
}

/**
 * One 13F issuer string -> ticker, or null. EXACT core equality against a unique SEC registrant.
 * Exported for the regression suite; `matchOne` below is the internal alias.
 */
export function matchIssuerName(idx, issuer) {
  if (!idx || !issuer || isDebtDeriv(issuer)) return null;
  const n = ncore(String(issuer).replace(/\b(PUT|CALL|OPT|OPTION|WARRANT|WTS?|RIGHTS|UNITS?)\b/gi, ''));
  if (n.length < 4) return null;
  const hits = idx.byN.get(n);
  return hits ? pickPrimary(hits) : null;
}
const matchOne = matchIssuerName;

// Whether a symbol is a real US-listed ticker per SEC. Used to spot bad OpenFIGI/KV values to replace.
export async function isSecTicker(t) {
  const idx = await loadIndex();
  return !!(idx && t && idx.tickers.has(String(t).toUpperCase()));
}

// items: array of { cusip, issuers: [names], current: ticker|null } → array of { cusip, ticker }.
// Resolves nulls AND replaces a `current` ticker that isn't a real US ticker (foreign/junk) with the
// SEC name-match. Tries EVERY issuer variant of a CUSIP (13F issuer strings are messy/inconsistent).
export async function resolveIssuerItems(items) {
  const idx = await loadIndex();
  const out = [];
  if (!idx) return out;
  for (const it of items || []) {
    const cur = it.current ? String(it.current).toUpperCase() : null;
    if (cur && idx.tickers.has(cur)) continue;          // already a good US ticker
    let t = null;
    for (const iss of (it.issuers || [])) { t = matchOne(idx, iss); if (t) break; }
    if (t && t !== cur) out.push({ cusip: it.cusip, ticker: t });
  }
  return out;
}
