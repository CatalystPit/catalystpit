// IS THIS LOGO ABOUT THIS SECURITY, OR ABOUT WHOEVER ISSUED IT?
//
// THE PROBLEM. A holding map of Avantis ETFs rendered seven tiles carrying the identical "A"
// mark: AVDE, AVLV, AVEM, AVUV, AVUS, AVES, AVDV. The tickers are correct and each has its own
// CUSIP — verified — and the logo provider is behaving reasonably by returning fund-family
// branding. But a tile whose picture is shared with six of its neighbours identifies the FAMILY,
// not the security, and a map is a visual index: if the picture cannot tell two holdings apart it
// is worse than no picture, because it implies a distinction it does not make.
//
// ⚠️ NO FUND FAMILY IS NAMED ANYWHERE IN THIS FILE, AND NONE MAY BE ADDED. `if (issuer ===
// 'Vanguard')` would be a list that is wrong the day someone launches an ETF, and it encodes a
// guess about branding rather than an observation of it. The rule is a measurement: when several
// DISTINCT tickers resolve to byte-identical image content, that image is family branding — which
// is true of Vanguard and iShares and equally true of an issuer nobody has heard of yet.
//
// THE SIGNAL IS THE CONTENT HASH, because it is the only thing that survives the provider's own
// choices. The URL differs per ticker (…/ticker/AVDE vs …/ticker/AVLV) while the bytes returned
// are the same, so the URL proves nothing; the hash proves it exactly. Hashes are computed once,
// when the proxy already holds the bytes, and cached — nothing is compared at render time.
//
// ⚠️ FAIL OPEN, ALWAYS. A ticker we have not hashed yet is UNKNOWN and keeps its logo. The cost
// of being wrong in that direction is one tile showing family branding for one page view; the
// cost of the other direction is stripping the real logo off AAPL because KV was briefly
// unreachable.

// ⚠️ THIS MODULE IS IMPORTED BY A CLIENT COMPONENT AND MUST STAY NODE-FREE. It originally hashed
// the bytes here too, which pulled `node:crypto` into the Holding Map's bundle and failed the
// build outright (UnhandledSchemeError). Hashing needs the server; deciding what a tile renders
// needs the browser. They are now separated along that line: logoSignature() lives in
// logo-store.mjs beside the KV writes, and everything here is pure data.

/**
 * ⚠️ FOUR, NOT TWO, AND THE MARGIN IS THE POINT. Two tickers legitimately share one company logo
 * all the time — GOOG/GOOGL, BRK.A/BRK.B, FOX/FOXA — and stripping their logo would be the
 * "do not break legitimate company logos" failure. Three is still plausible for a company with
 * three share classes. Four distinct listed tickers resolving to one image is not a share-class
 * structure; it is a fund family, which runs to dozens. The real families clear this by an order
 * of magnitude, so the threshold is not finely balanced.
 */
export const FAMILY_MIN_TICKERS = 4;

export const LOGO_STATE = {
  SPECIFIC: 'SECURITY_SPECIFIC_LOGO',
  GENERIC: 'GENERIC_ISSUER_LOGO',
  NONE: 'NO_LOGO',
  UNKNOWN: 'UNKNOWN',
};

export const sigKey = (ticker) => `logo:sig:${String(ticker || '').toUpperCase()}`;
export const famKey = (sig) => `logo:fam:${sig}`;
export const SIG_TTL_SEC = 60 * 60 * 24 * 30;   // 30 days, same order as the image cache

/**
 * Decide what a tile should render, from facts already gathered.
 *
 * @param {string|null} sig       the ticker's logo signature, 'none' if the provider had none,
 *                                null/undefined if we have never looked
 * @param {number}      sharedBy  how many DISTINCT tickers share that signature
 */
export function classifyLogo(sig, sharedBy) {
  if (sig === 'none') return LOGO_STATE.NONE;
  if (!sig) return LOGO_STATE.UNKNOWN;                 // never measured → keep the logo
  if (!Number.isFinite(sharedBy) || sharedBy < 1) return LOGO_STATE.UNKNOWN;
  return sharedBy >= FAMILY_MIN_TICKERS ? LOGO_STATE.GENERIC : LOGO_STATE.SPECIFIC;
}

/**
 * Should the holding map paint the image for this state?
 *
 * ⚠️ UNKNOWN RENDERS THE LOGO. It is the bootstrap state — the first viewer of a fund we have
 * never hashed — and treating "not yet measured" as "generic" would blank every tile on a cold
 * profile, which is a far more visible wrong than the thing being fixed.
 */
export function showsLogo(state) {
  return state === LOGO_STATE.SPECIFIC || state === LOGO_STATE.UNKNOWN;
}
