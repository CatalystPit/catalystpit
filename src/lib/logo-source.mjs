// ── WHERE A COMPANY LOGO COMES FROM, AND WHAT WE ARE ALLOWED TO DO WITH IT ──
//
// ⚠️ THIS IS INERT UNTIL SOMEBODY WITH AUTHORITY TURNS IT ON. No token is set, so
// `logoConfigured()` is false, `tickerLogoUrl()` returns null, and <TickerLogo> renders the ticker
// monogram exactly as it does today. Nothing here fetches anything by itself. The activation
// checklist is at the bottom of this file.
//
// ── ⚠️ WHY A NEW VENDOR AT ALL ───────────────────────────────────────────────
//
// /api/logo once proxied logo.dev and financialmodelingprep, and /api/ticker hotlinked
// static2.finnhub.io. A provenance audit removed all three: none had established redistribution
// rights. lib/licensing/providers.mjs is what came out of that audit — Tiingo is the ONLY approved
// commercial provider, and FMP, Finnhub, Polygon and Twelve Data are on a frozen deny-list that an
// environment variable cannot undo. The FMP and Finnhub keys in this environment are therefore not
// available for logos: the hosts are refused before a request is made.
//
// Two things were checked before reaching for a new vendor:
//
//   TIINGO     the approved provider. No logo endpoint is documented. Tiingo is a market-data API;
//              logos are not part of it.
//   SEC EDGAR  already an approved host (data.sec.gov), and the submissions JSON carries `website`
//              and `investorWebsite` fields — which would have given us a VERIFIED company domain
//              from a primary source. Measured against the live API for all thirteen verification
//              tickers including AAPL, MSFT and NVDA: both fields are EMPTY for every one of them.
//              0/13. That route is closed.
//
// So a real logo needs a logo vendor. See the report for the comparison; the short version is that
// Logo.dev is the only one whose terms fit this product, because of the next two sections.
//
// ── ⚠️ WHY THE IMAGE IS NOT PROXIED THROUGH /api/logo ────────────────────────
//
// The instruction was to reuse the existing /api/logo infrastructure. We cannot, and the provider
// says so in as many words. Logo.dev's fair-use page lists under NOT fair use:
//
//   "A server that fetches img.logo.dev images and passes them on to your users."
//   "An API that proxies Logo.dev requests."
//   "Load Logo.dev CDN images in your users' browsers and apps. Don't fetch them from a script or
//    a crawler."
//
// So the browser loads img.logo.dev directly. <TickerLogo> is still the ONE shared component every
// surface uses — the single logo system the instruction actually asks for — it simply points its
// <img> at the CDN rather than at our own route. /api/logo keeps its 404 contract and is untouched,
// ready for a self-hosted source if one is ever licensed (Logo.dev permits self-hosting on every
// plan, but only via its API download endpoint, never by scraping the CDN).
//
// ── ⚠️ WHAT WE DO AND DO NOT GET ─────────────────────────────────────────────
//
// Logo.dev is explicit, and this is the honest version to repeat internally:
//
//   "Logo.dev doesn't own the logos and gives you no rights to any logo."
//   "Logos remain the property of their trademark owners."
//   "Use a logo to identify a brand, not to imply endorsement."
//
// Their position is that identifying use is nominative fair use under US trademark law, and they
// say plainly that this is their position and not legal advice. Displaying an issuer's mark beside
// its own filings and its own ticker is squarely identifying use. Nothing here may be used to
// suggest a company endorses Catalyst Pit.
import { normalizeSymbol } from './ticker-symbol.mjs';

/** The vendor this module is written against. Named so a swap is a visible change, not a silent one. */
export const LOGO_PROVIDER = 'logo.dev';

/** The CDN host the browser talks to. Referenced by the licensing sweep and by verification. */
export const LOGO_CDN_HOST = 'img.logo.dev';

// ── ⚠️ WHY THIS IS NOT THE `LOGODEV_TOKEN` THAT ALREADY EXISTS IN VERCEL ────
//
// The original integration (3215b59c, "resolve ticker logos via logo.dev") read `LOGODEV_TOKEN`
// server-side, because /api/logo PROXIED the image: our server fetched img.logo.dev and streamed
// the bytes back. Logo.dev's current fair-use page lists that exact shape under NOT fair use —
// "A server that fetches img.logo.dev images and passes them on to your users" — so the browser
// now loads the CDN directly, and a value the browser needs cannot live in a server-only variable.
//
// NEXT_PUBLIC_ is Next's own marker for "this is inlined into client bundles", so the name states
// the exposure instead of hiding it. That is correct for this value and wrong for almost any
// other: Logo.dev issues a PUBLISHABLE token for image URLs, designed to be visible in a browser,
// and a separate SECRET key (sk_…) for the REST API. The publishable one is the same value the old
// LOGODEV_TOKEN held — it was simply stored under a server-side name because the old architecture
// never needed it client-side. This module must never read the secret key.
const TOKEN = (process.env.NEXT_PUBLIC_LOGODEV_TOKEN || '').trim();

