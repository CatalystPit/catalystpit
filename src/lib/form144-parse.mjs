// FORM 144 FIELD EXTRACTION — pure, so it can be tested without a database.
//
// Split out of form144.mjs for the same reason model.mjs and history.mjs are separate from
// resolve.js: the ingest needs a connection, the parsing does not, and the parsing is where a
// silently wrong NUMBER would come from. A suite that cannot run these functions without standing
// up Postgres is a suite nobody runs.
//
// See form144.mjs for what the form means and why every field below is read rather than inferred.

// ── XML field extraction ─────────────────────────────────────────────────────

/** XML entities survive the extraction otherwise — measured, "H&amp;S INVESTMENTS I LP". */
const decode = (v) => String(v)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');

const tag = (xml, name) => {
  const m = String(xml).match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1].trim()) : null;
};

const numOf = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** "09/24/2026" -> "2026-09-24". The form writes US order; anything else is left alone. */
export function parseSaleDate(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/**
 * Pull the fields we keep out of one Form 144 XML document.
 *
 * Exported and pure so the regression suite can exercise it against a real document body with no
 * network — the parsing is where a silent wrong number would come from.
 */
export function parseForm144(xml) {
  const issuerCik = tag(xml, 'issuerCik');
  // ⚠️ relationshipToIssuer MAY REPEAT. An affiliate can be an officer AND a director, and keeping
  // only the first would misstate their standing.
  const rels = [...String(xml).matchAll(/<relationshipToIssuer>([\s\S]*?)<\/relationshipToIssuer>/gi)]
    .map((m) => m[1].trim()).filter(Boolean);
  return {
    issuerCik: issuerCik ? String(Number(issuerCik)) : null,
    issuerName: tag(xml, 'issuerName'),
    seller: tag(xml, 'nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold'),
    relationship: rels.length ? [...new Set(rels)].join(', ') : null,
    securityClass: tag(xml, 'securitiesClassTitle'),
    shares: numOf(tag(xml, 'noOfUnitsSold')),
    aggregateValue: numOf(tag(xml, 'aggregateMarketValue')),
    sharesOutstanding: numOf(tag(xml, 'noOfUnitsOutstanding')),
    approxSaleDate: parseSaleDate(tag(xml, 'approxSaleDate')),
    exchange: tag(xml, 'securitiesExchangeName'),
  };
}
