// src/lib/name-resolver.js
//
// SEC company_tickers.json issuer-name → ticker resolver. FALLBACK for holdings whose CUSIP is a
// foreign CINS (letter-prefixed) that OpenFIGI can't map to the US ticker (ASML, Spotify, Seagate,
// Credo, …). These are all SEC filers, so their name↔ticker is authoritative + free here.
// Conservative: normalizes hard, requires a UNIQUE company match (same CIK when a name has several
// tickers → primary), skips bonds/options/derivatives. Never guesses across different companies.

const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const TTL_MS = 12 * 60 * 60 * 1000;

const STOP = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'COMPANIES', 'LTD', 'LIMITED', 'PLC', 'LLC', 'LLP', 'LP', 'NV', 'SA', 'SE', 'AG', 'THE', 'HOLDINGS', 'HOLDING', 'HLDGS', 'HLDG', 'HLDNGS', 'HLDNG', 'PL', 'GROUP', 'GRP', 'TECHNOLOGIES', 'TECHNOLOGY', 'TECH', 'COMMON', 'STOCK', 'SHARES', 'SHARE', 'CLASS', 'CL', 'ADR', 'ADS', 'SPONSORED', 'SPON', 'ORD', 'ORDINARY', 'NEW', 'PUT', 'CALL', 'OPT', 'OPTION', 'WARRANT', 'WT', 'WTS', 'RIGHTS', 'UNIT', 'UNITS']);
const core = (s) => String(s || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((t) => t && t.length > 1 && !STOP.has(t)).join(' ').trim();
const cond = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Bonds/notes/preferreds/options → NOT common stock; never name-match these (they'd hit the equity ticker).
const isDebtDeriv = (s) => /\d[.,]\d/.test(s) || /\d{1,2}\/\d{2}/.test(s) || /\b(NT|NOTE|NOTES|BOND|BONDS|DEB|DEBENTURE|DUE|MTN|PERP|PERPETUAL|SR|SUBORD|SUB|COUPON|MATURES?|FLT|FLOATING|PFD|PREFERRED|PREF|ETN)\b/.test(String(s).toUpperCase());
const pickPrimary = (arr) => { const ciks = new Set(arr.map((x) => x.cik)); if (ciks.size !== 1) return null; return arr.map((x) => x.t).sort((a, b) => a.length - b.length || a.localeCompare(b))[0]; };

let _idx = null, _at = 0;
async function loadIndex() {
  if (_idx && (Date.now() - _at) < TTL_MS) return _idx;
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS });
    if (!r.ok) return _idx;
    const data = await r.json();
    const byCore = new Map(), fullList = [];
    for (const k in data) {
      const t = String(data[k].ticker || '').toUpperCase(), title = data[k].title || '', cik = data[k].cik_str;
      if (!t) continue;
      const c = core(title);
      if (c) { if (!byCore.has(c)) byCore.set(c, []); byCore.get(c).push({ t, cik }); }
      fullList.push({ cond: cond(title), t, cik });
    }
    _idx = { byCore, fullList }; _at = Date.now();
    return _idx;
  } catch { return _idx; }
}

function matchOne(idx, issuer) {
  if (!issuer || isDebtDeriv(issuer)) return null;
  const c = core(issuer);
  if (c && idx.byCore.has(c)) { const p = pickPrimary(idx.byCore.get(c)); if (p) return p; }
  const ic = cond(String(issuer).toUpperCase().replace(/\b(PUT|CALL|OPT|OPTION|WARRANT|WTS?|RIGHTS|UNITS?)\b/g, ''));
  if (ic.length < 5) return null;
  const hits = [];
  for (const e of idx.fullList) { if (e.cond.length >= 5 && (e.cond.startsWith(ic) || ic.startsWith(e.cond))) hits.push(e); }
  return hits.length ? pickPrimary(hits) : null;
}

// issuers: array of issuer-name strings → Map(issuerName → ticker) for the ones we can confidently match.
export async function resolveIssuerNames(issuers) {
  const idx = await loadIndex();
  const out = new Map();
  if (!idx) return out;
  for (const iss of new Set((issuers || []).filter(Boolean))) {
    const t = matchOne(idx, iss);
    if (t) out.set(iss, t);
  }
  return out;
}