/**
 * ⚠️ ATTRIBUTION IS A LICENCE CONDITION ON THE FREE PLAN, NOT A COURTESY.
 *
 * Logo.dev's attribution page: on the Community (free) plan a COMMERCIAL project must carry a link
 * to logo.dev on the production site, on a page anyone can open without logging in, visible to
 * users — "below a logo grid, in the page footer, or on an about page". Any paid plan removes it.
 * Catalyst Pit is a commercial site, so on the free plan this is required.
 *
 * Default is TRUE — the safe direction. Setting NEXT_PUBLIC_LOGO_DEV_PLAN=paid is an assertion that
 * a paid plan is active; getting that wrong on the free plan is a licence breach, and getting it
 * wrong on a paid plan costs one footer link.
 */
export const LOGO_ATTRIBUTION_REQUIRED =
  (process.env.NEXT_PUBLIC_LOGO_DEV_PLAN || '').trim().toLowerCase() !== 'paid';

/** True only when a token is actually present. No token, no requests, no behaviour change. */
export function logoConfigured() {
  return TOKEN.length > 0;
}

/**
 * ⚠️ SHARE CLASSES RESOLVE TO THE ISSUER, BECAUSE A LOGO IS A COMPANY'S AND NOT A SECURITY'S.
 *
 * BRK.A and BRK.B are one company with one mark. Logo.dev also reads a dotted suffix as a NON-US
 * EXCHANGE (AZN.L is London, 7203.T is Tokyo), so sending "BRK.B" asks it for a security on an
 * exchange called B — a miss at best, and the wrong market at worst.
 *
 * This universe is US-listed, which is what makes stripping a single trailing class letter safe
 * here: there is no London listing in our data for the rule to collide with. A multi-character
 * suffix is left alone, because that is not a class letter.
 *
 * @param {string} symbol
 * @returns {string|null} the issuer-level symbol, or null if it is not a symbol at all
 */
export function logoLookupSymbol(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return null;
  const m = /^([A-Z][A-Z0-9]*)\.[A-Z]$/.exec(sym);
  return m ? m[1] : sym;
}

/**
 * The CDN URL for a ticker's logo, or null when no source is configured.
 *
 * ⚠️ `fallback=404` IS THE WHOLE REASON OUR OWN PLACEHDER STILL WORKS. Without it the CDN answers a
 * miss with a generated first-letter monogram and HTTP 200 — a grey "H" that the browser renders
 * happily and that a reader cannot tell from a real mark. That is precisely the "placeholder
 * pretending to be a logo" this work exists to remove. With it the CDN returns 404, the <img>
 * onError fires, and the clean ticker label renders instead.
 *
 * ⚠️ `format=png` BECAUSE THE DEFAULT IS JPG AND JPG HAS NO ALPHA. A logo on a white chip over a
 * dark card needs its transparency intact.
 *
 * @param {string} symbol
 * @param {{size?: number, retina?: boolean}} [opts]
 * @returns {string|null}
 */
export function tickerLogoUrl(symbol, { size = 64, retina = true } = {}) {
  if (!logoConfigured()) return null;
  const sym = logoLookupSymbol(symbol);
  if (!sym) return null;
  const p = new URLSearchParams({
    token: TOKEN,
    size: String(Math.max(16, Math.min(800, Math.round(size)))),
    format: 'png',
    fallback: '404',
  });
  if (retina) p.set('retina', 'true');
  return `https://${LOGO_CDN_HOST}/ticker/${encodeURIComponent(sym)}?${p.toString()}`;
}

// ── ⚠️ STATE OF ACTIVATION ───────────────────────────────────────────────────
//
//   1. VENDOR DECIDED — Logo.dev, authorised by the owner, who confirmed an existing account with
//      27,385 CDN requests already served. Recorded in lib/licensing/providers.mjs as an approved
//      BROWSER-asset host, which still refuses a server-side fetch. DONE.
//   2. FLAG FLIPPED — `companyLogos` in lib/feature-availability.mjs. DONE.
//   3. TOKEN — THE ONE REMAINING STEP, and it cannot be done from a development machine. Set
//      NEXT_PUBLIC_LOGODEV_TOKEN in Vercel to the PUBLISHABLE token (never the sk_ secret): the
//      same value the existing server-side LOGODEV_TOKEN already holds, under a name the browser
//      can read. See the note on TOKEN above for why a server-only name cannot work now.
//      Optionally NEXT_PUBLIC_LOGO_DEV_PLAN=paid, only if a paid plan is genuinely active.
//   4. THEN VERIFY THE MARKS ARE THE RIGHT COMPANIES — scripts/verify-logo-accuracy.mjs. Its live
//      half cannot run without the token and is the step that must not be skipped: a logo API
//      returning *a* logo is not the same as returning the RIGHT one, and a wrong trademark beside
//      a company's own SEC filings is worse than no logo at all.
//
// Until step 3, every surface renders the clean fallback and makes no request — exactly the
// behaviour shipped at 29580ecf.
