/**
 * WHICH DATA PROVIDERS CATALYST PIT IS LICENSED TO REDISTRIBUTE, AND THE RUNTIME THAT ENFORCES IT.
 *
 * ── ⚠️ WHAT WAS WRONG ────────────────────────────────────────────────────────
 *
 * A provenance audit found four unapproved commercial providers serving production users, three of
 * them live and one reachable through a fallback:
 *
 *   Finnhub   /api/ticker served its quote, its full metrics block (market cap, P/E, EPS, beta,
 *             52-week, average volume), its company profile, a hotlinked logo from Finnhub's own CDN
 *             and its news list — to ANONYMOUS visitors, with a live vendor request per page view.
 *             /api/watchlist fetched Finnhub quotes into the cache /api/ticker reads. The signed-out
 *             homepage tape was priced from Finnhub every five minutes.
 *   Polygon   2,813,069 of 3,322,920 stored daily candles (85%), still growing by ~7,400 rows a
 *             session, read by forty source files — charts, the Screener, breadth, the heatmap,
 *             movers, Fear & Greed, Consensus, Evidence, the congressional leaderboard and the
 *             server-rendered ticker pages. Four nightly crons pulled prices, fundamentals, company
 *             metadata and technicals from it.
 *   FMP       the float denominator behind "short interest % of float" on every ticker page.
 *   CoinGecko the BTC price in the ticker tape.
 *   Twelve    one environment variable away from serving every quote in the product, by way of a
 *             provider-precedence expression that fell through to it when Tiingo was unconfigured.
 *
 * None of that was deliberate. Each arrived as a working integration, and "it works technically" was
 * mistaken for "we may publish this". The audit's own finding is the reason this module exists: the
 * rule lived in comments and in individual call sites, so it could not be enforced and could not be
 * checked.
 *
 * ── ⚠️ THE RULE, IN ONE PLACE ────────────────────────────────────────────────
 *
 * TIINGO IS THE ONLY APPROVED COMMERCIAL MARKET-DATA PROVIDER. Official and public primary sources —
 * SEC/EDGAR, FINRA, Nasdaq Trader, the House Clerk, the Senate eFD, the OCC and the government
 * press sources — are a separate, permitted category.
 *
 * ⚠️ AND AN ENVIRONMENT VARIABLE MUST NOT BE ABLE TO UNDO IT. The Twelve Data exposure was exactly
 * that shape: no code change, no deploy, just a key appearing in an environment. So the allow-list
 * here is a frozen literal and `licensedFetch` consults no configuration at all. Setting
 * POLYGON_API_KEY, FINNHUB_KEY, FMP_API_KEY or TWELVE_DATA_API_KEY in production cannot reactivate
 * any of them: the hosts are refused before a request is made, whatever the environment says.
 *
 * ⚠️ AND FAILURE IS CLOSED. If Tiingo cannot answer and no approved source can, the correct outcome
 * is an absent field. A missing price is a visible, recoverable state that the UI already renders as
 * an em dash; an unlicensed one is a contract breach that nobody can see.
 */

/** The one approved commercial market-data vendor. */
export const APPROVED_COMMERCIAL_PROVIDER = 'tiingo';

/**
 * Hosts we may fetch market or reference data from.
 *
 * ⚠️ DATA HOSTS ONLY. Infrastructure we pay for and do not redistribute — Clerk, Stripe, Upstash,
 * Resend, Ably, Anthropic, Vercel, the social publishing APIs — is not a data-licensing question and
 * is deliberately out of scope here. `isDataHost` below is what draws that line.
 */
export const APPROVED_DATA_HOSTS = Object.freeze([
  // A — the licensed commercial provider.
  'api.tiingo.com',
  // B — official / public primary sources.
  'www.sec.gov', 'data.sec.gov',
  'api.finra.org',
  'www.nasdaqtrader.com',
  'disclosures-clerk.house.gov', 'efdsearch.senate.gov',
  'marketdata.theocc.com',
  'www.federalreserve.gov', 'www.ecb.europa.eu',
  'www.eia.gov', 'www.cftc.gov', 'www.ftc.gov', 'www.fda.gov', 'www.justice.gov',
]);

/**
 * Commercial data vendors we hold no redistribution rights for. Named explicitly, because a
 * deny-list that is merely "everything not approved" cannot produce a useful error message — and
 * because naming them is what lets the verification sweep tell a reintroduction from a new vendor.
 */
export const UNAPPROVED_COMMERCIAL_HOSTS = Object.freeze([
  'api.polygon.io', 'polygon.io',
  'finnhub.io', 'static2.finnhub.io',
  'api.twelvedata.com', 'twelvedata.com',
  'financialmodelingprep.com',
  'api.coingecko.com', 'coingecko.com',
  'api.openfigi.com', 'openfigi.com',
  'www.alphavantage.co', 'alphavantage.co',
  'api.intrinio.com', 'intrinio.com',
  'hist.databento.com', 'databento.com',
  'financialdata.net',
  'api.marketaux.com', 'api.stockdata.org',
  'img.logo.dev', 'logo.dev',
  'stooq.com', 'stooq.pl',
]);

