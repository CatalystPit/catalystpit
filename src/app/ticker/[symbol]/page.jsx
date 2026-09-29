import { notFound, permanentRedirect } from 'next/navigation';
import { canonical, SITE_NAME } from '../../../lib/seo';
import { normalizeSymbol, tickerPath } from '../../../lib/ticker-symbol.mjs';
import { tickerTabEnabled } from '../../../lib/feature-availability.mjs';
import { isKnownSymbol } from '../../../lib/ticker-resolve.server.mjs';
import { getTickerSeoBundle } from '../../../lib/ticker-seo.server.mjs';
import { tickerTitle, tickerDescription, tickerStructuredData } from '../../../lib/ticker-seo-meta.mjs';
import TickerPage from './TickerPage';

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
      openGraph: { title: `${sym} · ${SITE_NAME}`, description: `Symbol lookup for ${sym}.`, url, siteName: SITE_NAME, type: 'website' },
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
    openGraph: { title: `${title} · ${SITE_NAME}`, description, url, siteName: SITE_NAME, type: 'website' },
    twitter: { card: 'summary_large_image', title: `${title} · ${SITE_NAME}`, description },
  };
}

export default async function Page({ params, searchParams }) {
  const { symbol } = await params;
  const raw = String(symbol ?? '');
  const sym = normalizeSymbol(raw);

  if (!sym) notFound();

  if (raw !== sym) {
    // 308, not 307: the uppercase form is permanent, and a permanent redirect is what actually
    // removes /ticker/aapl from the index rather than leaving it there beside /ticker/AAPL.
    // Only a real tab survives the hop — tracking parameters are dropped rather than minted into a
    // second permanent URL for the same view.
    // ...and only an AVAILABLE tab: a link to a module that is currently switched off lands on
    // Overview rather than being redirected to an empty panel. tickerPath stays pure URL grammar —
    // whether a tab is live is a product question, answered here. See feature-availability.mjs.
    const sp = (await searchParams) || {};
    const tab = tickerTabEnabled(sp.tab) ? sp.tab : undefined;
    permanentRedirect(tickerPath(sym, tab));
  }

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
