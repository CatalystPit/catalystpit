// TICKER URL GRAMMAR. Pure string work: no database, no network, no secrets, no vendor names — it is
// safe in a client bundle and runs in plain Node, which is what lets the verification script test it
// directly.
//
// This exists because /ticker/[symbol] used to accept ANY path segment. Every arbitrary string —
// /ticker/ZZZZZZ, /ticker/NOTAREALTICKER, /ticker/!!!! — returned HTTP 200 with a confident,
// fully-formed <title> naming it as a security, and /ticker/aapl and /ticker/AAPL were two indexable
// URLs with identical content and no canonical between them. That is an unbounded duplicate surface
// anyone can mint by typing, and it is the single largest index-bloat risk on the site.

// Longest symbol Catalyst Pit holds anywhere is 10 characters. Measured across all seven
// ticker-keyed tables (19,259 distinct symbols): the longest REAL shapes top out at 8 (ALLKGUSD,
// CFTR-PRA), and the only 9- and 10-character entries are extraction artifacts. Ten leaves headroom
// without letting a sentence through.
export const MAX_SYMBOL_LEN = 10;

// A symbol is one or more alphanumeric runs joined by single dots or hyphens, starting with a
// letter. That covers every U.S. shape we actually hold:
//   AAPL  A  ABALX          plain
//   BRK.A BRK.B HEI.A LEN.B MOG.A UHAL.B   dotted share classes
//   BRK-B OAK-PA AHL-PD CFTR-PRA           hyphenated classes and preferreds
//   ACHR.WS NWAX.U GAB.RT ECIA.PK          warrants, units, rights, pink sheets
//
// It is DELIBERATELY not "1-5 letters". That rule would 404 5,120 five-character symbols, all 66
// dotted share classes and all 26 hyphenated ones.
//
// The audit proposed ^[A-Z][A-Z0-9.\-]{0,9}$. This form passes the identical 19,199 symbols — zero
// lost, verified against the live universe — while additionally rejecting degenerate shapes that
// have no separator semantics: a trailing separator (A.), a doubled one (A..B) or a mixed pair
// (A.-B). No security looks like that, and without the tightening "A........." would render as a
// securities page.
const SYMBOL_SHAPE = /^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*$/;

/** True if `s` is already an exactly-canonical symbol: uppercase, well-formed, within length. */
export function isValidSymbol(s) {
  const v = String(s ?? '');
  return v.length > 0 && v.length <= MAX_SYMBOL_LEN && SYMBOL_SHAPE.test(v);
}

/**
 * The canonical uppercase form of a raw URL segment, or null if no legitimate symbol can be read
 * from it. Case is the ONLY thing normalised: BRK.B and BRK-B stay distinct URLs because they are
 * distinct strings in our data, and inventing a mapping between them would be a guess.
 */
export function normalizeSymbol(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  return isValidSymbol(v) ? v : null;
}

// The ticker page's own tab ids, mirrored from TABS in TickerPage.jsx. Only these survive a
// normalising redirect: ?tab=insider is real page state a shared link must keep, while ?ref=,
// ?utm_source= and friends are tracking noise that would otherwise be carried into a permanent
// redirect and mint yet another URL for the same content.
export const TICKER_TABS = new Set([
  'overview', 'news', 'press', 'earnings', 'guidance', 'dividends',
  'analyst', 'insider', 'short', 'government', 'institutions', 'financials',
]);

/**
 * Path to redirect a non-canonical ticker URL to. `overview` is the default tab and is dropped, so
 * /ticker/aapl and /ticker/aapl?tab=overview both land on the single URL /ticker/AAPL rather than
 * creating a second one for the same view.
 */
export function tickerPath(symbol, tab) {
  const t = String(tab ?? '');
  return TICKER_TABS.has(t) && t !== 'overview'
    ? `/ticker/${symbol}?tab=${t}`
    : `/ticker/${symbol}`;
}
