// src/lib/name-resolver.js
//
// SEC company_tickers.json issuer-name → ticker resolver. FALLBACK + CORRECTOR for holdings whose
// CUSIP is a foreign CINS OpenFIGI can't map (ASML, Spotify, Seagate, Credo, Chubb, Exxon, …) or
// where OpenFIGI/the legacy KV cache stored a WRONG/foreign ticker (EXMOC, BCLIEUR, …).
//
// Matching: strip CDATA + corp/descriptor words → a CONDENSED CORE ("EXXON MOBIL CORP" and SEC's
// "ExxonMobil Holdings Corp" both → "EXXONMOBIL"); exact core, else prefix either direction; requires
// a UNIQUE company (same CIK when a name has multiple tickers → primary). Skips bonds/options.

const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const TTL_MS = 12 * 60 * 60 * 1000;

const STOP = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'COMPANIES', 'LTD', 'LIMITED', 'PLC', 'LLC', 'LLP', 'LP', 'NV', 'SA', 'SE', 'AG', 'THE', 'HOLDINGS', 'HOLDING', 'HLDGS', 'HLDG', 'HLDNGS', 'HLDNG', 'PL', 'GROUP', 'GRP', 'TECHNOLOGIES', 'TECHNOLOGY', 'TECH', 'COMMON', 'STOCK', 'SHARES', 'SHARE', 'CLASS', 'CL', 'ADR', 'ADS', 'SPONSORED', 'SPON', 'SPONSORD', 'ORD', 'ORDINARY', 'NEW', 'PUT', 'CALL', 'OPT', 'OPTION', 'WARRANT', 'WT', 'WTS', 'RIGHTS', 'UNIT', 'UNITS', 'SWITZ', 'SWITZERLAND', 'EACH', 'REPRESENTING', 'REPSTG']);
// Condensed core: drop CDATA, punctuation, stopwords + single-letter tokens; join with no spaces.
const ncore = (s) => String(s || '').toUpperCase().replace(/<!\[CDATA\[|\]\]>/g, ' ').replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((t) => t && t.length > 1 && !STOP.has(t)).join('');
const isDebtDeriv = (s) => /\d[.,]\d/.test(s) || /\d{1,2}\/\d{2}/.test(s) || /\b(NT|NOTE|NOTES|BOND|BONDS|DEB|DEBENTURE|DUE|MTN|PERP|PERPETUAL|SR|SUBORD|SUB|COUPON|MATURES?|FLT|FLOATING|PFD|PREFERRED|PREF|ETN)\b/.test(String(s).toUpperCase());
const pickPrimary = (arr) => { const ciks = new Set(arr.map((x) => x.cik)); if (ciks.size !== 1) return null; return arr.map((x) => x.t).sort((a, b) => a.length - b.length || a.localeCompare(b))[0]; };

let _idx = null, _at = 0;
async function loadIndex() {
  if (_idx && (Date.now() - _at) < TTL_MS) return _idx;
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS });
    if (!r.ok) return _idx;
    const data = await r.json();
    const byN = new Map(), list = [], tickers = new Set();
    for (const k in data) {
      const t = String(data[k].ticker || '').toUpperCase(), cik = data[k].cik_str, n = ncore(data[k].title || '');
      if (!t) continue;
      tickers.add(t);
      if (n && n.length >= 3) { if (!byN.has(n)) byN.set(n, []); byN.get(n).push({ t, cik }); list.push({ n, t, cik }); }
    }
    _idx = { byN, list, tickers }; _at = Date.now();
    return _idx;
  } catch { return _idx; }
}

function matchOne(idx, issuer) {
  if (!issuer || isDebtDeriv(issuer)) return null;
  const n = ncore(String(issuer).replace(/\b(PUT|CALL|OPT|OPTION|WARRANT|WTS?|RIGHTS|UNITS?)\b/gi, ''));
  if (n.length < 4) return null;
  if (idx.byN.has(n)) { const p = pickPrimary(idx.byN.get(n)); if (p) return p; }
  const hits = idx.list.filter((e) => e.n.length >= 4 && (e.n.startsWith(n) || n.startsWith(e.n)));
  return hits.length ? pickPrimary(hits) : null;
}

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
