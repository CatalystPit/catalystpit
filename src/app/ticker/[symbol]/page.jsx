import { notFound, permanentRedirect } from 'next/navigation';
import { canonical, SITE_NAME, OG_IMAGE } from '../../../lib/seo';
import { normalizeSymbol, tickerPath } from '../../../lib/ticker-symbol.mjs';
import { isKnownSymbol } from '../../../lib/ticker-resolve.server.mjs';
import { getTickerSeoBundle } from '../../../lib/ticker-seo.server.mjs';
import { tickerTitle, tickerDescription, tickerStructuredData } from '../../../lib/ticker-seo-meta.mjs';
import TickerPage from './TickerPage';

// ── ⚠️ THIS ROUTE SERVED private, no-store ON EVERY ONE OF ~19,750 URLs ─────
//
// Measured on production at 41668bf7, as Googlebot:
//
//   /insiders      200  Cache-Control: public, max-age=0, must-revalidate   x-vercel-cache: HIT
//   /ticker/AAPL   200  Cache-Control: private, no-cache, no-store, ...     x-vercel-cache: MISS
//   /ticker/AAPL   200  (immediate repeat)                                  x-vercel-cache: MISS
//
// Every crawl of every ticker page reached the origin and rendered from scratch, and the response
// told every intermediary not to store it. A 60-URL spread across our own sitemap measured
// p50 673ms / p90 1,356ms / max 2,387ms against 210ms for the prerendered homepage. With ~19,750
// ticker URLs advertised in sitemap.xml, that is the whole crawl budget spent on origin renders.
//
// ⚠️ A headers() ENTRY IN next.config DOES NOT FIX IT — tried and measured on 2026-11-24. For a
// route Next renders dynamically, the framework's own Cache-Control is applied after config headers
// and wins. The cause is not a missing header; it is that the route was DYNAMIC.
//
// `revalidate` is what makes it cacheable, and the reason it is safe here is that NOTHING on this
// page is per-viewer. The server renders identity only — company name, exchange, sector, the
// JSON-LD — all of it from getTickerSeoBundle, which is itself already an unstable_cache with a
// six-hour window, and all of it identical for every visitor. Prices, entitlements, the watchlist
// star, alerts and the chart are the client component's work and stay the client component's work.
// This is the same argument that made the homepage shareable: see src/app/page.jsx.
//
// ⚠️ ONE HOUR, NOT FIVE MINUTES, and the number is not arbitrary. The server HTML here cannot
// change faster than the bundle it is built from, and that bundle holds for six hours. An hour is
// a deliberately conservative fraction of it.
//
// ⚠️ THE CASING REDIRECT STAYS IN THIS FILE AND STAYS DYNAMIC, WHICH IS THE POINT. Page() awaits
// searchParams only on the `raw !== sym` branch, so a request for the canonical uppercase URL never
// touches a dynamic API and can be cached, while a lowercase request bails to a dynamic render and
// is answered per-request. That matters for correctness, not just speed: the ISR cache is keyed by
// PATH, so a cached 308 would have to send /ticker/aapl?tab=news and /ticker/aapl?tab=insiders to
// the same place. verify-ticker-cache.mjs measures both, because the reasoning is only as good as
// the measurement.
export const revalidate = 3600;

// ⚠️ AN EMPTY LIST, AND DELETING IT PUTS THE ROUTE BACK ON private, no-store.
//
// `revalidate` alone did nothing. Measured: with revalidate set and searchParams already removed,
// .next/prerender-manifest.json listed NO dynamicRoutes at all, the build printed the route as
// `ƒ (Dynamic)`, and `next start` answered `private, no-cache, no-store` on a second identical
// request. A dynamic segment only joins the incremental cache once generateStaticParams EXISTS —
// it is what declares that params not produced at build time should be generated on demand and
// then kept (dynamicParams defaults to true). With it, the same build prints `●`, the manifest
// carries /ticker/[symbol], and the second request answers
// `s-maxage=3600, stale-while-revalidate=...` with `x-nextjs-cache: HIT`.
//
// ⚠️ AND IT RETURNS NOTHING ON PURPOSE. Returning the symbol list would prerender ~19,750 pages
// at build time: six DISTINCTs over the largest tables we have, then a render each, on every
// deploy — knownSymbols() alone was measured at 4.4s and the sitemap caches it for a day for that
// reason. Nothing is gained by it either, because every one of those pages is cached on its first
// request anyway. Build cost stays flat at 141 pages; the cache fills from real traffic.
export async function generateStaticParams() { return []; }

// URL AND INDEXING GATE for /ticker/[symbol]. Everything the user sees is still TickerPage, which is
// untouched — this wrapper decides only what URL the content lives at and what we tell a crawler
// about it.
//
// Three outcomes, in order:
//   malformed segment        → notFound(), a real HTTP 404 on the branded page
//   valid but not uppercase  → 308 to the uppercase URL, tab preserved
//   canonical uppercase      → render, with an explicit self-canonical and a robots directive that
//                              depends on whether we can actually demonstrate the security exists
//
// It deliberately does NOT 404 a symbol merely because we hold no data for it. screener_stocks
// covers 15,968 symbols and only 5,701 carry a company name; keying a hard 404 to it would kill real
// tickers. Unresolved symbols keep every bit of their existing behaviour and are simply not
// advertised to search engines as verified securities.

const SYMBOL_NOT_FOUND = {
  title: 'Symbol not found',
  description: 'That symbol could not be found on CatalystPit.',
  robots: { index: false, follow: true },
};

