// SECTOR AND INDUSTRY OPTIONS, TAKEN FROM THE DATASET RATHER THAN HARDCODED.
//
// ⚠️ WHY THIS EXISTS. The Industry dropdown offered 27 hand-written options against 373 distinct
// industries actually present, so most of the classification in the product was unreachable from
// the filter — and one option ('Gold' → 'GOLD MINING') matched zero rows, which is indistinguishable
// to a user from "no stocks qualify". A hardcoded list cannot track a dataset it does not own.
//
// ⚠️ AND IT RECOVERS NO CLASSIFICATION. Offering every value the data HAS is not the same as
// filling the values it LACKS. 1,605 of the 5,904 visible securities have no sector and 1,563 no
// industry, and nothing here invents one: measured, the gap rows carry no SIC code (0 of 1,605 in
// either table), security_fundamental_snapshot has a sector for 0 of them, and Tiingo's security
// master gates sector/industry to the Dow 30 (usable on 30 of 20,319 rows). There is no
// trustworthy source to recover from, so they stay missing — which is the right outcome, because
// the alternative is assigning a classification we cannot stand behind.

/**
 * ⚠️ WHAT MAY BECOME AN OPTION. Deliberately conservative: a dropdown is a claim that selecting
 * the entry returns something, so anything malformed is dropped rather than shown and broken.
 */
export function isUsableClassification(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 2 || s.length > 80) return false;
  if (/^[\d\W_]+$/.test(s)) return false;                 // digits/punctuation only
  if (/^(n\/?a|none|null|unknown|other|-{1,}|\.+)$/i.test(s)) return false;
  return true;
}

/**
 * Presentation only. The VALUE that filters is never touched — the label is what a human reads.
 *
 * ⚠️ IT MUST NOT COLLAPSE TWO CLASSIFICATIONS INTO ONE LABEL. Title-casing is safe because it is
 * a bijection on these values; anything that merged, truncated or re-grouped them would make two
 * different industries look like one entry, and a user picking it would get a set they did not ask
 * for. The caller asserts label uniqueness for that reason.
 */
export function prettyClassification(v) {
  return String(v).trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    // Keep genuinely capitalised fragments readable rather than "Reit" / "Etf".
    .replace(/\bReit\b/g, 'REIT').replace(/\bEtf\b/g, 'ETF').replace(/\bUs\b/g, 'US');
}

/**
 * Turn raw distinct values into dropdown options.
 *
 * Each option filters by its EXACT stored value, so selecting one cannot return a neighbouring
 * classification — the previous options matched on substrings like 'BANK', which also caught
 * anything merely containing it.
 */
export function toOptions(values, { contains = true } = {}) {
  const seen = new Map();                 // label → value, to prove the mapping stays 1:1
  const out = [];
  for (const raw of values || []) {
    if (!isUsableClassification(raw)) continue;
    const value = String(raw).trim();
    const label = prettyClassification(value);
    if (seen.has(label)) continue;        // identical after normalisation → one entry, not two
    seen.set(label, value);
    out.push(contains ? { label, cond: { contains: value } } : { label, value });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}
