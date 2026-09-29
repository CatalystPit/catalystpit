// WHOSE TICKER IS THIS FILING'S TICKER?
//
// ⚠️ A FORM 4's issuerTradingSymbol IS FREE TEXT, and 1,181 of 269,365 stored rows are not a symbol at
// all ("Z AND ZG", "NYSE: VTEX", "MOGA/MOGB"). resolveFilerSymbol already refuses those — it returns
// null rather than inventing a symbol, which is why they sit unresolved instead of on a wrong page.
//
// This handles the other failure, which is worse because it is invisible: a symbol that is perfectly
// well formed and belongs to SOMEBODY ELSE. Measured on the live corpus, 8 tickers carry filings from a
// company that is not the company the ticker names:
//
//   FN    8 DoorDash rows on Fabrinet's page          DoorDash also files as DASH
//   CXDO  1 PEDEVCO row on Crexendo's page            PEDEVCO also files as PED
//   TSBK  2 Riverview Bancorp rows on Timberland's    Riverview also files as RVSB
//   VKI   2 Bank of America rows on an Invesco fund   BofA also files as BAC
//   TSSI  1 Zomedica row on TSS's page                Zomedica also files as ZOM
//   NNOX, UBCP, BOX — one row each, same shape
//
// ── WHY THE RULE IS NARROW, AND WHY THAT MATTERS ────────────────────────────
//
// The obvious rule — "trust the issuer CIK's usual ticker over the filed symbol" — breaks the moment a
// company CHANGES its symbol: the new symbol has few rows, the old one has thousands, and every new
// filing would be filed under the dead symbol. So the rule here does NOT choose between two symbols
// for one company. It only moves a row OFF a ticker that provably belongs to a different company:
//
//   1. the filed ticker is dominated by a DIFFERENT issuer CIK, and
//   2. this filing's own CIK has a ticker where IT is dominant.
//
// A symbol change satisfies neither — the new symbol is not established by anyone else — so this is
// silent on renames, reorganisations and recased names. Measured: 22 tickers carry more than one issuer
// CIK, and this relocates rows for 8 of them. The other 14 are one company under two CIKs or two
// spellings (Columbia Financial/MD/, ENVIRI vs Enviri, Cosan Ltd. vs Cosan S.A., ATAI after the
// Beckley merger) where the ticker was already right and nothing moves.
//
// Pure: candidates in, a decision out. No database, no network.

/**
 * Build the authority table from rows of (ticker, issuerCik, rowCount).
 *
 * @returns Map(issuerCik -> ticker) for CIKs that dominate a ticker, plus
 *          Map(ticker -> issuerCik) for the dominant holder of each ticker.
 */
export function buildTickerAuthority(rows) {
  const byTicker = new Map();        // ticker -> [{ cik, n }]
  for (const r of rows || []) {
    const t = String(r.ticker ?? '');
    const cik = String(r.issuerCik ?? '');
    const n = Number(r.n) || 0;
    if (!t || !cik || !n) continue;
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(t)) continue;   // a free-text symbol is nobody's authority
    if (!byTicker.has(t)) byTicker.set(t, []);
    byTicker.get(t).push({ cik, n });
  }
  const dominantCikOf = new Map();   // ticker -> cik
  const dominantTickerOf = new Map(); // cik -> ticker (the ticker this cik dominates, most rows first)
  const best = new Map();            // cik -> n of its dominated ticker
  for (const [t, list] of byTicker) {
    // Ties broken by cik so the answer never depends on row order.
    list.sort((a, b) => b.n - a.n || (a.cik < b.cik ? -1 : 1));
    const top = list[0];
    dominantCikOf.set(t, top.cik);
    if (!best.has(top.cik) || top.n > best.get(top.cik)) { best.set(top.cik, top.n); dominantTickerOf.set(top.cik, t); }
  }
  return { dominantCikOf, dominantTickerOf };
}

/**
 * The ticker a filing belongs under, or null to leave it as filed.
 *
 * Returns a string ONLY when both conditions hold: the filed ticker is established by a different
 * company, and this company has a ticker of its own. Anything else — an unknown ticker, a ticker this
 * CIK already dominates, a CIK with no established ticker — returns null and nothing is changed.
 */
export function authoritativeTicker({ ticker, issuerCik }, authority) {
  const t = String(ticker ?? '');
  const cik = String(issuerCik ?? '');
  if (!t || !cik || !authority) return null;
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(t)) return null;      // resolveFilerSymbol owns the malformed case
  const holder = authority.dominantCikOf.get(t);
  if (!holder || holder === cik) return null;               // unknown, or already this company's ticker
  const own = authority.dominantTickerOf.get(cik);
  if (!own || own === t) return null;                       // this company has no page of its own
  return own;
}