const host = (u) => {
  try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ''; }
};

/** Does this hostname belong to a provider we may not redistribute? */
export function isUnapprovedCommercialHost(urlOrHost) {
  const h = (String(urlOrHost).includes('://') ? host(urlOrHost) : String(urlOrHost)).toLowerCase();
  if (!h) return false;
  return UNAPPROVED_COMMERCIAL_HOSTS.some((bad) => h === bad || h.endsWith(`.${bad}`));
}

/** Is this a host we are cleared to take data from? */
export function isApprovedDataHost(urlOrHost) {
  const h = (String(urlOrHost).includes('://') ? host(urlOrHost) : String(urlOrHost)).toLowerCase();
  if (!h) return false;
  return APPROVED_DATA_HOSTS.some((ok) => h === ok || h.endsWith(`.${ok}`));
}

export class UnlicensedProviderError extends Error {
  constructor(h) {
    super(`unlicensed data provider refused: ${h}. Tiingo is the only approved commercial market-data provider; see src/lib/licensing/providers.mjs`);
    this.name = 'UnlicensedProviderError';
    this.host = h;
  }
}

/**
 * fetch(), with the licensing rule applied before the request leaves the process.
 *
 * ⚠️ THIS REFUSES RATHER THAN DEGRADES, ON PURPOSE. A silent `return null` here would reproduce the
 * original failure mode: an unapproved vendor quietly wired in, working, and invisible. A throw is
 * loud at the one moment somebody could still choose differently — and every caller in this codebase
 * already treats a thrown data fetch as an absent field rather than a crash.
 */
export async function licensedFetch(url, init) {
  const h = host(url);
  if (isUnapprovedCommercialHost(h) || !isApprovedDataHost(h)) throw new UnlicensedProviderError(h || String(url));
  return fetch(url, init);
}

/**
 * Candle sources whose rows may be SERVED to a user.
 *
 * ⚠️ THE STORED TABLE IS MIXED, AND THE SOURCE COLUMN WAS NEVER A LICENCE GATE. `source` on
 * ticker_daily_candles was introduced as a CONVENTION discriminator — which split-adjusted basis a
 * row was built on — so 'polygon' sat in it as a perfectly canonical value and forty readers took it
 * without a second thought. Reading is now filtered on this list, so a Polygon row stays on disk,
 * stays auditable, and stops reaching anybody while it is being replaced.
 */
export const LICENSED_CANDLE_SOURCES = Object.freeze(['tiingo_split_adj']);

/** Candle sources that exist in storage but may not be served. */
export const UNLICENSED_CANDLE_SOURCES = Object.freeze(['polygon']);

/**
 * The same list as a SQL array LITERAL, for raw query templates.
 *
 * ⚠️ BECAUSE BINDING AN ARRAY PARAMETER SILENTLY BREAKS ON THIS DRIVER, and it broke in production. A
 * raw `source = any(${LICENSED_CANDLE_SOURCES})` renders through drizzle's neon-http driver as
 * `any(($2))`, which Postgres rejects — so the query threw, the caller's catch turned it into null, and
 * /api/ticker served a metrics block of nothing while reporting success. Measured on the live site: the
 * whole 52-week and average-volume section came back empty with no error anywhere.
 *
 * A literal built from this frozen, code-owned list is safe — there is no user input anywhere near it —
 * and it works identically in every query shape. Where a drizzle column object is in hand, `inArray()`
 * is better still and renders scalar parameters correctly; this is for raw templates.
 */
export const LICENSED_CANDLE_SOURCES_SQL =
  `ARRAY[${LICENSED_CANDLE_SOURCES.map((s) => `'${s}'`).join(',')}]::text[]`;

/** The licensed dividend source, used to scope the public calendar. */
export const LICENSED_DIVIDEND_SOURCES = Object.freeze(['tiingo']);

/**
 * Provenance values on screener_meta whose rows may be SERVED.
 *
 * ⚠️ AND NULL IS NOT ON THIS LIST, WHICH IS THE WHOLE DESIGN. 15,944 rows predate the audit and record
 * no origin at all; every one of them was Polygon. Rather than stamp them with a provenance nobody
 * verified — fake provenance being exactly what makes the next audit impossible — they keep a NULL
 * source, and NULL reads as UNKNOWN, and unknown is not servable. A row becomes servable by being
 * rewritten by a pipeline that knows where its values came from.
 */
export const LICENSED_META_SOURCES = Object.freeze(['sec+tiingo']);

/**
 * Is this stored reference row cleared for display?
 *
 * Takes the raw column value, so a caller cannot forget the null case: `servableMetaSource(row.source)`
 * is false for null, for '', for 'polygon' and for anything added later that nobody has approved.
 */
export const servableMetaSource = (s) => !!s && LICENSED_META_SOURCES.includes(String(s));