export async function generateMetadata({ params }) {
  const { symbol } = await params;
  const raw = String(symbol ?? '');
  const sym = normalizeSymbol(raw);

  // Nothing readable as a symbol. Previously this branch produced a confident, fully-formed
  // "<junk> · Stock Price, News, Insider & Congress Trades" title for any string at all, which is
  // how an arbitrary URL came to look like a security to a crawler.
  if (!sym) return SYMBOL_NOT_FOUND;

  // About to be answered with a 308, so the document is never indexed and the verification probe
  // would be pure waste. Left noindex so nothing can settle on the non-canonical casing.
  if (raw !== sym) return { title: sym, robots: { index: false, follow: true } };

  const url = canonical(`/ticker/${sym}`);
  const known = await isKnownSymbol(sym);

  // A SELF-CANONICAL, which this route has never had. The root layout sets alternates.canonical:'/',
  // and metadata is inherited — so until now every ticker page told Google it was the homepage.
  // Setting it here also collapses ?tab=, ?ref= and any other query string onto the one bare URL.
  //
  // The title loses its own "· CatalystPit" suffix: the root layout's title template already
  // appends the brand, so the live tag read "... · CatalystPit · CatalystPit".
  const base = { alternates: { canonical: url } };

  if (!known) {
    // Syntactically valid, but we cannot demonstrate it is a security. Say nothing about it — no
    // company, no exchange, no price, no claim of coverage — and keep it out of the index while
    // leaving the page fully usable and its links crawlable.
    return {
      ...base,
      title: sym,
      description: `Symbol lookup for ${sym} on ${SITE_NAME}.`,
      robots: { index: false, follow: true },
      openGraph: { title: `${sym} · ${SITE_NAME}`, description: `Symbol lookup for ${sym}.`, url, siteName: SITE_NAME, type: 'website', images: [OG_IMAGE] },
    };
  }

  // Verified: we hold first-party data for this symbol.
  //
  // ⚠️ THE SAME BUNDLE THE PAGE RENDERS FROM. getTickerSeoBundle is cached per symbol, so asking for
  // it here and again in Page() below is one database read, not two — and, more to the point, the
  // title, the description and the visible heading are three views of ONE object. They cannot name
  // different companies, which is a property rather than a thing to keep in sync.
  //
  // Vendor-free by construction: the bundle contains no fetch at all, so a crawl of thousands of
  // ticker URLs cannot become a metered bill or a provider outage.
  const bundle = await getTickerSeoBundle(sym);
  const view = bundle?.public || null;

  // Falls back to the symbol-only wording when we cannot name the security — a page that says less
  // is better than one that says something it cannot support.
  const title = tickerTitle(view) || `${sym} · Stock Price, News, Insider & Congress Trades`;
  const description = tickerDescription(view)
    || `${sym} stock quote, key stats, market news, insider trades, and congressional trades, all on one page.`;
  return {
    ...base,
    title,
    description,
    openGraph: { title: `${title} · ${SITE_NAME}`, description, url, siteName: SITE_NAME, type: 'website', images: [OG_IMAGE] },
    twitter: { card: 'summary_large_image', title: `${title} · ${SITE_NAME}`, description, images: [OG_IMAGE.url] },
  };
}

export default async function Page({ params }) {
  const { symbol } = await params;
  const raw = String(symbol ?? '');
  const sym = normalizeSymbol(raw);

  if (!sym) notFound();

  // ⚠️ A BACKSTOP, NOT THE PATH THIS NORMALLY TAKES. The casing redirect — and the tab-preserving
  // half of it — now answers in middleware, because reading `searchParams` here is the one thing
  // that made all ~19,750 ticker URLs uncacheable. See lib/ticker-url-redirect.mjs and the
  // `revalidate` note above.
  //
  // ⚠️ IT IS STILL HERE BECAUSE THE MATCHER CAN MISS. middleware's matcher excludes any path whose
  // last segment ends in a static-file extension, so a lowercase request for a symbol that happens
  // to end in one — /ticker/x.css is well-formed under our grammar — never reaches it. Without this
  // branch such a URL would RENDER at a non-canonical path, which is the duplicate-content case the
  // 308 exists to prevent. It drops the tab rather than reading searchParams to keep it: landing on
  // Overview is a far smaller cost than making every ticker page dynamic again, and no internal link
  // can produce this case — tickerPath emits uppercase.
  if (raw !== sym) permanentRedirect(tickerPath(sym));

  // ⚠️ ONLY `.public` CROSSES THE BOUNDARY. The bundle's other half, `.eligibility`, describes OUR
  // coverage — which datasets we hold, how many, whether the listing venue is one we verify — and
  // anything handed to a client component is serialized into the RSC payload and crawled. It stays
  // here. verify-ticker-seo-bundle.mjs searches the serialized public view recursively for every
  // field that must never reach markup.
  const bundle = await getTickerSeoBundle(sym);
  const view = bundle?.public || null;

  // Structured data only where there is a fact to state and a type that is true — a named common
  // stock. See tickerStructuredData: no rating, no price, no offer, and nothing at all for an ETF,
  // a unit or a warrant, because Corporation would be a false claim about what the security is.
  const ld = tickerStructuredData(view, canonical(`/ticker/${sym}`));

  return (
    <>
      {ld ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      ) : null}
      <TickerPage symbol={sym} ssr={view} />
    </>
  );
}
